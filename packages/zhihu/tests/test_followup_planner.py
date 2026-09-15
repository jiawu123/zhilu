"""Offline regression for the 2026-09-12 query budget and explicit followup API."""
import copy
import json

import pytest

from zhihu_m2 import llm_client
from zhihu_m2 import query_planner as qp


GOAL = "在家学习制作一张牢固的小木桌。"
CONTEXT = {"experience": "初学者", "available_tools": ["手锯"]}
GAPS = [{"kind": "counterevidence", "reason": "现有来源未说明手工连接方式的适用限制。"}]


def proposal(counts=(1, 1)):
    return {
        "status": "ok", "reason": "优先研究结构与检验方法。",
        "research_questions": [
            {"research_question": f"初学者制作小木桌应如何研究第{index + 1}项结构条件？",
             "evidence_need": "method", "why_needed": "为结构选择补充可用的依据。",
             "queries": [f"小木桌 结构条件{index + 1} 检验方法{number + 1}" for number in range(count)]}
            for index, count in enumerate(counts)
        ],
        "clarification_questions": [],
    }


@pytest.fixture
def model(monkeypatch):
    state = {"calls": [], "response": proposal(), "error": None}

    def generate(system, user, *, max_tokens):
        state["calls"].append((system, json.loads(user), max_tokens))
        if state["error"]:
            raise state["error"]
        return copy.deepcopy(state["response"])

    monkeypatch.setattr(llm_client, "generate_json", generate)
    return state


@pytest.mark.parametrize("counts", [(2,), (1, 1), (2, 1), (1, 1, 1)])
def test_initial_accepts_two_or_three_total_queries_without_padding(counts, model):
    model["response"] = proposal(counts)
    result = qp.plan_research(GOAL, CONTEXT, planning_profile="m2-initial")
    assert len(result["research_questions"]) == len(counts)
    assert result["planned_query_count"] == sum(counts)
    assert result["human_approved"] is result["coverage_verified"] is False
    assert result["queries_executed"] is False
    assert len(model["calls"]) == 1
    system, payload, _ = model["calls"][0]
    assert "总计2到3条" in system and "不凑" in system
    assert "恰好3个" not in system
    assert payload["planning_profile"] == "m2-initial"


@pytest.mark.parametrize("counts", [(1,), (2, 2), (2, 2, 2)])
def test_initial_rejects_query_total_outside_budget_without_retry(counts, model):
    model["response"] = proposal(counts)
    frozen = qp.build_planner_input(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    with pytest.raises(qp.PlannerValidationError, match="2..3"):
        qp.validate_plan_response(model["response"], frozen)
    assert len(model["calls"]) == 0


@pytest.mark.parametrize("counts,expected", [((2, 2), (2, 1)), ((2, 2, 2), (1, 1, 1)),
                                           ((1, 2, 1), (1, 1, 1)), ((2, 1, 2), (1, 1, 1))])
def test_initial_allocates_budget_without_losing_questions_or_retrying(counts, expected, model):
    model["response"] = proposal(counts)
    original = copy.deepcopy(model["response"])
    result = qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    assert tuple(len(q["queries"]) for q in result["research_questions"]) == expected
    assert result["planned_query_count"] == 3
    assert result["query_selection"]["proposed_query_count"] == sum(counts)
    deferred = [item["query"] for item in result["query_selection"]["deferred_queries"]]
    selected = [query for q in result["research_questions"] for query in q["queries"]]
    assert sorted(selected + deferred) == sorted(query for q in original["research_questions"] for query in q["queries"])
    assert result["queries_executed"] is False
    assert model["response"] == original
    assert len(model["calls"]) == 1


@pytest.mark.parametrize("bad_query", ["https://example.com", "小木桌 结构条件1 检验方法1"])
def test_initial_validates_even_candidates_that_would_be_deferred(bad_query, model):
    model["response"] = proposal((2, 2))
    model["response"]["research_questions"][1]["queries"][1] = bad_query
    with pytest.raises(qp.PlannerValidationError):
        qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    assert len(model["calls"]) == 1


def test_initial_rejects_global_duplicates(model):
    model["response"]["research_questions"][1]["queries"] = [
        model["response"]["research_questions"][0]["queries"][0] + " "
    ]
    with pytest.raises(qp.PlannerValidationError, match="Duplicate"):
        qp.plan_research(GOAL, CONTEXT, planning_profile="m2-initial")
    assert len(model["calls"]) == 1


def test_initial_preserves_clarification_without_followup_call(model):
    model["response"] = {"status": "needs_clarification", "reason": "缺少目标产物。",
                         "research_questions": [], "clarification_questions": ["希望制作哪种木制品？"]}
    result = qp.plan_research("学习手工。", {}, planning_profile="m2-initial")
    assert result["status"] == "needs_clarification"
    assert result["planned_query_count"] == 0
    assert len(model["calls"]) == 1


def test_initial_rejects_incompatible_caller_limit_before_model(model):
    with pytest.raises(ValueError):
        qp.plan_research(GOAL, CONTEXT, planning_profile="m2-initial", max_questions=1, queries_per_question=1)
    assert not model["calls"]


@pytest.mark.parametrize("questions,per_question,budget", [(3, 2, 3), (1, 2, 2), (2, 1, 2)])
def test_initial_wire_budget_and_example_match_validator(questions, per_question, budget):
    frozen = qp.build_planner_input(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE,
                                    max_questions=questions, queries_per_question=per_question)
    system, user = qp.build_planner_prompts(frozen, retrieval_profile="batch-v1")
    assert json.loads(user)["max_total_queries"] == budget
    assert "[2,2]合计4条，属于无效输出" in system
    example = json.JSONDecoder().raw_decode(system[system.index('{"status":"ok"'):])[0]
    # The example uses two queries under the standard production limits.
    standard = qp.build_planner_input(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    assert qp.validate_plan_response(example, standard)["planned_query_count"] == 2


def supplemental(**kwargs):
    return qp.plan_supplemental(GOAL, CONTEXT, gaps=kwargs.pop("gaps", GAPS),
                               executed_queries=kwargs.pop("executed_queries", ["小木桌 入门结构"]),
                               remaining_query_budget=kwargs.pop("remaining_query_budget", 3), **kwargs)


@pytest.mark.parametrize("gaps,budget,reason", [([], 3, "coverage_sufficient"), (GAPS, 0, "query_budget_exhausted")])
def test_supplemental_stops_without_model_when_no_gap_or_budget(gaps, budget, reason, model):
    result = supplemental(gaps=gaps, remaining_query_budget=budget)
    assert result["status"] == "stop"
    assert result["stop_reason"] == reason
    assert result["planner_calls_attempted"] == 0
    assert result["planned_query_count"] == 0
    assert result["research_questions"] == []
    assert result["coverage_verified"] is result["human_approved"] is False
    assert result["queries_executed"] is False
    assert not model["calls"]


@pytest.mark.parametrize("budget,counts", [(1, (1,)), (2, (2,)), (3, (1, 2)), (8, (1, 1, 1))])
def test_supplemental_proposes_bounded_new_queries_without_search(budget, counts, model):
    model["response"] = proposal(counts)
    result = supplemental(remaining_query_budget=budget)
    assert result["status"] == "ready_for_review"
    assert result["planning_stage"] == "supplemental"
    assert result["planned_query_count"] == sum(counts)
    assert result["planner_calls_attempted"] == 1
    assert result["remaining_query_budget"] == budget
    assert result["executed_query_count"] == 1
    assert result["stop_reason"] is None
    assert result["gaps"] == GAPS
    assert result["coverage_verified"] is result["human_approved"] is False
    assert result["new_zhihu_search"] is result["queries_executed"] is False
    assert len(model["calls"]) == 1
    system, sent, _ = model["calls"][0]
    assert sent["gaps"] == GAPS
    assert sent["executed_queries"] == ["小木桌 入门结构"]
    assert sent["max_total_queries"] == min(3, budget)
    assert "补充" in system and "stop" in system
    assert result["input_scope"] == "goal_context_and_gap_summary"


def test_supplemental_model_can_stop_when_no_useful_additional_query(model):
    model["response"] = {"status": "stop", "reason": "已有查询已覆盖该缺口，无新的有效检索词。",
                         "research_questions": [], "clarification_questions": []}
    result = supplemental()
    assert result["status"] == "stop"
    assert result["stop_reason"] == "no_useful_queries"
    assert result["planner_calls_attempted"] == 1
    assert result["reason"] == model["response"]["reason"]


@pytest.mark.parametrize("budget,counts", [(1, (1, 1)), (2, (1, 2)), (6, (2, 2))])
def test_supplemental_rejects_over_budget_without_retry(budget, counts, model):
    model["response"] = proposal(counts)
    with pytest.raises(qp.PlannerValidationError, match="budget"):
        supplemental(remaining_query_budget=budget)
    assert len(model["calls"]) == 1


def test_supplemental_rejects_reexecuting_normalized_query(model):
    repeated = model["response"]["research_questions"][0]["queries"][0]
    with pytest.raises(qp.PlannerValidationError, match="executed"):
        supplemental(executed_queries=[repeated.upper() + "  "])
    assert len(model["calls"]) == 1


@pytest.mark.parametrize("change", [
    {"remaining_query_budget": True}, {"remaining_query_budget": False},
    {"remaining_query_budget": -1}, {"remaining_query_budget": 1.5}, {"remaining_query_budget": "2"},
    {"gaps": [{"kind": "unknown", "reason": "未知缺口"}]},
    {"gaps": [{"kind": "route", "reason": " "}]},
    {"gaps": [{"kind": "route", "reason": "缺口", "invented": True}]},
    {"gaps": "route"}, {"executed_queries": [True]},
    {"executed_queries": ["旧查询", " 旧查询 "]},
    {"executed_queries": ["https://example.com"]},
])
def test_supplemental_invalid_inputs_rejected_before_model(change, model):
    with pytest.raises(ValueError):
        supplemental(**change)
    assert not model["calls"]


@pytest.mark.parametrize("response", [
    {"status": "stop", "reason": " ", "research_questions": [], "clarification_questions": []},
    {"status": "stop", "reason": "足够", "research_questions": proposal()["research_questions"], "clarification_questions": []},
    {"status": "needs_clarification", "reason": "缺口", "research_questions": [], "clarification_questions": ["什么？"]},
])
def test_supplemental_rejects_invalid_stop_or_clarification_without_retry(response, model):
    model["response"] = response
    with pytest.raises(qp.PlannerValidationError):
        supplemental()
    assert len(model["calls"]) == 1


def test_supplemental_does_not_mutate_callers_or_model_data(model):
    gaps = copy.deepcopy(GAPS)
    original = copy.deepcopy(model["response"])
    result = supplemental(gaps=gaps)
    result["gaps"][0]["reason"] = "调用方修改"
    assert gaps == GAPS
    assert model["response"] == original


@pytest.mark.parametrize("message", [
    "Set DEEPSEEK_API_KEY in this terminal before calling the model.",
    "Set DEEPSEEK_API_KEY in the environment or packages/zhihu/.env before calling the model.",
    "Set DEEPSEEK_API_KEY SECRET_SENTINEL",
])
def test_missing_key_category_is_stable_and_never_echoes_message(message):
    result = qp._safe_error_code(llm_client.LLMError(message))
    assert result == "missing_api_key"
    assert "SECRET_SENTINEL" not in result


def test_supplemental_propagates_model_failure_once(model):
    model["error"] = llm_client.LLMError("controlled upstream failure")
    with pytest.raises(llm_client.LLMError):
        supplemental()
    assert len(model["calls"]) == 1
