"""Offline prompt plumbing only: fake responses cannot establish model quality."""
import copy
import hashlib
import json
import socket
from pathlib import Path

import pytest

from zhihu_m2 import evidence_compiler as ec, query_planner as qp
from test_evidence_compiler import make_result, valid_payload, GOAL, QUESTION, CONTEXT
from test_query_planner import model_plan, baseline_model_plan


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.delenv("ZHIHU_RETRIEVAL_PROFILE", raising=False)
    def forbidden(*args, **kwargs):
        raise AssertionError("Offline prompt tests forbid network")
    monkeypatch.setattr(socket.socket, "connect", forbidden)


def test_legacy_prompt_bytes_match_pre_v3_snapshot():
    assert hashlib.sha256(qp.SYSTEM_PROMPT.encode()).hexdigest() == "f20526e36ca8d00f2de5a19bb970d34d152faacf59b8d8a0c8e0768a2dc24970"
    assert hashlib.sha256(ec.SYSTEM_PROMPT.encode()).hexdigest() == "8c0156300cf9b449ce92e196176afd6bffae72d66eae31d6cc14ac761120f541"


@pytest.mark.parametrize("profile", ["legacy", "v3"])
def test_actual_planner_prompt_and_baseline_are_independent(monkeypatch, profile):
    monkeypatch.setenv("ZHIHU_RETRIEVAL_PROFILE", profile)
    frozen = qp.build_planner_input(GOAL, CONTEXT)
    calls = []
    def fake(system, user, **kw):
        calls.append((system, user))
        return model_plan()
    monkeypatch.setattr(qp.llm_client, "generate_json", fake)
    assert len(qp.plan_research(GOAL, CONTEXT)["research_questions"]) == 2
    assert calls == [qp.build_planner_prompts(frozen, retrieval_profile=profile)]
    baseline = qp.build_planner_input(GOAL, CONTEXT, planning_profile=qp.BASELINE_PROFILE)
    prompt, user = qp.build_planner_prompts(baseline, retrieval_profile=profile)
    assert "恰好3个" in prompt and "恰好2条" in prompt
    assert json.loads(user) == baseline
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(model_plan(), baseline)
    clarified = {"status": "needs_clarification", "reason": "目标不明", "research_questions": [], "clarification_questions": ["要学习什么？"]}
    assert qp.validate_plan_response(clarified, baseline)["status"] == "needs_clarification"
    complete = baseline_model_plan()
    assert qp.validate_plan_response(complete, baseline)["planned_query_count"] == 6
    complete["research_questions"][2]["queries"][0] = complete["research_questions"][0]["queries"][0]
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(complete, baseline)
    if profile == "legacy":
        assert calls[0][0] == qp.SYSTEM_PROMPT
    else:
        assert "同一核心问题" in prompt and "踩坑" in prompt


@pytest.mark.parametrize("profile", ["legacy", "v3"])
def test_actual_compiler_prompt_builder_preserves_raw_context(monkeypatch, profile):
    result = make_result()
    calls = []
    def fake(system_prompt, user_prompt, **kw):
        calls.append((system_prompt, user_prompt))
        return valid_payload()
    monkeypatch.setattr(ec.llm_client, "generate_json", fake)
    kwargs = dict(goal=GOAL, user_context=CONTEXT, research_question=QUESTION, retrieval_profile=profile)
    output = ec.compile_evidence(result, **kwargs)
    assert calls == [ec.build_compiler_prompts(result, **kwargs)]
    assert json.loads(calls[0][1])["user_context"] == CONTEXT
    assert json.loads(calls[0][1])["source"]["snippet"] == result.content_text
    assert output["compiler_version"] == "m2-evidence-v0.1.2"
    if profile == "legacy":
        assert calls[0][0] == ec.SYSTEM_PROMPT
    else:
        assert "五分钟上手" in calls[0][0] and "如何判断调用参数正确" in calls[0][0]
        assert "有什么资源" in calls[0][0]
    assert hashlib.sha256(json.dumps(calls[0], ensure_ascii=False).encode()).hexdigest() != hashlib.sha256(ec.SYSTEM_PROMPT.encode()).hexdigest()


def test_unknown_profile_rejected_before_model_and_never_echoed(monkeypatch):
    monkeypatch.setenv("ZHIHU_RETRIEVAL_PROFILE", "private-invalid-setting")
    def forbidden(*a, **k):
        raise AssertionError("model must not be called")
    monkeypatch.setattr(qp.llm_client, "generate_json", forbidden)
    with pytest.raises(ValueError) as error:
        qp.plan_research(GOAL, CONTEXT)
    assert "private-invalid-setting" not in str(error.value)
    with pytest.raises(ValueError):
        ec.compile_evidence(make_result(), goal=GOAL, user_context=CONTEXT, research_question=QUESTION, retrieval_profile="private-invalid-setting")


def test_exact_quote_does_not_block_unsupported_claim():
    payload = copy.deepcopy(valid_payload())
    payload["evidence_cards"][0]["claim"] += "保证两周学会。"
    card = ec.validate_evidence_response(payload, make_result())["evidence_cards"][0]
    assert card["citation_status"] == "exact_match"
    assert "保证两周学会" in card["claim"]
    assert "semantic_support_not_checked" in card["risk_flags"]
    # Human/model-quality review must judge this unsupported, despite structural acceptance.


def test_cli_planner_uses_v3_and_records_the_sent_prompt(monkeypatch, tmp_path):
    monkeypatch.setenv("ZHIHU_RETRIEVAL_PROFILE", "v3")
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"goal": GOAL, "user_context": CONTEXT}), encoding="utf-8")
    sent = []
    def fake(system, user, **kw):
        sent.append((system, user))
        return model_plan()
    monkeypatch.setattr(qp.llm_client, "generate_json", fake)
    report = qp.run_planner(path, call_model=True, output_root=tmp_path / "output")
    assert "同一核心问题" in sent[0][0]
    assert report["system_prompt_sha256"] == hashlib.sha256(sent[0][0].encode()).hexdigest()
    assert (Path(report["output_dir"]) / "system_prompt.txt").read_text(encoding="utf-8") == sent[0][0]
