"""Insufficient posts remain original references, never accepted evidence."""
import copy

import pytest

from zhihu_m2 import evidence_compiler as ec, research_runner as rr
from zhihu_m2.evidence_cache import EvidenceCache
from zhihu_m2.normalizer import ZhihuResult
from zhihu_m2.retrieval_options import RetrievalOptions
from test_research_runner import payload, raw, response, dependencies
from test_research_runner_batch import batch_ok, dep, run


REQUIRED_RISKS = {'证据不足', 'search_snippet_only', 'not_independently_verified',
                  'semantic_support_not_checked'}


def no_evidence(original, **kwargs):
    return ec.validate_evidence_response({'status': 'no_evidence', 'reason': '没有对应问题的依据。',
        'evidence_cards': []}, original, retrieved_at=kwargs['retrieved_at'])


def batch_empty(candidates, **kwargs):
    outputs = [no_evidence(ZhihuResult(**c['result']), retrieved_at=c['retrieved_at']) for c in candidates]
    return {'compilerOutputs': outputs, 'assessments': [{} for _ in outputs],
            'issues': [], 'researchCandidates': []}


def test_zero_accepted_cards_preserve_distinct_original_query_snippets_without_extra_calls(monkeypatch):
    from zhihu_m2 import query_planner
    monkeypatch.setattr(query_planner, 'plan_research', lambda *a, **k: pytest.fail('planner'))
    snippets = ['😀第一段原文。\r\n没有研究所需依据。', '同一帖子另一个 Query 的原始片段。']
    calls = []
    def search(query, **kwargs):
        calls.append(query)
        return response(raw(snippet=snippets[len(calls) - 1]), raw(snippet=snippets[len(calls) - 1]))
    metrics = {}
    result = run(dependencies=dep(search, batch_empty), metrics=metrics)
    assert result['status'] == 'no_evidence' and result['coverage']['evidenceCount'] == 0
    assert calls == payload()['request']['searchQueries']
    assert metrics['model_calls_attempted'] == 1
    posts = result['insufficientSources']
    assert len(posts) == 2
    assert [post['source']['snippet'] for post in posts] == snippets
    assert all(post['source']['retrievedAt'] == '2026-09-12T12:00:00+00:00' for post in posts)
    assert all(post['reasonCode'] == 'no_evidence' and REQUIRED_RISKS <= set(post['riskTags']) for post in posts)
    assert all(not output['evidence_cards'] for output in result['compilerOutputs'])


def test_rejected_and_valid_unselected_posts_do_not_become_evidence_or_leak_model_text():
    def batch(candidates, **kwargs):
        result = batch_ok(candidates, **kwargs)
        result['compilerOutputs'][1]['evidence_cards'][0]['risk_flags'].append('needs_context_review')
        result['compilerOutputs'].pop()
        result['assessments'].pop()
        result['issues'] = [{'code': 'batch_item_invalid', 'candidateIndex': 2}]
        return result
    p = payload(); p['request']['evidenceLimit'] = 1
    result = run(p, dependencies=dep(lambda *a, **k: response(raw(1), raw(2), raw(3)), batch))
    assert result['status'] == 'partial' and result['coverage']['evidenceCount'] == 1
    posts = result['insufficientSources']
    assert [(p['source']['id'], p['reasonCode']) for p in posts] == [
        ('zhihu:answer:2', 'not_selected'), ('zhihu:answer:3', 'compiler_rejected')]
    assert 'needs_context_review' in posts[0]['riskTags']
    assert all(set(post) == {'source', 'reasonCode', 'riskTags'} for post in posts)
    assert all('claim' not in post and 'supporting_quote' not in post for post in posts)


def test_insufficient_source_batch_is_bounded_to_24_whole_originals():
    p = payload(); p['request']['searchQueries'] = ['first query', 'second query', 'third query']
    calls = []
    def search(*args, **kwargs):
        start = len(calls) * 10; calls.append(start)
        return response(*(raw(start + i, '🍞\r\n这是未经裁剪的完整原始帖子。') for i in range(10)))
    result = run(p, dependencies=dep(search, batch_empty))
    assert len(result['insufficientSources']) == 24
    assert all(p['source']['snippet'] == '🍞\r\n这是未经裁剪的完整原始帖子。' for p in result['insufficientSources'])
    assert result['status'] == 'partial'


@pytest.mark.parametrize('profile', ['legacy', 'v3'])
def test_legacy_and_v3_also_preserve_no_evidence_posts(profile):
    result = rr.run_research(payload(), options=RetrievalOptions(profile),
        dependencies=dependencies(compile=no_evidence))
    assert result['status'] == 'no_evidence'
    assert len(result['insufficientSources']) == 1
    assert result['insufficientSources'][0]['reasonCode'] == 'no_evidence'


def test_cache_retains_new_posts_and_derives_old_no_evidence_sources_without_rewriting(tmp_path):
    cache = EvidenceCache(tmp_path)
    original = run(dependencies=dep(batch=batch_empty), cache=cache)
    hit = run(dependencies=dep(lambda *a, **k: pytest.fail('search')), cache=cache)
    assert hit['insufficientSources'] == original['insufficientSources']
    old = copy.deepcopy(original)
    del old['insufficientSources']
    assert cache.put(payload(), old, {})
    path = next(tmp_path.glob('*.json'))
    saved = path.read_bytes()
    migrated = run(dependencies=dep(lambda *a, **k: pytest.fail('search')), cache=cache)
    assert migrated['insufficientSources'] == original['insufficientSources']
    assert path.read_bytes() == saved


@pytest.mark.parametrize('mutate', [
    lambda posts: posts[0]['source'].update(url='https://user:secret@zhihu.com/'),
    lambda posts: posts[0]['source'].update(retrievedAt='not-a-date'),
    lambda posts: posts[0].update(reasonCode='verified'),
    lambda posts: posts[0].update(riskTags=[]),
    lambda posts: posts[0].update(claim='model rejected credential-canary'),
    lambda posts: posts.extend(copy.deepcopy(posts) * 24),
])
def test_cache_rejects_unsafe_or_mislabelled_source_references(tmp_path, mutate):
    result = run(dependencies=dep(batch=batch_empty))
    mutate(result['insufficientSources'])
    cache = EvidenceCache(tmp_path)
    assert not cache.put(payload(), result, {})
    assert cache.last_status == 'invalid'


def test_real_batch_all_rejected_still_fails_instead_of_successful_empty_sources():
    from zhihu_m2.batch_screening import validate_batch_response
    def batch(candidates, **kwargs):
        return validate_batch_response({'items': []}, candidates, **kwargs)
    with pytest.raises(rr.ResearchError, match='^compilation_failed$'):
        run(dependencies=dep(batch=batch))
