"""Offline tests: original ten V2 cases plus promotion regressions.

Tests use synthetic snippets and never call Zhihu or a language model.
"""
import pytest

from zhihu_m2.models import ZhihuResult
from zhihu_m2.ranker import (
    actionability_score, clean_content, engagement_score, evidence_score,
    promotion_score, rank_results, recency_score, relevance_score, specificity_score,
)


def make_result(content_text, title="Test", votes=0, comments=0, edit_time=0):
    return ZhihuResult(
        title=title, content_type="Answer", content_id="123",
        author_name="Test Author", author_signature="test-author", author_badge_text="",
        content_text=content_text, url="https://www.zhihu.com/test",
        vote_up_count=votes, comment_count=comments, authority_level="4",
        ranking_score=2.0, edit_time=edit_time,
    )


def test_free_api_is_not_promotion():
    assert promotion_score(make_result("这个 API 可以免费使用，开发者可以直接调用。")) == 0.0


def test_contact_cta_has_high_promotion_score():
    assert promotion_score(make_result("如果你想系统学习，可以加老师免费领取内部资源包。")) > 0.7


def test_clean_content_removes_promotional_paragraphs():
    result = make_result("第一步调用 LLM API。\n加老师免费领取内部资源包。\n第二步实现工具调用。")
    cleaned = clean_content(result)
    assert "调用 LLM API" in cleaned
    assert "实现工具调用" in cleaned
    assert "免费领取内部资源包" not in cleaned


def test_engagement_score_increases_with_votes_and_comments():
    low = make_result("普通内容", votes=5, comments=0)
    high = make_result("普通内容", votes=300, comments=50)
    assert engagement_score(high) > engagement_score(low)


def test_actionability_uses_cleaned_technical_content():
    result = make_result("第一步调用 LLM API。\n加老师免费领取内部资源包。\n第二步实现工具调用，然后测试和调试代码。")
    assert actionability_score(result) > 0.5


def test_relevance_score_prefers_related_result():
    query = "Agent Engineer 学习路线"
    related = make_result("介绍 Agent 工程师的学习路线和项目实践。", title=query)
    unrelated = make_result("介绍如何种植番茄和选择土壤。", title="家庭园艺指南")
    assert relevance_score(related, query) > relevance_score(unrelated, query)


def test_specificity_score_prefers_concrete_technical_details():
    vague = make_result("AI Agent 很重要，建议大家多学习、多实践。")
    concrete = make_result("Part 1 用 Python 调用 LLM API。第2步实现 tool calling 和 JSON schema。第3步实现 Agent Loop，并加入 evaluation 和日志。")
    assert specificity_score(concrete) > specificity_score(vague)


def test_recency_score_prefers_newer_content():
    now_ts = 1_800_000_000
    recent = make_result("内容", edit_time=now_ts - 30 * 86400)
    old = make_result("内容", edit_time=now_ts - 4 * 365 * 86400)
    assert recency_score(recent, now_ts=now_ts) > recency_score(old, now_ts=now_ts)


def test_evidence_score_penalizes_heavy_promotion():
    query = "Agent Engineer 学习路线"
    clean = make_result("第一步调用 LLM API。第二步实现工具调用。然后实现 Agent Loop，最后测试项目。", title=query, votes=10, comments=2, edit_time=1_790_000_000)
    promotional = make_result("第一步调用 LLM API。第二步实现工具调用。\n加老师免费领取内部资源包。", title=query, votes=300, comments=20, edit_time=1_790_000_000)
    assert evidence_score(clean, query, now_ts=1_800_000_000) > evidence_score(promotional, query, now_ts=1_800_000_000)


def test_rank_results_orders_by_v2_evidence_score():
    query = "Agent Engineer 学习路线"
    technical = make_result("Part 1 调用 LLM API。第2步实现 tool calling。第3步实现 Agent Loop，并加入 evaluation 和日志。", title=query, votes=6, edit_time=1_790_000_000)
    promotional = make_result("Agent Engineer 学习路线。\n加老师免费领取内部资源包，报名公开课。", title=query, votes=300, comments=20, edit_time=1_790_000_000)
    generic = make_result("AI Agent 是未来非常重要的发展方向。", title="AI 发展趋势", votes=5, edit_time=1_790_000_000)
    assert rank_results([promotional, generic, technical], query, now_ts=1_800_000_000)[0] is technical


# Regression cases below catch problems the original ten tests did not cover.

def test_soft_course_recommendation_is_a_weak_nonzero_signal():
    result = make_result("可以先听一下大模型应用开发公开课。")
    assert 0.0 < promotion_score(result) < 0.7


def test_course_mention_alone_is_not_promotion():
    result = make_result("这门课程介绍 Python 的循环和函数。")
    assert promotion_score(result) == 0.0
    assert "Python" in clean_content(result)


def test_technical_wechat_mention_is_kept():
    result = make_result("调用微信 API，并验证签名和处理超时。")
    assert promotion_score(result) == 0.0
    assert clean_content(result) == result.content_text


def test_warning_against_contact_offer_is_not_an_ad():
    result = make_result("不要加老师免费领取内部资源包，先核实来源。")
    assert promotion_score(result) == 0.0
    assert "核实来源" in clean_content(result)


def test_mixed_paragraph_keeps_neighboring_technical_sentences():
    result = make_result("第一步调用 LLM API。加老师免费领取内部资源包。第二步实现工具调用。")
    cleaned = clean_content(result)
    assert "调用 LLM API" in cleaned
    assert "实现工具调用" in cleaned
    assert "领取内部资源包" not in cleaned


def test_uncertain_recommendation_is_not_deleted():
    result = make_result("推荐这门公开课，同时建议实现 API 超时重试。")
    assert 0.0 < promotion_score(result) < 0.7
    assert "API 超时重试" in clean_content(result)


def test_dont_miss_cta_is_still_detected():
    result = make_result("不要错过免费领取资源包的名额。")
    assert promotion_score(result) > 0.7


def test_this_is_not_an_ad_disclaimer_does_not_hide_recommendation():
    result = make_result("不要把它当成课程广告，可以先听一下公开课。")
    assert promotion_score(result) > 0.0


def test_cleaning_does_not_mutate_original_text():
    text = "第一步调用 API。加老师免费领取内部资源包。"
    result = make_result(text)
    clean_content(result)
    assert result.content_text == text


def test_single_strong_cta_is_diluted_by_longer_technical_context():
    ad = "加老师免费领取内部资源包。"
    only_ad = make_result(ad)
    mostly_technical = make_result(("通过超时重试处理 API 异常。" * 20) + ad)
    assert promotion_score(mostly_technical) < promotion_score(only_ad)


def test_ranking_is_stable_and_does_not_mutate_input():
    first = make_result("调用 API 并处理超时。")
    second = make_result("调用 API 并处理超时。")
    original = [first, second]
    ranked = rank_results(original, "API", now_ts=1_800_000_000)
    assert ranked is not original
    assert ranked[0] is first
    assert ranked[1] is second
    assert original == [first, second]