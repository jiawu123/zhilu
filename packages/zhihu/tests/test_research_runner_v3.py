"""V3 orchestration contracts; all calls are offline injected boundaries."""
import copy
from dataclasses import replace

import pytest

from zhihu_m2 import research_runner as rr, evidence_compiler as ec
from zhihu_m2.retrieval_options import RetrievalOptions
from zhihu_m2.plan_retrieval import SearchError
from zhihu_m2 import llm_client
from test_research_runner import payload, raw, response, compile_ok


def run(dep, *, data=None, metrics=None, limit=8):
    return rr.run_research(data or payload(), dependencies=dep,
        options=RetrievalOptions('v3'), limits=rr.ResearchLimits(max_compiler_calls=limit), metrics=metrics)


def no_evidence(result, **kw):
    return ec.validate_evidence_response({'status': 'no_evidence', 'reason': 'No method in this excerpt.',
        'evidence_cards': []}, result, retrieved_at=kw['retrieved_at'])


def test_only_requested_queries_original_ranks_and_later_variant(monkeypatch):
    from zhihu_m2 import query_planner
    monkeypatch.setattr(query_planner, 'plan_research', lambda *a, **k: pytest.fail('Planner called'))
    calls, inputs, pool_seen, success_seen = [], [], [], []
    timestamps = iter(['2026-09-12T01:00:00+00:00', '2026-09-12T01:01:00+00:00'])
    original = '😀给工具传入固定样例。\r\n把实际参数与事先写好的期望值逐项比较。'
    def search(query, **kw):
        calls.append((query, kw['count']))
        return response(raw(snippet='这是一篇工具介绍。')) if len(calls) == 1 else response(None, raw(snippet=original))
    def rank(pool, context, successful):
        from zhihu_m2.ranker_v3 import rank_candidates
        pool_seen.extend(copy.deepcopy(pool))
        success_seen.append(set(successful))
        ranked = rank_candidates(pool, context, successful)
        # Ensure orchestration compiles the selected original, not a mutated rank copy.
        for source in pool:
            for item in source.occurrences:
                item.result.content_text = 'MUTATED private rank copy'
        return [replace(item, representative_index=1) for item in ranked]
    dep = rr.ResearchDependencies(search=search, rank_v3=rank, now=lambda: next(timestamps),
        rank=lambda *a, **k: pytest.fail('legacy rank called'),
        compile=lambda result, **kw: (inputs.append((copy.deepcopy(result), kw)) or compile_ok(result, **kw)))
    metrics = {}
    data = run(dep, metrics=metrics)
    assert calls == [('agent tests', 5), ('python tests', 5)]
    assert data['requestId'] == '../external-id'
    assert len(inputs) == 1
    assert inputs[0][0].content_text == original
    assert inputs[0][1]['retrieved_at'] == '2026-09-12T01:01:00+00:00'
    assert inputs[0][1]['retrieval_profile'] == 'v3'
    assert [o.result_rank for o in pool_seen[0].occurrences] == [1, 2]
    assert success_seen == [{0, 1}]
    assert metrics == dict(search_calls_attempted=2, compiler_calls_attempted=1,
        candidate_count=1, evidence_count=1, raw_item_count=3, valid_occurrence_count=2, variant_count=2)
    assert data['status'] == 'partial'  # invalid raw item is still recorded
    assert len(dep.trace) == 2
    assert 'snippet' not in str(dep.diagnostics) and original not in str(dep.diagnostics)
    assert dep.diagnostics


def test_accepted_set_only_changes_when_unique_card_is_accepted():
    seen, compiled = [], []
    def select(ranked, pool, attempted, accepted):
        from zhihu_m2.ranker_v3 import select_next_source
        seen.append((set(attempted), set(accepted)))
        # Attempted/accepted passed to injected functions must be defensive.
        choice = select_next_source(ranked, pool, attempted, accepted)
        attempted.add('injected'); accepted.add('injected')
        return choice
    def compiler(result, **kw):
        compiled.append(result.content_id)
        if len(compiled) == 1:
            return no_evidence(result, **kw)
        if len(compiled) == 2:
            raise llm_client.LLMError('Compiler failed credential-canary')
        return compile_ok(result, **kw)
    dep = rr.ResearchDependencies(search=lambda *a, **kw: response(*(raw(i) for i in range(1, 5))),
        compile=compiler, select_v3=select)
    data = run(dep)
    assert len(compiled) == 4 and len(set(compiled)) == 4
    assert seen[0] == (set(), set())
    assert len(seen[1][0]) == 1 and not seen[1][1]
    assert len(seen[2][0]) == 2 and not seen[2][1]
    assert len(seen[3][0]) == 3 and len(seen[3][1]) == 1
    assert data['status'] == 'partial'
    assert len(data['compilerOutputs']) == 3
    assert data['compilerOutputs'][0]['status'] == 'no_evidence'


@pytest.mark.parametrize('kind,expected', [('empty', 'no_evidence'), ('no_evidence', 'no_evidence'),
    ('partial', 'partial'), ('all_search_failed', 'research_failed'), ('all_compile_failed', 'compilation_failed')])
def test_distinct_execution_states(kind, expected):
    calls = []
    def search(query, **kw):
        calls.append(query)
        if kind == 'all_search_failed' or kind == 'partial' and len(calls) == 1:
            raise SearchError('network_error')
        return response() if kind == 'empty' else response(raw())
    def compiler(result, **kw):
        if kind == 'all_compile_failed':
            raise llm_client.LLMError('credential-canary')
        return no_evidence(result, **kw) if kind == 'no_evidence' else compile_ok(result, **kw)
    dep = rr.ResearchDependencies(search=search, compile=compiler)
    if expected.endswith('_failed'):
        with pytest.raises(rr.ResearchError, match='^' + expected + '$'):
            run(dep)
    else:
        assert run(dep)['status'] == expected


def test_budget_dedup_and_card_upper_bound():
    dep = rr.ResearchDependencies(search=lambda *a, **kw: response(*(raw(i) for i in range(1, 6))), compile=compile_ok)
    counts = {}
    data = run(dep, metrics=counts, limit=1)
    assert data['status'] == 'partial'
    assert counts['compiler_calls_attempted'] == counts['evidence_count'] == 1
    assert counts['candidate_count'] == 5 and counts['valid_occurrence_count'] == 10
    assert counts['variant_count'] == 5
    counts = {}
    data = run(dep, metrics=counts)
    assert counts['compiler_calls_attempted'] == counts['evidence_count'] == 2
    assert data['status'] == 'ok'


@pytest.mark.parametrize('bad', ['missing', 'duplicate', 'foreign', 'bool_index', 'range_index',
    'nan', 'negative', 'components', 'bool_component'])
def test_invalid_rank_output_fails_before_compiler(bad):
    def rank(pool, context, successful):
        from zhihu_m2.ranker_v3 import rank_candidates
        ranked = rank_candidates(pool, context, successful)
        item = ranked[0]
        if bad == 'missing': return []
        if bad == 'duplicate': return ranked + ranked
        if bad == 'foreign': return [replace(item, source_id='foreign')]
        if bad == 'bool_index': return [replace(item, representative_index=True)]
        if bad == 'range_index': return [replace(item, representative_index=999)]
        if bad == 'nan': return [replace(item, priority=float('nan'))]
        if bad == 'negative': return [replace(item, priority=-1)]
        if bad == 'components': return [replace(item, components={})]
        return [replace(item, components={**item.components, 'rrf': True})]
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw()), rank_v3=rank,
        compile=lambda *a, **k: pytest.fail('compile called'))
    with pytest.raises(rr.ResearchError, match='^execution_error$'):
        run(dep)


@pytest.mark.parametrize('bad', ['none', 'foreign', 'changed', 'repeated'])
def test_invalid_selection_is_rejected(bad):
    def select(ranked, pool, attempted, accepted):
        item = ranked[0]
        if bad == 'none': return None
        if bad == 'foreign': return replace(item, source_id='foreign')
        if bad == 'changed': return replace(item, priority=0.999999)
        return item
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw(1), raw(2)), select_v3=select,
        compile=no_evidence)
    with pytest.raises(rr.ResearchError, match='^execution_error$'):
        run(dep)


def test_profile_invalid_before_io_and_explicit_option_overrides_env(monkeypatch):
    monkeypatch.setenv('ZHIHU_RETRIEVAL_PROFILE', 'credential-canary')
    dep = rr.ResearchDependencies(search=lambda *a, **kw: response())
    with pytest.raises(rr.ResearchError, match='^configuration_error$'):
        rr.run_research(payload(), dependencies=dep)
    assert run(dep)['status'] == 'no_evidence'


def test_profile_is_not_an_http_payload_field():
    data = payload(); data['request']['retrievalProfile'] = 'v3'
    with pytest.raises(rr.ResearchError, match='invalid_request'):
        run(rr.ResearchDependencies(), data=data)


def test_successful_empty_query_is_retained_for_rrf_denominator():
    observed = []
    def rank(pool, context, successful):
        from zhihu_m2.ranker_v3 import rank_candidates
        observed.append(set(successful))
        return rank_candidates(pool, context, successful)
    dep = rr.ResearchDependencies(search=lambda query, **kw: response() if query == 'agent tests' else response(raw()),
        rank_v3=rank, compile=compile_ok)
    run(dep)
    assert observed == [{0, 1}]


@pytest.mark.parametrize('bad', [None, float('nan'), True])
def test_invalid_variant_metadata_does_not_discard_valid_source(bad):
    from zhihu_m2.normalizer import normalize_result
    def normalize(item):
        result = normalize_result(item)
        if result.content_id == '1': result.ranking_score = bad
        return result
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw(1), raw(2)),
                                  normalize=normalize, compile=compile_ok)
    counts = {}
    data = run(dep, metrics=counts)
    assert data['status'] == 'partial'
    assert counts['candidate_count'] == counts['variant_count'] == counts['evidence_count'] == 1
    assert counts['valid_occurrence_count'] == 2


def test_timeout_after_selection_prevents_compiler_attempt():
    clock = [0]
    def select(ranked, pool, attempted, accepted):
        clock[0] = 700
        return ranked[0]
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw()), select_v3=select,
        monotonic=lambda: clock[0], compile=lambda *a, **k: pytest.fail('compiler after deadline'))
    counts = {}
    with pytest.raises(rr.ResearchError, match='^research_timeout$'):
        run(dep, metrics=counts)
    assert counts['compiler_calls_attempted'] == 0


@pytest.mark.parametrize('field,bad', [('author_badge_text', '\ud800'), ('authority_level', float('nan'))])
def test_invalid_full_variant_hash_is_isolated_before_pool(field, bad):
    from zhihu_m2.normalizer import normalize_result
    def normalize(item):
        result = normalize_result(item)
        if result.content_id == '1': setattr(result, field, bad)
        return result
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw(1), raw(2)),
        normalize=normalize, compile=compile_ok)
    counts = {}
    data = run(dep, metrics=counts)
    assert data['status'] == 'partial'
    assert counts['candidate_count'] == counts['variant_count'] == counts['evidence_count'] == 1
    assert counts['valid_occurrence_count'] == 2
