"""Offline integration tests: real ranker/compiler, fake external providers."""
import copy
import importlib
import json
from datetime import datetime

import httpx
import pytest

from zhihu_m2 import evidence_compiler, llm_client, live_research_demo as demo, zhihu_client

QUOTE = "第一步调用 LLM API，第二步实现工具调用，然后加入测试和日志。"
RAW = {
    'Title': 'Agent Engineer 学习路线',
    'ContentType': 'Answer', 'ContentID': 'live-123',
    'AuthorName': '测试作者', 'AuthorSignature': 'test-author',
    'ContentText': QUOTE,
    'Url': 'https://www.zhihu.com/question/1/answer/2?utm_source=test',
    'VoteUpCount': 6, 'CommentCount': 0, 'EditTime': 0,
}

def read_report(run_dir):
    return json.loads((run_dir / 'run_report.json').read_text(encoding='utf-8'))

@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError('Offline test attempted real network or CLI call')
    monkeypatch.setattr(httpx.Client, 'send', forbidden)
    monkeypatch.setattr(zhihu_client.subprocess, 'run', forbidden)
    monkeypatch.delenv('DEEPSEEK_API_KEY', raising=False)

@pytest.fixture
def providers(monkeypatch):
    state = {'raw': [copy.deepcopy(RAW)], 'search_calls': [], 'model_calls': [],
             'payload': None, 'search_error': None, 'model_error': None}
    def search(query, count=5):
        state['search_calls'].append((query, count))
        if state['search_error'] is not None:
            raise state['search_error']
        return state['raw']
    def model(system_prompt, user_prompt, *, max_tokens):
        data = json.loads(user_prompt)
        state['model_calls'].append(data)
        if state['model_error'] is not None:
            raise state['model_error']
        if state['payload'] is not None:
            return copy.deepcopy(state['payload'])
        return {
            'status': 'ok', 'reason': '材料提出了一个项目实践顺序。',
            'evidence_cards': [{
                'source_id': data['source']['source_id'],
                'supporting_quote': QUOTE,
                'claim': '作者建议先调用模型，再实现工具调用并加入测试和日志。',
                'claim_type': 'advice',
                'applies_when': '对于有 Python 基础的初学者可能适用。',
                'caveats': ['仅是一位作者提出的建议，不是通用标准。'],
            }],
        }
    monkeypatch.setattr(zhihu_client, 'search_zhihu', search)
    monkeypatch.setattr(llm_client, 'generate_json', model)
    return state

def test_live_path_binds_raw_source_quote_timestamp_and_query(tmp_path, providers):
    run_dir = demo.run_live_demo(output_root=tmp_path)
    report = read_report(run_dir)
    snapshot = json.loads((run_dir / 'search_snapshot.json').read_text(encoding='utf-8'))
    output = json.loads((run_dir / 'evidence.json').read_text(encoding='utf-8'))
    card = output['evidence_cards'][0]
    assert providers['search_calls'] == [('Agent Engineer 学习路线', 5)]
    assert len(providers['model_calls']) == 1
    assert report['status'] == 'ok'
    assert report['retrieved_count'] == 1
    assert report['candidate_policy'] == 'first_ranked_for_smoke_test_only'
    assert report['ranked_candidates'][0]['source_id'] == 'zhihu:Answer:live-123'
    assert card['source_id'] == 'zhihu:Answer:live-123'
    assert card['source_url'] == RAW['Url']
    assert card['verification_status'] == 'unverified'
    assert card['source_scope'] == 'search_snippet'
    assert output['source']['snippet'][card['quote_start']:card['quote_end']] == QUOTE
    assert output['source']['retrievedAt'] == snapshot['retrieved_at']
    assert datetime.fromisoformat(snapshot['retrieved_at']).utcoffset().total_seconds() == 0
    assert snapshot['raw_results'] == providers['raw']
    assert snapshot['user_context']['is_demo'] is True
    assert snapshot['research_question'] == providers['model_calls'][0]['research_question']

def test_highest_ranked_candidate_selected_not_original_first(tmp_path, providers):
    generic = copy.deepcopy(RAW)
    generic.update(ContentID='generic', Title='AI 发展趋势', ContentText='人工智能值得关注。')
    providers['raw'].insert(0, generic)
    run_dir = demo.run_live_demo(output_root=tmp_path)
    assert read_report(run_dir)['retrieved_count'] == 2
    assert providers['model_calls'][0]['source']['source_id'] == 'zhihu:Answer:live-123'

def test_ranker_cleaning_never_replaces_snippet_sent_to_model(tmp_path, providers):
    providers['raw'][0]['ContentText'] += '\n加老师免费领取内部资源包。'
    before = copy.deepcopy(providers['raw'])
    demo.run_live_demo(output_root=tmp_path)
    assert providers['model_calls'][0]['source']['snippet'] == before[0]['ContentText']
    assert providers['raw'] == before

def test_snapshot_is_saved_before_paid_model_call(tmp_path, providers, monkeypatch):
    real_compile = evidence_compiler.compile_evidence
    def checked_compile(*args, **kwargs):
        snapshots = list(tmp_path.glob('live_*/search_snapshot.json'))
        assert len(snapshots) == 1
        assert json.loads(snapshots[0].read_text(encoding='utf-8'))['raw_results'] == providers['raw']
        return real_compile(*args, **kwargs)
    monkeypatch.setattr(evidence_compiler, 'compile_evidence', checked_compile)
    demo.run_live_demo(output_root=tmp_path)

def test_empty_search_makes_no_model_request(tmp_path, providers):
    providers['raw'] = []
    run_dir = demo.run_live_demo(output_root=tmp_path)
    assert read_report(run_dir)['status'] == 'no_results'
    assert providers['model_calls'] == []
    assert not (run_dir / 'evidence.json').exists()
    assert (run_dir / 'search_snapshot.json').exists()

def test_model_no_evidence_is_not_an_error_or_retried(tmp_path, providers):
    providers['raw'].append(copy.deepcopy(RAW))
    providers['payload'] = {'status': 'no_evidence', 'reason': '材料未回答研究问题。', 'evidence_cards': []}
    run_dir = demo.run_live_demo(output_root=tmp_path)
    assert read_report(run_dir)['status'] == 'no_evidence'
    out = json.loads((run_dir / 'evidence.json').read_text(encoding='utf-8'))
    assert out['reason'] == '材料未回答研究问题。'
    assert out['evidence_cards'] == []
    assert len(providers['model_calls']) == 1

@pytest.mark.parametrize('error', [
    llm_client.LLMError('transport failure; PRIVATE_TEXT'),
    evidence_compiler.EvidenceValidationError('bad quote; PRIVATE_TEXT'),
])
def test_compiler_failure_preserves_snapshot_and_records_safe_error(tmp_path, providers, error):
    providers['model_error'] = error
    with pytest.raises(demo.LiveDemoError) as caught:
        demo.run_live_demo(output_root=tmp_path)
    run_dir = next(tmp_path.iterdir())
    report = read_report(run_dir)
    assert report['status'] == 'error'
    assert report['stage'] == 'compile'
    assert report['error_type'] == type(error).__name__
    assert (run_dir / 'search_snapshot.json').exists()
    assert not (run_dir / 'evidence.json').exists()
    assert len(providers['model_calls']) == 1
    assert 'PRIVATE_TEXT' not in str(caught.value)
    assert 'PRIVATE_TEXT' not in (run_dir / 'run_report.json').read_text(encoding='utf-8')

def test_invalid_quote_still_rejected_by_real_validator(tmp_path, providers):
    providers['raw'][0]['ContentText'] = '这是一些不含测试引文的摘要，只用于检查引用校验不会被联调代码绕过。'
    with pytest.raises(demo.LiveDemoError):
        demo.run_live_demo(output_root=tmp_path)
    report = read_report(next(tmp_path.iterdir()))
    assert report['error_type'] == 'EvidenceValidationError'
    assert report['status'] == 'error'

def test_search_failure_does_not_look_like_empty_search(tmp_path, providers):
    providers['search_error'] = RuntimeError('PRIVATE_SEARCH_ERROR')
    with pytest.raises(demo.LiveDemoError):
        demo.run_live_demo(output_root=tmp_path)
    run_dir = next(tmp_path.iterdir())
    assert read_report(run_dir)['stage'] == 'search'
    assert read_report(run_dir)['status'] == 'error'
    assert not (run_dir / 'search_snapshot.json').exists()
    assert providers['model_calls'] == []
    assert len(providers['search_calls']) == 1

def test_bad_normalizer_input_stops_before_model_keeps_snapshot(tmp_path, providers):
    providers['raw'] = [None]
    with pytest.raises(demo.LiveDemoError):
        demo.run_live_demo(output_root=tmp_path)
    run_dir = next(tmp_path.iterdir())
    assert read_report(run_dir)['stage'] == 'normalize'
    assert (run_dir / 'search_snapshot.json').exists()
    assert providers['model_calls'] == []

def test_invalid_source_stops_before_paid_call(tmp_path, providers):
    providers['raw'][0]['Url'] = 'https://example.com/not-zhihu'
    with pytest.raises(demo.LiveDemoError):
        demo.run_live_demo(output_root=tmp_path)
    assert providers['model_calls'] == []
    assert read_report(next(tmp_path.iterdir()))['stage'] == 'compile'

def test_all_candidates_retained_in_snapshot_no_top_score_threshold(tmp_path, providers):
    low = copy.deepcopy(RAW)
    low.update(ContentID='low', Title='简短建议', ContentText='实践有一定帮助。')
    providers['raw'].append(low)
    run_dir = demo.run_live_demo(output_root=tmp_path)
    report = read_report(run_dir)
    assert len(report['ranked_candidates']) == 2
    assert {item['source_id'] for item in report['ranked_candidates']} == {'zhihu:Answer:live-123', 'zhihu:Answer:low'}
    assert len(providers['model_calls']) == 1

def test_new_run_does_not_overwrite_previous_files(tmp_path, providers):
    first = demo.run_live_demo(output_root=tmp_path)
    original = (first / 'evidence.json').read_bytes()
    second = demo.run_live_demo(output_root=tmp_path)
    assert first != second
    assert (first / 'evidence.json').read_bytes() == original
    assert (second / 'evidence.json').exists()

def test_import_makes_no_api_requests(providers):
    importlib.reload(demo)
    assert providers['search_calls'] == []
    assert providers['model_calls'] == []
