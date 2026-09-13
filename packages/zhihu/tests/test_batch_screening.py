"""Offline batch classification uses the existing provenance/quote validator."""
import copy
import importlib
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from dataclasses import asdict

import pytest

from zhihu_m2 import llm_client
from zhihu_m2.models import ZhihuResult


def test_batch_screening_is_available():
    assert importlib.util.find_spec('zhihu_m2.batch_screening') is not None


def candidate(index=0, *, text=None, author=None, source_id=None):
    source_id = str(index) if source_id is None else str(source_id)
    result = ZhihuResult(
        title=f'原始标题 {index}', content_type='Answer', content_id=source_id,
        author_name=f'作者{index}' if author is None else author,
        author_signature='', author_badge_text='',
        content_text=text or f'作者建议第{index}次练习时记录结果，再比较实际变化。',
        url=f'https://www.zhihu.com/question/1/answer/{source_id}',
        vote_up_count=0, comment_count=0, authority_level='', ranking_score=0.0,
        edit_time=0,
    )
    return {'result': asdict(result), 'retrieved_at': '2026-09-12T10:00:00+00:00'}


def item(index, value, *, caveats=None, **labels):
    result = value['result']
    return {
        'candidate_index': index,
        'relevance': labels.get('relevance', 'strongly'),
        'applicability': labels.get('applicability', 'applicable'),
        'support': labels.get('support', 'direct'),
        'freshness': labels.get('freshness', 'uncertain'),
        'compilation': {
            'status': 'ok', 'reason': '这条引文描述了可检查的练习方法。',
            'evidence_cards': [{
                'source_id': f"zhihu:Answer:{result['content_id']}",
                'supporting_quote': result['content_text'],
                'claim': f'作者建议记录第{index}次练习结果。',
                'claim_type': 'advice', 'applies_when': '适用于有条件记录结果的练习者。',
                'caveats': caveats or [],
            }],
        },
    }


@pytest.fixture
def model(monkeypatch):
    state = {'calls': [], 'payload': None}
    def generate(**kwargs):
        state['calls'].append(kwargs)
        return copy.deepcopy(state['payload'])
    monkeypatch.setattr(llm_client, 'generate_json', generate)
    return state


def run(candidates, **kwargs):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    return batch.compile_batch(candidates, goal='改善练习效果。', user_context={},
                               research_question='如何检查练习效果？', **kwargs)


@pytest.mark.parametrize('goal,question', [
    ('完成有基本测试的程序', '如何检验程序输出？'),
    ('提升钢琴练习效果', '如何记录节奏练习的变化？'),
])
def test_one_batch_call_for_coding_and_noncoding_goals(model, goal, question):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate(i) for i in range(8)]
    model['payload'] = {'items': [item(i, value) for i, value in enumerate(candidates)]}
    output = batch.compile_batch(candidates, goal=goal, user_context={},
                                 research_question=question)
    assert len(model['calls']) == 1
    assert len(output['compilerOutputs']) == 8
    prompt = json.loads(model['calls'][0]['user_prompt'])
    assert prompt['goal'] == goal
    assert prompt['research_question'] == question
    assert len(prompt['candidates']) == 8
    assert output['issues'] == []
    assert output['researchCandidates'] == []


def test_variants_remain_separate_exact_crlf_emoji_and_timestamps(model):
    candidates = [candidate(0, text='😀前言\r\n每天记录节奏练习结果，再逐项比较。'),
                  candidate(1, source_id=0, text='另一条摘要：放慢速度后再检查是否稳定。')]
    candidates[1]['retrieved_at'] = '2026-09-12T11:00:00+00:00'
    model['payload'] = {'items': [item(i, value) for i, value in enumerate(candidates)]}
    model['payload']['items'][0]['compilation']['evidence_cards'][0]['supporting_quote'] = \
        '每天记录节奏练习结果，再逐项比较。'
    before = copy.deepcopy(candidates)
    output = run(candidates)
    assert candidates == before
    outputs = output['compilerOutputs']
    for index, compiled in enumerate(outputs):
        assert compiled['source']['snippet'] == candidates[index]['result']['content_text']
        assert compiled['source']['retrievedAt'] == candidates[index]['retrieved_at']
        card = compiled['evidence_cards'][0]
        assert card['verification_status'] == 'unverified'
        assert card['risk_flags'] == ['search_snippet_only', 'not_independently_verified',
                                      'semantic_support_not_checked']
    assert outputs[0]['evidence_cards'][0]['quote_start'] == 5
    prompt = json.loads(model['calls'][0]['user_prompt'])
    assert [v['source']['snippet'] for v in prompt['candidates']] == \
        [v['result']['content_text'] for v in candidates]


@pytest.mark.parametrize('label,value', [('relevance', 'unrelated'),
                                        ('applicability', 'inapplicable'),
                                        ('support', 'none')])
def test_excluded_labels_require_explicit_no_evidence(model, label, value):
    candidates = [candidate()]
    proposed = item(0, candidates[0], **{label: value})
    proposed['compilation'] = {'status': 'no_evidence', 'reason': '原始片段不能回答问题。',
                               'evidence_cards': []}
    model['payload'] = {'items': [proposed]}
    output = run(candidates)
    assert output['compilerOutputs'][0]['reason'] == '原始片段不能回答问题。'
    assert output['compilerOutputs'][0]['status'] == 'no_evidence'
    assert output['issues'] == []


def test_invalid_quote_is_partial_when_other_evidence_is_valid(model):
    candidates = [candidate(i) for i in range(2)]
    proposed = [item(i, value) for i, value in enumerate(candidates)]
    proposed[1]['compilation']['evidence_cards'][0]['supporting_quote'] = '凭空拼出的不存在的片段。'
    model['payload'] = {'items': proposed}
    output = run(candidates)
    assert len(output['compilerOutputs']) == 1
    assert output['issues'] == [{'code': 'batch_item_invalid', 'candidateIndex': 1}]


def test_hypothesis_citing_rejected_quote_drops_whole_group_and_keeps_valid_cards(model):
    values = [candidate(i) for i in range(3)]
    proposed = [item(i, value) for i, value in enumerate(values)]
    proposed[1]['compilation']['evidence_cards'][0]['supporting_quote'] = '不存在于原文的引用。'
    groups = [{
        'title': '共同假设', 'summary': '依赖两张卡共同成立，不能删掉引用后保留。',
        'applicableWhen': ['条件已知时'], 'candidateIndices': [0, 1], 'risks': [],
    }, {
        'title': '独立假设', 'summary': '第三张卡独立支持。',
        'applicableWhen': ['条件适用时'], 'candidateIndices': [2], 'risks': [],
    }]
    model['payload'] = {'items': proposed, 'researchCandidates': groups}
    before = copy.deepcopy(model['payload'])
    output = run(values)
    assert [value['source']['id'] for value in output['compilerOutputs']] == [
        'zhihu:Answer:0', 'zhihu:Answer:2']
    assert len(output['researchCandidates']) == 1
    assert output['researchCandidates'][0]['title'] == '独立假设'
    assert output['researchCandidates'][0]['evidenceIds'] == [
        output['compilerOutputs'][1]['evidence_cards'][0]['id']]
    assert output['issues'] == [
        {'code': 'batch_item_invalid', 'candidateIndex': 1},
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0},
    ]
    assert model['payload'] == before


@pytest.mark.parametrize('groups', [None, {}, 'invalid', [None] * 9])
def test_invalid_hypothesis_collection_preserves_valid_evidence(model, groups):
    values = [candidate()]
    model['payload'] = {'items': [item(0, values[0])], 'researchCandidates': groups}
    diagnostics = []
    output = run(values, diagnostics=diagnostics)
    assert len(output['compilerOutputs'][0]['evidence_cards']) == 1
    assert output['researchCandidates'] == []
    assert output['issues'] == [{'code': 'batch_research_candidate_invalid'}]
    rejected = next(event for event in diagnostics if event['batch_debug'] == 'research_candidates_invalid')
    if isinstance(groups, list):
        assert rejected['invalid_group_count'] == 9
    else:
        assert 'invalid_group_count' not in rejected


def test_two_card_item_and_no_evidence_citations_preserve_eight_independent_cards(model, monkeypatch, capsys):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate(i) for i in range(10)]
    proposed = [item(i, value) for i, value in enumerate(values)]
    proposed[5]['compilation'] = {'status': 'no_evidence', 'reason': '缺少所需依据。',
                                'evidence_cards': []}
    extra_card = copy.deepcopy(proposed[6]['compilation']['evidence_cards'][0])
    extra_card['claim'] = '另一条主张仍然不能绕过单卡契约。'
    proposed[6]['compilation']['evidence_cards'].append(extra_card)
    model['payload'] = {'items': proposed, 'researchCandidates': [{
        'title': f'假设{index}', 'summary': '需要完整的所引证据才能成立。',
        'applicableWhen': ['条件已知'], 'candidateIndices': indices, 'risks': [],
    } for index, indices in enumerate([[0, 2, 3, 4, 6, 7], [1, 5, 9], [6, 7]])]}
    monkeypatch.setenv('ZHIHU_BATCH_DEBUG', '1')
    diagnostics = []
    full = run(values, diagnostics=diagnostics)
    invalid_item = next(entry for entry in diagnostics if entry['batch_debug'] == 'item_invalid')
    assert invalid_item['candidate_index'] == 6
    assert invalid_item['card_count'] == 2
    stderr_events = [json.loads(line) for line in capsys.readouterr().err.splitlines()]
    assert invalid_item in stderr_events
    assert len(full['compilerOutputs']) == 9
    assert sum(len(value['evidence_cards']) for value in full['compilerOutputs']) == 8
    assert full['researchCandidates'] == []
    assert full['issues'] == [
        {'code': 'batch_item_invalid', 'candidateIndex': 6},
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0},
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 1},
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 2},
    ]
    selected = batch.select_evidence(full, evidence_limit=5)
    assert sum(len(value['evidence_cards']) for value in selected['compilerOutputs']) == 5
    assert selected['researchCandidates'] == []
    assert all(value['source']['id'] != 'zhihu:Answer:6' for value in selected['compilerOutputs'])
    for compiled in selected['compilerOutputs']:
        for card in compiled['evidence_cards']:
            assert compiled['source']['snippet'][card['quote_start']:card['quote_end']] == card['supporting_quote']


def test_all_invalid_items_fail_without_raw_exception(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate()]
    proposed = item(0, candidates[0])
    proposed['compilation']['evidence_cards'][0]['supporting_quote'] = 'SECRET_RAW_ERROR_MATERIAL'
    model['payload'] = {'items': [proposed]}
    with pytest.raises(batch.BatchValidationError) as caught:
        run(candidates)
    assert 'SECRET_RAW_ERROR_MATERIAL' not in str(caught.value)
    assert len(model['calls']) == 1


@pytest.mark.parametrize('field,value', [('candidate_index', True), ('candidate_index', -1),
                                      ('candidate_index', 99), ('relevance', 'certain'),
                                      ('applicability', 1), ('support', 'verified'),
                                      ('freshness', 'fresh'), ('extra', 'secret')])
def test_strict_model_item_validation(model, field, value):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate()]
    proposed = item(0, candidates[0])
    proposed[field] = value
    model['payload'] = {'items': [proposed]}
    with pytest.raises(batch.BatchValidationError):
        run(candidates)


def test_missing_item_is_partial_and_duplicate_is_not_accepted_twice(model):
    candidates = [candidate(i) for i in range(3)]
    model['payload'] = {'items': [item(0, candidates[0]), item(0, candidates[0]),
                                 item(1, candidates[1])]}
    output = run(candidates)
    assert len(output['compilerOutputs']) == 1
    assert output['assessments'][0]['candidateIndex'] == 1
    assert {issue['code'] for issue in output['issues']} == \
        {'batch_item_invalid', 'batch_item_missing'}


@pytest.mark.parametrize('size', [0, 25])
def test_input_batch_bound_before_model(model, size):
    with pytest.raises(ValueError):
        run([candidate(i) for i in range(size)])
    assert model['calls'] == []


def test_model_error_is_not_retried_or_converted_to_empty(monkeypatch):
    calls = []
    def fail(**kwargs):
        calls.append(1)
        raise llm_client.LLMError('DeepSeek HTTP 429. Check key, account balance, or service status.')
    monkeypatch.setattr(llm_client, 'generate_json', fail)
    with pytest.raises(llm_client.LLMError):
        run([candidate()])
    assert calls == [1]


def test_select_caps_sources_authors_and_prioritizes_limits(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate(i, author='same' if i < 7 else '') for i in range(12)]
    candidates[1] = candidate(1, source_id=0, author='same')
    candidates[2] = candidate(2, source_id=0, author='same', text='换一个原始片段，说明先记录再检查。')
    proposed = [item(i, value, caveats=['练习疲劳时应减少强度。'] if i == 11 else [])
                for i, value in enumerate(candidates)]
    model['payload'] = {'items': proposed}
    full = run(candidates)
    before = copy.deepcopy(full)
    selected = batch.select_evidence(full, evidence_limit=12)
    assert full == before
    outputs = selected['compilerOutputs']
    assert len(outputs) == 8
    assert outputs[0]['evidence_cards'][0]['caveats']
    assert sum(value['source']['author'] == 'same' for value in outputs) <= 3
    assert sum(value['source']['id'] == 'zhihu:Answer:0' for value in outputs) <= 2


def test_available_partial_limitation_survives_many_strong_supporting_cards(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate(i) for i in range(9)]
    proposed = [item(i, value) for i, value in enumerate(candidates)]
    proposed[-1] = item(8, candidates[-1], relevance='partially',
                        caveats=['该方法以能够重复练习为前提，无法重复时不适用。'])
    model['payload'] = {'items': proposed}
    selected = batch.select_evidence(run(candidates), evidence_limit=8)
    assert any(output['evidence_cards'][0]['caveats'] for output in selected['compilerOutputs'])


def test_same_source_cap_cannot_be_bypassed_by_url_variants(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate(i, source_id=0, author='') for i in range(4)]
    for index, value in enumerate(values):
        value['result']['url'] += f'?variant={index}'
    model['payload'] = {'items': [item(i, value) for i, value in enumerate(values)]}
    selected = batch.select_evidence(run(values), evidence_limit=8)
    assert len(selected['compilerOutputs']) == 2


def test_author_cap_uses_canonical_identity_without_rewriting_metadata(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    names = ['Straße', 'STRASSE', ' Straße ', 'strasse']
    values = [candidate(i, author=author) for i, author in enumerate(names)]
    model['payload'] = {'items': [item(i, value) for i, value in enumerate(values)]}
    selected = batch.select_evidence(run(values), evidence_limit=8)
    assert len(selected['compilerOutputs']) == 3
    assert [value['source']['author'] for value in selected['compilerOutputs']] == names[:3]


@pytest.mark.parametrize('conflicting_field', ['reason', 'source'])
def test_duplicate_evidence_id_with_changed_output_fails_closed(model, conflicting_field):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate(), candidate()]
    proposed = [item(0, values[0]), item(0, values[1])]
    proposed[1]['candidate_index'] = 1
    if conflicting_field == 'reason':
        proposed[1]['compilation']['reason'] = '不同的解释。'
    else:
        values[1]['retrieved_at'] = '2026-09-12T12:00:00+00:00'
    model['payload'] = {'items': proposed}
    with pytest.raises(batch.BatchValidationError):
        run(values)


def test_excluded_label_with_claim_is_execution_failure_not_success_empty(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate()]
    model['payload'] = {'items': [item(0, values[0], relevance='unrelated')]}
    with pytest.raises(batch.BatchValidationError):
        run(values)


def test_hypothesis_cannot_cite_valid_no_evidence(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate()]
    proposed = item(0, values[0])
    proposed['compilation'] = {'status': 'no_evidence', 'reason': '缺少直接依据。',
                               'evidence_cards': []}
    model['payload'] = {'items': [proposed], 'researchCandidates': [{
        'title': '无依据的路线', 'summary': '不应接受。', 'applicableWhen': [],
        'candidateIndices': [0], 'risks': [],
    }]}
    output = run(values)
    assert output['compilerOutputs'][0]['status'] == 'no_evidence'
    assert output['researchCandidates'] == []
    assert output['issues'] == [
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0}]


def test_oversize_prompt_is_rejected_before_model_and_never_truncates_snippet(model):
    values = [candidate(i, text='原始片段' * 6000) for i in range(24)]
    with pytest.raises(ValueError):
        run(values)
    assert model['calls'] == []


@pytest.mark.parametrize('limit', [True, False, 0, -1, 13, 2.5])
def test_selection_limit_rejects_nonintegers_or_out_of_range(limit):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    with pytest.raises(ValueError):
        batch.select_evidence({'compilerOutputs': [], 'assessments': [], 'issues': [],
                               'researchCandidates': []}, evidence_limit=limit)


def test_hypotheses_reference_validated_cards_and_removed_citations_drop_group(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate(i) for i in range(3)]
    model['payload'] = {'items': [item(i, value) for i, value in enumerate(candidates)],
                        'researchCandidates': [{
                            'title': '记录再比较', 'summary': '作者提出记录练习结果后比较变化。',
                            'applicableWhen': ['能够重复相同练习时'],
                            'candidateIndices': [0, 1], 'risks': ['摘要不足以验证真实效果。'],
                        }]}
    full = run(candidates)
    group = full['researchCandidates'][0]
    assert group['evidenceIds'] == [value['evidence_cards'][0]['id']
                                    for value in full['compilerOutputs'][:2]]
    assert 'model_inferred_needs_human_review' in group['risks']
    assert group['id'].startswith('research_')
    assert full['researchCandidates'] == run(candidates)['researchCandidates']
    assert batch.select_evidence(full, evidence_limit=1)['researchCandidates'] == []


@pytest.mark.parametrize('indices', [[True], [999], [], [0, 0]])
def test_malformed_hypothesis_is_rejected_without_discarding_evidence(model, indices):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    candidates = [candidate()]
    model['payload'] = {'items': [item(0, candidates[0])], 'researchCandidates': [{
        'title': '某方法', 'summary': '作者建议进行练习。', 'applicableWhen': ['某条件'],
        'candidateIndices': indices, 'risks': [],
    }]}
    output = run(candidates)
    assert len(output['compilerOutputs'][0]['evidence_cards']) == 1
    assert output['researchCandidates'] == []
    assert output['issues'] == [
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0}]


def test_hypothesis_requires_explicit_applicability_for_shared_boundary(model):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    values = [candidate()]
    model['payload'] = {'items': [item(0, values[0])], 'researchCandidates': [{
        'title': '某方法', 'summary': '作者建议记录结果。', 'applicableWhen': [],
        'candidateIndices': [0], 'risks': [],
    }]}
    output = run(values)
    assert len(output['compilerOutputs'][0]['evidence_cards']) == 1
    assert output['researchCandidates'] == []
    assert output['issues'] == [
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0}]


def test_diagnostics_never_include_untrusted_model_keys_labels_or_indices(model, monkeypatch, capsys):
    monkeypatch.setenv('ZHIHU_BATCH_DEBUG', '1')
    marker = 'SYNTHETIC_PRIVATE_MODEL_TEXT'
    values = [candidate(i) for i in range(2)]
    invalid = item(1, values[1], relevance=marker)
    invalid[marker] = marker
    model['payload'] = {'items': [item(0, values[0]), invalid], 'researchCandidates': [{
        'title': marker, 'summary': marker, 'applicableWhen': [marker],
        'candidateIndices': [marker], 'risks': [], marker: marker,
    }]}
    diagnostics = []
    output = run(values, diagnostics=diagnostics)
    assert len(output['compilerOutputs']) == 1
    assert {entry['batch_debug'] for entry in diagnostics} >= {
        'model_returned', 'item_invalid', 'items_validated', 'research_candidate_invalid'}
    assert marker not in json.dumps(diagnostics)
    assert marker not in capsys.readouterr().err


def test_diagnostics_are_available_without_stderr_opt_in(model, monkeypatch, capsys):
    monkeypatch.delenv('ZHIHU_BATCH_DEBUG', raising=False)
    values = [candidate()]
    model['payload'] = {'items': [item(0, values[0])]}
    diagnostics = []
    run(values, diagnostics=diagnostics)
    assert [entry['batch_debug'] for entry in diagnostics] == ['model_returned', 'items_validated']
    assert capsys.readouterr().err == ''


def test_diagnostic_sanitizer_rejects_unknown_text_and_boolean_counts():
    batch = importlib.import_module('zhihu_m2.batch_screening')
    value = [None, {'batch_debug': 'PRIVATE_TEXT'}, {
        'batch_debug': 'item_invalid', 'candidate_index': True,
        'proposed_field_count': 7, 'exception_type': 'PRIVATE_TEXT',
        'labels': {'relevance': 'PRIVATE_TEXT'}, 'PRIVATE_TEXT': 'PRIVATE_TEXT',
    }, {
        'batch_debug': 'model_returned', 'payload_type': 'dict',
        'item_count': 2, 'research_candidate_count': -1,
    }]
    assert batch.sanitize_batch_diagnostics(value) == [
        {'batch_debug': 'item_invalid', 'proposed_field_count': 7},
        {'batch_debug': 'model_returned', 'payload_type': 'dict', 'item_count': 2},
    ]
    assert batch.sanitize_batch_diagnostics({'batch_debug': 'items_validated'}) == []
    assert len(batch.sanitize_batch_diagnostics([{'batch_debug': 'items_validated'}] * 200)) == 128


@pytest.mark.parametrize('number', [1_000_001, 10 ** 100, float('nan'), True, False])
def test_diagnostic_sanitizer_drops_out_of_bound_and_noninteger_counts(number):
    batch = importlib.import_module('zhihu_m2.batch_screening')
    assert batch.sanitize_batch_diagnostics([{
        'batch_debug': 'item_invalid', 'card_count': number, 'proposed_field_count': number,
    }]) == [{'batch_debug': 'item_invalid'}]
    assert batch.sanitize_batch_diagnostics([{
        'batch_debug': 'item_invalid', 'card_count': 0, 'proposed_field_count': 1_000_000,
    }]) == [{'batch_debug': 'item_invalid', 'card_count': 0, 'proposed_field_count': 1_000_000}]


@pytest.mark.parametrize('compilation', [
    None, [], 'SYNTHETIC_PRIVATE_MODEL_TEXT', True,
    {'evidence_cards': None}, {'evidence_cards': {}},
    {'evidence_cards': 'SYNTHETIC_PRIVATE_MODEL_TEXT'}, {'evidence_cards': True},
])
def test_invalid_compilation_types_do_not_break_debug_card_count(model, monkeypatch, capsys, compilation):
    monkeypatch.setenv('ZHIHU_BATCH_DEBUG', '1')
    values = [candidate(i) for i in range(2)]
    invalid = item(1, values[1])
    invalid['compilation'] = compilation
    model['payload'] = {'items': [item(0, values[0]), invalid]}
    diagnostics = []
    output = run(values, diagnostics=diagnostics)
    assert len(output['compilerOutputs']) == 1
    invalid_item = next(entry for entry in diagnostics if entry['batch_debug'] == 'item_invalid')
    assert invalid_item['candidate_index'] == 1
    assert 'card_count' not in invalid_item
    assert 'SYNTHETIC_PRIVATE_MODEL_TEXT' not in json.dumps(diagnostics)
    assert 'SYNTHETIC_PRIVATE_MODEL_TEXT' not in capsys.readouterr().err


def test_duplicate_hypothesis_is_dropped_without_discarding_first_group(model):
    values = [candidate()]
    group = {'title': '同一假设', 'summary': '有依据的主张。',
             'applicableWhen': ['已知条件'], 'candidateIndices': [0], 'risks': []}
    model['payload'] = {'items': [item(0, values[0])],
                        'researchCandidates': [group, copy.deepcopy(group)]}
    output = run(values)
    assert len(output['researchCandidates']) == 1
    assert len(output['compilerOutputs'][0]['evidence_cards']) == 1
    assert output['issues'] == [
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 1}]


@pytest.mark.parametrize('field,value', [
    ('title', ''), ('summary', 9), ('extra', 'untrusted'),
    ('applicableWhen', 'condition'), ('risks', [''] * 9),
])
def test_invalid_hypothesis_fields_do_not_weaken_evidence_validation(model, field, value):
    values = [candidate()]
    group = {'title': '某方法', 'summary': '作者建议进行练习。',
             'applicableWhen': ['某条件'], 'candidateIndices': [0], 'risks': []}
    group[field] = value
    model['payload'] = {'items': [item(0, values[0])], 'researchCandidates': [group]}
    output = run(values)
    assert len(output['compilerOutputs'][0]['evidence_cards']) == 1
    assert output['researchCandidates'] == []
    assert output['issues'] == [
        {'code': 'batch_research_candidate_invalid', 'researchCandidateIndex': 0}]


@pytest.mark.parametrize('domain', ['programming', 'writing'])
def test_cross_language_fixture_uses_spawned_batch_and_original_quotes(domain):
    process = subprocess.run(
        [sys.executable, '-X', 'utf8', '-B', '-m', 'tests.fixtures.batch_boundary_offline', domain],
        cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
        encoding='utf-8', timeout=20, check=True,
    )
    output = json.loads(process.stdout)
    assert process.stderr == ''
    assert output['metrics'] == {'search_calls_attempted': 0, 'compiler_calls_attempted': 0,
                                'batch_model_calls_attempted': 1, 'model_calls_attempted': 1,
                                 'candidate_count': 8, 'evidence_count': 8}
    data = output['data']
    assert data['requestId'] == 'external-rq'
    assert len(data['routeCandidates']) == 2
    assert data['coverage']['reviewStatus'] == 'needs_human_review'
    for compiled in data['compilerOutputs']:
        card = compiled['evidence_cards'][0]
        assert compiled['source']['snippet'].startswith('😀开头\r\n')
        assert card['quote_start'] == 5
        assert compiled['source']['snippet'][card['quote_start']:card['quote_end']] == card['supporting_quote']
