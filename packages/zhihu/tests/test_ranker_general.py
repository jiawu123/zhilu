"""Synthetic regression for local deterministic ranking, never quality labels."""
import copy
import math

import pytest

from zhihu_m2 import ranker
from test_ranker import make_result


NOW = 1_800_000_000


def test_coding_vocabulary_alone_is_not_specific_evidence():
    jargon = make_result('API JSON HTTP GitHub Python TypeScript RAG React LLM embedding')
    wood = make_result('先测量两条桌腿的长度，再比较相差是否超过2厘米。')
    assert ranker.specificity_score(jargon) == 0
    assert ranker.specificity_score(wood) > ranker.specificity_score(jargon)


def test_quantity_requires_context_not_a_list_of_numbers():
    assert ranker.specificity_score(make_result('1 2 3 4 5 6 7 8')) == 0
    assert ranker.specificity_score(make_result('每天写500字初稿，连续记录一周的完成情况。')) > 0


@pytest.mark.parametrize('question,preferred', [
    ('怎样准备公开演讲？', '先写出演讲的中心观点，再用手机录制演讲并检查是否超出5分钟。'),
    ('怎样安排小说写作？', '先列出小说写作的角色动机，再写500字初稿，然后检查冲突是否清楚。'),
    ('怎样验证产品需求？', '先访谈5位目标用户，记录产品需求，再比较用户实际行为与预期。'),
    ('怎样学习外语口语？', '先录制一分钟外语口语，再比较录音和示范中的发音差异。'),
])
def test_non_coding_instructions_beat_irrelevant_popular_technical_text(question, preferred):
    useful = make_result(preferred, title=question)
    jargon = make_result('第一步调用 LLM API。第二步实现 JSON HTTP RAG 项目。第三步部署 Python 测试日志。',
                         title=question, votes=1_000_000, comments=1_000_000, edit_time=NOW)
    assert ranker.rank_results([jargon, useful], question, NOW)[0] is useful


def test_blank_query_does_not_create_a_fake_relevance_ranking():
    a = make_result('Python API 代码', votes=10000, edit_time=NOW)
    b = make_result('每天写一页小说。')
    assert ranker.evidence_score(a, ' ', NOW) == 0
    assert ranker.rank_results([b, a], ' ', NOW) == [b, a]


def test_echoed_question_is_not_body_support_and_does_not_modify_original():
    question = '怎样练习演讲？'
    body = '首先搭建 Python 项目，然后配置 JSON API。'
    plain = make_result(body, title=question)
    echoed = make_result(question + '\r\n' + body, title=question)
    original = copy.deepcopy(echoed)
    assert ranker.evidence_score(echoed, question, NOW) == ranker.evidence_score(plain, question, NOW)
    assert ranker.ranking_breakdown(echoed, question, NOW)['signals']['body_alignment'] == 0
    assert echoed == original


def test_complete_answer_containing_question_words_is_kept():
    answer = make_result('练习演讲是指录下演讲，再检查表达是否清楚。', title='演讲练习')
    assert ranker.ranking_breakdown(answer, '练习演讲', NOW)['signals']['body_alignment'] == 1


def test_statement_title_that_is_a_complete_short_answer_keeps_body_signals():
    answer = '先检查薄荷盆土，表层干燥再浇透。'
    result = make_result(answer, title=answer)
    details = ranker.ranking_breakdown(result, '如何给薄荷浇水？', NOW)
    assert details['signals']['task_fit'] > 0
    assert details['signals']['body_alignment'] > 0


def test_partial_topic_coverage_with_checks_beats_keyword_repetition():
    question = 'How can I compare apples pears oranges grapes?'
    useful = make_result('First weigh apples and pears, then compare the measured results against the target.', title=question)
    repeated = make_result('A guide to compare apples pears oranges grapes. API JSON HTTP GitHub Python.', title=question)
    assert ranker.rank_results([repeated, useful], question, NOW)[0] is useful


def test_paraphrased_explanation_beats_copying_every_question_keyword():
    question = 'What is the difference between velocity and speed during a change of direction?'
    useful = make_result('Velocity is directional, whereas speed measures magnitude. For example, turning while keeping the same speed changes velocity.', title=question)
    repeated = make_result('Read about the difference between velocity and speed during a change of direction. The meaning is important.', title=question)
    assert ranker.rank_results([repeated, useful], question, NOW)[0] is useful


def test_recency_is_opt_in_by_question_not_an_automatic_bonus():
    old = make_result('每天写500字初稿，然后检查段落衔接。', title='怎样练习写作？', edit_time=NOW - 86400 * 1500)
    recent = copy.deepcopy(old); recent.edit_time = NOW
    assert ranker.evidence_score(old, '怎样练习写作？', NOW) == ranker.evidence_score(recent, '怎样练习写作？', NOW)
    assert ranker.evidence_score(recent, '目前最新写作工具如何选择？', NOW) > ranker.evidence_score(old, '目前最新写作工具如何选择？', NOW)


def test_diagnostics_explain_question_dependent_weights_without_claiming_truth():
    method = ranker.ranking_breakdown(make_result('先记录演讲时间，再检查是否超出5分钟。'), '怎样练习演讲？', NOW)
    resource = ranker.ranking_breakdown(make_result('《演讲练习》包含录像示范，适用于入门练习。'), '有哪些演讲资源？', NOW)
    assert method['weights'] != resource['weights']
    assert method['weights']['recency'] == 0
    assert method['weights']['engagement'] <= .03
    assert method['weights']['relevance'] >= .6
    assert method['score_kind'] == 'heuristic_priority_not_fact_confidence'
    assert method['ranker_version'] == 'm2-ranker-v4'
    assert sum(method['weights'].values()) == pytest.approx(1)
    assert all(math.isfinite(n) and 0 <= n <= 1 for n in method['signals'].values())


@pytest.mark.parametrize('field', ['vote_up_count', 'comment_count', 'edit_time'])
@pytest.mark.parametrize('bad', [float('nan'), float('inf'), True])
def test_rejects_malformed_metadata_with_safe_message(field, bad):
    source = make_result('每天写500字。'); setattr(source, field, bad)
    with pytest.raises(ValueError, match='finite numbers'):
        ranker.evidence_score(source, '写作', NOW)


def test_freezes_clock_once_and_preserves_full_originals(monkeypatch):
    calls = []
    monkeypatch.setattr(ranker.time, 'time', lambda: calls.append(1) or NOW)
    a = make_result('😀开头\r\n先记录原始时间，再检查误差。', edit_time=NOW - 86400)
    b = copy.deepcopy(a)
    original = copy.deepcopy([a, b])
    assert ranker.rank_results([a, b], '目前检查时间的方法？') == [a, b]
    assert len(calls) == 1
    assert [a, b] == original


@pytest.mark.parametrize('question,body', [
    ('怎样准备公开演讲？', '先写出演讲的中心观点，再录制演讲并检查是否超出5分钟。'),
    ('怎样练习小说写作？', '先列出小说写作的角色动机，再写500字初稿，然后检查冲突。'),
    ('怎样验证产品需求？', '先访谈5位目标用户，记录产品需求，再比较用户实际行为与预期。'),
])
def test_real_legacy_runner_uses_request_question_and_preserves_compiler_input(monkeypatch, question, body):
    from zhihu_m2 import query_planner, research_runner
    from zhihu_m2.retrieval_options import RetrievalOptions
    from test_research_runner import payload, raw, response, compile_ok

    monkeypatch.setattr(query_planner, 'plan_research', lambda *a, **k: pytest.fail('Planner must not run'))
    request = payload()
    request.update(goal=question, user_context={})
    request['request'].update(question=question, searchQueries=['指定原始查询'], evidenceLimit=1)
    original = body + '\r\n😀 保留这个原始片段。'
    irrelevant = raw(1, '第一步搭建 Python API，第二步配置 JSON 和数据库。')
    preferred = raw(2, original)
    irrelevant['Title'] = preferred['Title'] = question
    searches, questions, compiled = [], [], []

    def search(query, **kwargs):
        searches.append(query)
        return response(irrelevant, preferred)

    def rank(results, *, query):
        questions.append(query)
        return ranker.rank_results(results, query, NOW)

    def compile(result, **kwargs):
        compiled.append((copy.deepcopy(result), kwargs['research_question']))
        return compile_ok(result, **kwargs)

    metrics = {}
    result = research_runner.run_research(request,
        dependencies=research_runner.ResearchDependencies(search=search, rank=rank, compile=compile),
        options=RetrievalOptions('legacy'), metrics=metrics)
    assert searches == ['指定原始查询']
    assert questions == [question]
    assert result['requestId'] == request['request']['id']
    assert result['status'] == 'ok'
    assert len(compiled) == metrics['compiler_calls_attempted'] == 1
    assert compiled[0][0].content_text == original
    assert compiled[0][1] == question
