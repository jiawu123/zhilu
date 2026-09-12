import json
from pathlib import Path

import pytest

from zhihu_m2.retrieval_live_evaluation import LiveLedger, collect_cases, replay_case, audited_model_call
from zhihu_m2.research_runner import ResearchError
from zhihu_m2.plan_retrieval import SearchError
from test_research_runner import payload, raw, response


def case():
    return {'case_id': 'case-1', 'synthetic': False, 'split': 'development', **payload()}


def test_ledger_reserves_before_io_and_never_resets_budget(tmp_path):
    ledger = LiveLedger(tmp_path)
    for i in range(24):
        ledger.reserve('search', {'case_id': str(i)})
    with pytest.raises(ResearchError, match='configuration_error'):
        LiveLedger(tmp_path).reserve('search', {})
    assert len(json.loads((tmp_path / 'ledger.json').read_text())['attempts']) == 24
    with pytest.raises(ResearchError):
        ledger.reserve('invalid', {})


def test_capture_preserves_rank_snippet_and_failed_queries(tmp_path):
    calls = []
    def search(query, **kw):
        calls.append((query, kw))
        if len(calls) == 2: raise SearchError('network_error')
        return response(None, raw(snippet='😀原文\r\n保持不变'))
    data = collect_cases({'cases': [case()]}, LiveLedger(tmp_path), search=search)
    captured = data['cases'][0]
    assert len(calls) == 2 and all(kw['count'] == 5 for _, kw in calls)
    assert captured['successful_query_indexes'] == [0]
    assert captured['observations'][0]['result_rank'] == 2
    assert captured['observations'][0]['result']['content_text'] == '😀原文\r\n保持不变'
    assert captured['grades'] is None and captured['human_label_status'] == 'needs_human_review'
    assert captured['capture_status'] == 'partial'
    assert 'network_error' in str(captured['engineering_metrics'])
    assert replay_case(captured, 0)['Data']['Items'][0] is None
    with pytest.raises(SearchError): replay_case(captured, 1)


def test_capture_stops_entire_batch_on_authentication_without_retry(tmp_path):
    calls = []
    def search(*args, **kwargs):
        calls.append(1); raise SearchError('authentication')
    data = collect_cases({'cases': [case(), {**case(), 'case_id': 'case-2'}]}, LiveLedger(tmp_path), search=search)
    assert len(calls) == 1
    assert data['batch_status'] == 'authentication_failed'
    assert data['cases'][1]['capture_status'] == 'not_collected'


def test_audit_hash_is_actual_transport_messages_without_headers(monkeypatch):
    import httpx
    from zhihu_m2 import query_planner
    monkeypatch.setenv('DEEPSEEK_API_KEY', 'test-private-key')
    def post(self, url, **kw):
        raise httpx.ConnectError('secret-raw-error')
    monkeypatch.setattr(httpx.Client, 'post', post)
    result = audited_model_call(None, operation='planner', profile='v3',
        arguments={'goal': '学习回归测试', 'user_context': {}})
    assert result['ok'] is False
    assert result['audit']['http_calls_attempted'] == 1
    assert len(result['audit']['prompt_sha256']) == 64
    assert 'test-private-key' not in json.dumps(result)
    assert 'secret-raw-error' not in json.dumps(result)


def test_capture_refuses_duplicate_case_or_more_than_two_queries_before_io(tmp_path):
    bad = case(); bad['request']['searchQueries'].append('third query')
    for task in ({'cases': [case(), case()]}, {'cases': [bad]}):
        with pytest.raises(ResearchError, match='invalid_request'):
            collect_cases(task, LiveLedger(tmp_path), search=lambda *a, **k: pytest.fail('I/O'))


@pytest.mark.parametrize('field,value', [('RankingScore', None), ('RankingScore', '1'), ('VoteUpCount', None), ('CommentCount', True), ('EditTime', float('inf'))])
def test_capture_excludes_bad_numeric_metadata_and_preserves_raw_count(tmp_path, field, value):
    bad = raw(); bad[field] = value
    captured = collect_cases({'cases': [case()]}, LiveLedger(tmp_path), search=lambda *a, **k: response(raw(2), bad))
    c = captured['cases'][0]
    assert len(c['observations']) == 2
    assert c['query_outcomes'][0]['raw_item_count'] == 2
    assert len(replay_case(c, 0)['Data']['Items']) == 2
    assert replay_case(c, 0)['Data']['Items'][-1] is None
    assert captured['batch_status'] == 'partial'


def test_replay_preserves_original_typed_failure(tmp_path):
    def search(*a, **k):
        raise SearchError('timeout')
    result = collect_cases({'cases': [case()]}, LiveLedger(tmp_path), search=search)
    with pytest.raises(SearchError) as caught:
        replay_case(result['cases'][0], 0)
    assert caught.value.kind == 'timeout'
    assert result['batch_status'] == 'failed'


def test_older_snapshot_uses_saved_error_code_without_rewriting_it():
    old = {'successful_query_indexes': [], 'observations': [],
           'engineering_metrics': {'errors': [{'query_index': 0, 'code': 'search_timeout'}]}}
    with pytest.raises(SearchError) as caught:
        replay_case(old, 0)
    assert caught.value.kind == 'timeout'
    assert 'query_outcomes' not in old
