import copy
import json

import pytest

from zhihu_m2 import research_runner as rr
from zhihu_m2.retrieval_options import RetrievalOptions, options_from_env
from zhihu_m2.normalizer import ZhihuResult
from test_research_runner import payload, raw, response, compile_ok


def batch_ok(candidates, **kwargs):
    outputs = [compile_ok(ZhihuResult(**c['result']), retrieved_at=c['retrieved_at']) for c in candidates]
    return {'compilerOutputs': outputs, 'assessments': [
        {'candidateIndex': i, 'sourceId': o['source']['id'], 'relevance': 'strongly',
         'applicability': 'applicable', 'support': 'direct', 'freshness': 'uncertain'}
        for i, o in enumerate(outputs)], 'issues': [], 'researchCandidates': []}


def dep(search=None, batch=batch_ok):
    return rr.ResearchDependencies(search=search or (lambda *a, **k: response(raw())),
        batch_compile=batch, rank=lambda *a, **k: pytest.fail('weighted rank called'),
        rank_v3=lambda *a, **k: pytest.fail('weighted v3 called'),
        compile=lambda *a, **k: pytest.fail('per-source model called'),
        now=lambda: '2026-09-12T12:00:00+00:00')


def run(p=None, **kwargs):
    return rr.run_research(p or payload(), options=RetrievalOptions('batch-v1'), **kwargs)


def test_production_default_batch():
    assert options_from_env({}).profile == 'batch-v1'


def test_batch_preserves_variants_uses_only_requested_queries_and_no_planner(monkeypatch):
    from zhihu_m2 import query_planner
    monkeypatch.setattr(query_planner, 'plan_research', lambda *a, **k: pytest.fail('planner'))
    calls, batches = [], []
    def search(query, **kw):
        calls.append(query)
        return response(raw(snippet='😀 First query.\r\nExact original evidence.' if len(calls) == 1 else 'Different second query original evidence.'))
    def batch(candidates, **kw):
        batches.append(copy.deepcopy(candidates))
        return batch_ok(candidates, **kw)
    metrics = {}
    result = run(dependencies=dep(search, batch), metrics=metrics)
    assert calls == payload()['request']['searchQueries']
    assert len(batches) == 1 and len(batches[0]) == 2
    assert batches[0][0]['result']['content_text'] == '😀 First query.\r\nExact original evidence.'
    assert result['requestId'] == '../external-id'
    assert metrics['compiler_calls_attempted'] == 0
    assert metrics['batch_model_calls_attempted'] == 1
    assert metrics['model_calls_attempted'] == 1
    assert result['coverage']['reviewStatus'] == 'needs_human_review'
    assert result['coverage']['status'] == 'insufficient'


def test_batch_no_evidence_partial_and_failure():
    empty = run(dependencies=dep(lambda *a, **k: response()))
    assert empty['status'] == 'no_evidence'
    assert empty['compilerOutputs'] == []
    partial = run(dependencies=dep(lambda query, **kw: response(raw()) if query == 'agent tests' else {}))
    assert partial['status'] == 'partial' and partial['issues'][0]['stage'] == 'search'
    with pytest.raises(rr.ResearchError, match='research_failed'):
        run(dependencies=dep(lambda *a, **k: {}))
    def failed(*a, **kw):
        raise RuntimeError('Authorization private-secret')
    with pytest.raises(rr.ResearchError, match='^compilation_failed$'):
        run(dependencies=dep(batch=failed))


def test_batch_limit_bool_and_no_hidden_search():
    p = payload(); p['request']['evidenceLimit'] = True
    with pytest.raises(rr.ResearchError, match='invalid_request'):
        run(p, dependencies=dep(lambda *a, **k: pytest.fail('network')))
    p = payload(); p['request']['evidenceLimit'] = 1
    result = run(p, dependencies=dep(lambda *a, **k: response(raw(1), raw(2), raw(3))))
    assert sum(len(o['evidence_cards']) for o in result['compilerOutputs']) == 1


def test_batch_live_cache_rebases_only_id_and_saves_calls(tmp_path):
    from zhihu_m2.evidence_cache import EvidenceCache
    cache = EvidenceCache(tmp_path)
    first_metrics, hit_metrics = {}, {}
    first = run(dependencies=dep(), metrics=first_metrics, cache=cache)
    p = payload(); p['request']['id'] = 'controller-second-request'
    second = run(p, dependencies=dep(lambda *a, **k: pytest.fail('cache searched')), metrics=hit_metrics, cache=cache)
    assert second == {**first, 'requestId': p['request']['id']}
    assert hit_metrics['cache_hit'] == 1
    assert hit_metrics['search_calls_attempted'] == hit_metrics['model_calls_attempted'] == 0
    assert hit_metrics['saved_search_calls'] == 2 and hit_metrics['saved_model_calls'] == 1


def test_cache_only_miss_never_searches(monkeypatch, tmp_path):
    from zhihu_m2.evidence_cache import EvidenceCache
    monkeypatch.setenv('ZHIHU_EVIDENCE_CACHE_ONLY', 'true')
    with pytest.raises(rr.ResearchError, match='configuration_error'):
        run(dependencies=dep(lambda *a, **k: pytest.fail('paid search')), cache=EvidenceCache(tmp_path))


def test_old_cache_without_coverage_is_a_miss(tmp_path):
    from zhihu_m2.evidence_cache import EvidenceCache
    cache = EvidenceCache(tmp_path)
    original = run(dependencies=dep())
    del original['coverage']
    assert cache.put(payload(), original, {})
    metrics = {}
    result = run(dependencies=dep(), metrics=metrics, cache=cache)
    assert result['coverage']['reviewStatus'] == 'needs_human_review'
    assert metrics['cache_hit'] == 0 and metrics['search_calls_attempted'] == 2


def test_large_originals_use_bounded_batch_without_truncating_snippets():
    from zhihu_m2 import evidence_compiler as ec
    def batch(candidates, **kw):
        assert len(json.dumps(candidates, ensure_ascii=False).encode('utf-8')) <= 192 * 1024
        assert all(c['result']['content_text'] == '原' * 20000 for c in candidates)
        outputs = [ec.validate_evidence_response({'status': 'no_evidence', 'reason': '没有具体依据', 'evidence_cards': []},
                   ZhihuResult(**c['result']), retrieved_at=c['retrieved_at']) for c in candidates]
        return {'compilerOutputs': outputs, 'assessments': [{} for _ in outputs], 'issues': [], 'researchCandidates': []}
    result = run(dependencies=dep(lambda *a, **k: response(*(raw(i, '原' * 20000) for i in range(10))), batch))
    assert result['status'] == 'partial'
    assert {'code': 'candidate_batch_truncated', 'stage': 'coverage'} in result['issues']
