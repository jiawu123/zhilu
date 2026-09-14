"""Offline tests: validate planning contracts and plumbing, NOT model quality."""
import copy
import hashlib
import json
import math
from pathlib import Path

import httpx
import pytest

from zhihu_m2 import llm_client
from zhihu_m2 import query_planner as qp

GOAL = "8周内完成一个可运行、带基本测试的 Agent 小项目。"
CONTEXT = {"python_level": "beginner", "weekly_hours": 10, "is_demo": True}


def model_plan():
    # Test fixture, never a default/fallback plan in production.
    return {
        "status": "ok", "reason": "分别研究实现范围和逻辑检查方法。",
        "research_questions": [
            {"research_question": "最小 Agent 练习项目应包含哪些基本功能？",
             "evidence_need": "concept", "why_needed": "先界定实现范围，而非承诺八周可行性。",
             "queries": ["Agent 最小实现 基本功能", "智能体 入门项目 功能组成"]},
            {"research_question": "在 Agent 练习中，怎样检验程序流程或逻辑？",
             "evidence_need": "verification", "why_needed": "为基本测试选择检查方法。",
             "queries": ["Agent 程序逻辑 检查方法", "智能体 测试方法 实践"]},
        ], "clarification_questions": [],
    }


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    monkeypatch.delenv("ZHIHU_RETRIEVAL_PROFILE", raising=False)
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    monkeypatch.delenv("ZHIHU_PLANNER_DIAGNOSTIC_DIR", raising=False)
    monkeypatch.delenv("ZHIHU_PLANNER_DIAGNOSTIC_FILE", raising=False)
    def forbidden(*args, **kwargs):
        raise AssertionError("Unexpected real HTTP request in an offline test")
    monkeypatch.setattr(httpx.Client, "send", forbidden)


@pytest.fixture
def fake_model(monkeypatch):
    state = {"calls": [], "response": model_plan(), "error": None}
    def generate(system_prompt, user_prompt, *, max_tokens, diagnostic=None):
        state["calls"].append((system_prompt, json.loads(user_prompt), max_tokens))
        if state["error"] is not None:
            raise state["error"]
        return copy.deepcopy(state["response"])
    monkeypatch.setattr(llm_client, "generate_json", generate)
    return state


@pytest.fixture
def request_file(tmp_path):
    path = tmp_path / "request.json"
    path.write_text(json.dumps({"goal": GOAL, "user_context": CONTEXT}, ensure_ascii=False), encoding="utf-8")
    return path


def inputs(**kwargs):
    return qp.build_planner_input(GOAL, CONTEXT, **kwargs)


def run(request_file, tmp_path, **kwargs):
    return qp.run_planner(request_file, output_root=tmp_path / "out", **kwargs)


def test_input_contains_only_goal_context_and_budgets():
    frozen = inputs()
    assert frozen == {"goal": GOAL, "user_context": CONTEXT,
                      "max_questions": 3, "queries_per_question": 2}


@pytest.mark.parametrize("goal", ["", "  ", None, 3, "x" * 2001])
def test_reject_invalid_goal_before_model(goal, fake_model):
    with pytest.raises(ValueError):
        qp.plan_research(goal, CONTEXT)
    assert fake_model["calls"] == []


@pytest.mark.parametrize("field, value", [
    ("max_questions", 0), ("max_questions", 4), ("max_questions", True),
    ("max_questions", "3"), ("max_questions", 1.5),
    ("queries_per_question", 0), ("queries_per_question", 3),
    ("queries_per_question", False), ("queries_per_question", 1.5),
])
def test_invalid_budgets_rejected(field, value, fake_model):
    with pytest.raises(ValueError):
        qp.plan_research(GOAL, CONTEXT, **{field: value})
    assert fake_model["calls"] == []


@pytest.mark.parametrize("context", [None, [], {1: "coerced"}, {"x": math.nan},
    {"x": math.inf}, {"x": object()}, {"x": (1, 2)}, {"x": "a" * 8001},
    {"credentials": {"DEEPSEEK_API_KEY": "not-a-real-key"}},
    {"a": [{"AccessSecret": "not-a-real-key"}]}])
def test_context_must_be_bounded_plain_json_without_credential_fields(context):
    with pytest.raises(ValueError):
        qp.build_planner_input(GOAL, context)


def test_empty_context_is_allowed_without_inventing_background():
    assert qp.build_planner_input(GOAL, {})["user_context"] == {}


def test_input_is_a_deep_copy():
    original = {"skills": ["Python"], "optional": None}
    frozen = qp.build_planner_input(GOAL, original)
    frozen["user_context"]["skills"].append("SQL")
    assert original["skills"] == ["Python"]


def test_ready_plan_adds_provenance_and_pending_review_flags():
    payload = model_plan()
    before = copy.deepcopy(payload)
    result = qp.validate_plan_response(payload, inputs())
    assert result["status"] == "ready_for_review"
    assert result["requires_human_review"] is True
    assert result["human_approved"] is False
    assert result["semantic_quality_checked"] is False
    assert result["queries_executed"] is False
    assert result["generation_basis"] == "model_proposal_not_evidence"
    assert result["planned_query_count"] == 4
    assert result["goal"] == GOAL and result["user_context"] == CONTEXT
    assert payload == before
    assert len(result["research_questions"]) == 2


def test_question_id_compatible_with_existing_batch_formula():
    question = model_plan()["research_questions"][0]["research_question"]
    value = {"goal": GOAL, "user_context": CONTEXT, "research_question": question}
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)
    expected = "rq_" + hashlib.sha256(serialized.encode("utf-8")).hexdigest()[:16]
    result = qp.validate_plan_response(model_plan(), inputs())
    assert result["research_questions"][0]["question_id"] == expected


def test_allow_fewer_questions_and_one_query():
    payload = model_plan()
    payload["research_questions"] = payload["research_questions"][:1]
    payload["research_questions"][0]["queries"] = ["Agent 基本功能"]
    payload["reason"] = ""
    result = qp.validate_plan_response(payload, inputs(max_questions=1, queries_per_question=1))
    assert result["planned_query_count"] == 1


@pytest.mark.parametrize("payload", [None, [], {}, {"status": "ok"},
    dict(model_plan(), answer="fake"), dict(model_plan(), status="verified"),
    dict(model_plan(), reason=None), dict(model_plan(), reason="x" * 1001),
    dict(model_plan(), research_questions=[]), dict(model_plan(), clarification_questions=["why?"]),
])
def test_invalid_top_level_rejected(payload):
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(payload, inputs())


@pytest.mark.parametrize("field,value", [
    ("research_question", " "), ("research_question", "x" * 301),
    ("evidence_need", "verified_fact"), ("why_needed", ""), ("why_needed", "x" * 601),
    ("queries", []), ("queries", ["a", "b", "c"]), ("queries", [None]),
    ("queries", [" "]), ("queries", ["x" * 121]),
    ("queries", ["https://example.com/answer"]),
])
def test_invalid_question_fields_rejected(field, value):
    payload = model_plan()
    payload["research_questions"][0][field] = value
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(payload, inputs())


def test_model_cannot_add_ids_or_answer_fields():
    for key in ("question_id", "source_url", "answer", "verification_status"):
        payload = model_plan()
        payload["research_questions"][0][key] = "fabricated"
        with pytest.raises(qp.PlannerValidationError):
            qp.validate_plan_response(payload, inputs())


def test_exact_question_duplicates_case_space_and_punctuation_rejected():
    payload = model_plan()
    payload["research_questions"][0]["research_question"] = "如何测试 Agent？"
    payload["research_questions"][1]["research_question"] = "如何测试agent?"
    with pytest.raises(qp.PlannerValidationError, match="Duplicate"):
        qp.validate_plan_response(payload, inputs())


@pytest.mark.parametrize("global_duplicate", [False, True])
def test_exact_duplicate_searches_rejected(global_duplicate):
    payload = model_plan()
    first = payload["research_questions"][0]["queries"][0]
    index = 1 if global_duplicate else 0
    payload["research_questions"][index]["queries"][1] = first.upper() + "  "
    with pytest.raises(qp.PlannerValidationError, match="Duplicate"):
        qp.validate_plan_response(payload, inputs())


def test_budget_overflow_not_silently_truncated():
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(model_plan(), inputs(max_questions=1))
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(model_plan(), inputs(queries_per_question=1))


def test_needs_clarification_is_not_api_error_or_no_evidence():
    payload = {"status": "needs_clarification", "reason": "目标没有说明学习对象。",
               "research_questions": [], "clarification_questions": ["你要学习什么技能？"]}
    result = qp.validate_plan_response(payload, inputs())
    assert result["status"] == "needs_clarification"
    assert result["research_questions"] == []
    assert result["planned_query_count"] == 0


@pytest.mark.parametrize("field,value", [("reason", " "), ("clarification_questions", []),
    ("clarification_questions", ["x"] * 4), ("research_questions", model_plan()["research_questions"])])
def test_invalid_clarification_contract_rejected(field, value):
    payload = {"status": "needs_clarification", "reason": "缺少主题。",
               "research_questions": [], "clarification_questions": ["主题是什么？"]}
    payload[field] = value
    with pytest.raises(qp.PlannerValidationError):
        qp.validate_plan_response(payload, inputs())


def test_public_function_one_call_and_no_answers_or_source_text_in_input(fake_model):
    result = qp.plan_research(GOAL, CONTEXT)
    assert result["status"] == "ready_for_review"
    assert len(fake_model["calls"]) == 1
    prompt, sent, tokens = fake_model["calls"][0]
    assert prompt == qp.SYSTEM_PROMPT
    assert sent == inputs()
    assert tokens == 2400


def test_invalid_model_output_not_retried(fake_model):
    fake_model["response"] = {"broken": True}
    with pytest.raises(qp.PlannerValidationError):
        qp.plan_research(GOAL, CONTEXT)
    assert len(fake_model["calls"]) == 1


def test_dry_run_no_key_no_model_no_output_folder(request_file, tmp_path, fake_model):
    report = run(request_file, tmp_path)
    assert report["status"] == "dry_run"
    assert report["planner_calls_attempted"] == 0
    assert report["model_calls_upper_bound"] == 0
    assert report["new_zhihu_search"] is False
    assert report["max_total_queries"] == 6
    assert report["input"] == inputs()
    assert fake_model["calls"] == []
    assert not (tmp_path / "out").exists()


def test_execution_saves_input_raw_prompt_plan_and_manifest(request_file, tmp_path, fake_model):
    report = run(request_file, tmp_path, call_model=True)
    folder = Path(report["output_dir"])
    assert report["status"] == "ready_for_review"
    assert report["planner_calls_attempted"] == 1
    assert report["new_zhihu_search"] is False
    assert report["automatic_retries"] is False
    assert report["planned_query_count"] == 4
    assert read(folder / "model_response.json") == fake_model["response"]
    assert read(folder / "planner_input.json") == inputs()
    assert read(folder / "query_plan.json")["human_approved"] is False
    assert (folder / "system_prompt.txt").read_text(encoding="utf-8") == qp.SYSTEM_PROMPT
    assert json.loads((folder / "user_prompt.txt").read_text(encoding="utf-8")) == inputs()
    assert read(folder / "manifest.json") == report
    expected_hash = hashlib.sha256(qp.SYSTEM_PROMPT.encode("utf-8")).hexdigest()
    assert report["system_prompt_sha256"] == expected_hash


def test_failed_schema_saved_without_query_plan_and_without_retry(request_file, tmp_path, fake_model):
    fake_model["response"] = {"bad_schema": "invalid model data"}
    report = run(request_file, tmp_path, call_model=True)
    folder = Path(report["output_dir"])
    assert report["status"] == "error"
    assert report["stage"] == "validate"
    assert report["error_type"] == "PlannerValidationError"
    assert read(folder / "model_response.json") == fake_model["response"]
    assert not (folder / "query_plan.json").exists()
    assert len(fake_model["calls"]) == 1


def test_initial_diagnostic_preserves_rejected_response_and_budget(request_file, tmp_path, fake_model):
    fake_model["response"]["research_questions"][1]["queries"][1] = "https://example.com"
    report = run(request_file, tmp_path, call_model=True, planning_profile=qp.INITIAL_PROFILE)
    folder = Path(report["output_dir"])
    assert report["status"] == "error"
    assert report["validation_message"] == "Search queries must be keywords, not URLs."
    assert report["max_total_queries"] == 3
    assert read(folder / "model_response.json") == fake_model["response"]
    assert read(folder / "planner_input.json")["planning_profile"] == qp.INITIAL_PROFILE
    assert not (folder / "query_plan.json").exists()
    assert len(fake_model["calls"]) == 1


def test_production_diagnostic_saves_failed_output(tmp_path, fake_model, monkeypatch):
    target = tmp_path / "planner-diagnostic.json"
    monkeypatch.setenv("ZHIHU_PLANNER_DIAGNOSTIC_FILE", str(target))
    fake_model["response"] = {"bad_schema": "invalid model data"}
    with pytest.raises(qp.PlannerValidationError):
        qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    report = read(target)
    assert report["status"] == "failed"
    assert report["validation_message"] == "Model output has missing or extra top-level fields."
    assert report["model_response"] == fake_model["response"]
    assert len(fake_model["calls"]) == 1


def test_production_diagnostic_records_deferred_queries(tmp_path, fake_model, monkeypatch):
    target = tmp_path / "planner-diagnostic.json"
    monkeypatch.setenv("ZHIHU_PLANNER_DIAGNOSTIC_FILE", str(target))
    result = qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    report = read(target)
    assert report["status"] == "passed"
    assert report["planned_query_count"] == 3
    assert report["query_selection"] == result["query_selection"]
    assert report["query_selection"]["proposed_query_count"] == 4
    assert report["model_response"] == fake_model["response"]


def test_diagnostic_directory_keeps_failure_and_success_separately(tmp_path, fake_model, monkeypatch):
    root = tmp_path / "private" / "planner"
    monkeypatch.setenv("ZHIHU_PLANNER_DIAGNOSTIC_DIR", str(root))
    fake_model["response"] = {"bad_schema": "model output"}
    with pytest.raises(qp.PlannerValidationError):
        qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    fake_model["response"] = model_plan()
    qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    files = sorted(root.glob("planner-*.json"))
    failed, passed = map(read, files)
    assert len(files) == 2
    assert failed["status"] == "failed" and passed["status"] == "passed"
    assert failed["stage"] == "validation"
    assert failed["validation_message"] == "Model output has missing or extra top-level fields."
    assert failed["input_sha256"] == passed["input_sha256"]
    assert failed["run_id"] != passed["run_id"]
    assert failed["prompts"]["system"] and failed["prompts"]["user"]
    assert len(failed["planner_source_sha256"]) == 64
    assert len(failed["llm_client_source_sha256"]) == 64
    assert failed["new_zhihu_search"] is False
    assert failed["duration_ms"] >= 0
    assert len(fake_model["calls"]) == 2
    if qp.os.name != "nt":
        assert root.stat().st_mode & 0o777 == 0o700
        assert all(path.stat().st_mode & 0o777 == 0o600 for path in files)


@pytest.mark.parametrize("content,finish_reason", [('{"status":', "stop"), ('{"status":"ok"}', "length")])
def test_diagnostic_preserves_raw_output_when_transport_validation_fails(tmp_path, monkeypatch, content, finish_reason):
    monkeypatch.setenv("ZHIHU_PLANNER_DIAGNOSTIC_DIR", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_API_KEY", "private-test-key")
    def send(client, request, **kwargs):
        # The initial record exists before any response arrives.
        initial = read(next(tmp_path.glob("planner-*.json")))
        assert initial["status"] == "running"
        assert initial["input"]["goal"] == GOAL
        return httpx.Response(200, request=request, json={"id": "completion-test",
            "choices": [{"finish_reason": finish_reason, "message": {"content": content}}]})
    monkeypatch.setattr(httpx.Client, "send", send)
    with pytest.raises(llm_client.LLMError):
        qp.plan_research(GOAL, CONTEXT, planning_profile=qp.INITIAL_PROFILE)
    path = next(tmp_path.glob("planner-*.json"))
    report = read(path)
    assert report["status"] == "failed" and report["stage"] == "model_call"
    assert report["transport"]["raw_content"] == content
    assert report["transport"]["finish_reason"] == finish_reason
    assert report["transport"]["response_id"] == "completion-test"
    assert report["transport"]["request"]["max_tokens"] == 2400
    assert "private-test-key" not in path.read_text()
    assert "Authorization" not in path.read_text()


def test_initial_diagnostic_cli_uses_production_prompt(request_file, tmp_path, fake_model, capsys):
    for question in fake_model["response"]["research_questions"]:
        question["queries"] = question["queries"][:1]
    code = qp.main(["--input", str(request_file), "--output-root", str(tmp_path / "out"),
                    "--planning-profile", qp.INITIAL_PROFILE, "--call-model"])
    report = json.loads(capsys.readouterr().out)
    assert code == 0
    assert report["planned_query_count"] == 2
    system, sent, _ = fake_model["calls"][0]
    assert (system, qp._json(sent)) == qp.build_planner_prompts(inputs(planning_profile=qp.INITIAL_PROFILE))
    assert sent["max_total_queries"] == 3
    assert len(fake_model["calls"]) == 1


@pytest.mark.parametrize("error", [llm_client.LLMError("SECRET_SENTINEL"), RuntimeError("SECRET_SENTINEL")])
def test_errors_not_reclassified_and_do_not_leak_exception_text(request_file, tmp_path, fake_model, error):
    fake_model["error"] = error
    report = run(request_file, tmp_path, call_model=True)
    assert report["status"] == "error"
    assert report["error_type"] == type(error).__name__
    assert report["stage"] == "model_call"
    assert len(fake_model["calls"]) == 1
    assert "SECRET_SENTINEL" not in json.dumps(report)
    assert not (Path(report["output_dir"]) / "query_plan.json").exists()


def test_missing_key_has_useful_safe_diagnostic(request_file, tmp_path, monkeypatch):
    def missing(*args, **kwargs):
        raise llm_client.LLMError("Set DEEPSEEK_API_KEY in this terminal before calling the model.")
    monkeypatch.setattr(llm_client, "generate_json", missing)
    report = run(request_file, tmp_path, call_model=True)
    assert report["error_code"] == "missing_api_key"


def test_interrupt_records_distinct_state(request_file, tmp_path, fake_model):
    fake_model["error"] = KeyboardInterrupt()
    report = run(request_file, tmp_path, call_model=True)
    assert report["status"] == "interrupted"
    assert report["planner_calls_attempted"] == 1
    assert not (Path(report["output_dir"]) / "query_plan.json").exists()


def test_needs_clarification_saved_as_valid_outcome(request_file, tmp_path, fake_model):
    fake_model["response"] = {"status": "needs_clarification", "reason": "需要主题。",
        "research_questions": [], "clarification_questions": ["想学习什么？"]}
    report = run(request_file, tmp_path, call_model=True)
    assert report["status"] == "needs_clarification"
    assert read(Path(report["output_dir"]) / "query_plan.json")["clarification_questions"] == ["想学习什么？"]


def test_successive_calls_never_overwrite_previous_run(request_file, tmp_path, fake_model):
    first = run(request_file, tmp_path, call_model=True)
    second = run(request_file, tmp_path, call_model=True)
    assert first["output_dir"] != second["output_dir"]
    assert Path(first["output_dir"], "query_plan.json").is_file()


def test_bom_json_supported(request_file, tmp_path, fake_model):
    request_file.write_text(request_file.read_text(encoding="utf-8"), encoding="utf-8-sig")
    assert run(request_file, tmp_path)["status"] == "dry_run"


@pytest.mark.parametrize("content", ['[]', '{"goal":"x","user_context":{},"raw_results":[]}',
    '{"goal":"x","goal":"y","user_context":{}}', '{"goal":"x","user_context":{"x":NaN}}', 'broken'])
def test_bad_request_file_rejected_before_calls(content, request_file, tmp_path, fake_model):
    request_file.write_text(content, encoding="utf-8")
    with pytest.raises(ValueError):
        run(request_file, tmp_path, call_model=True)
    assert fake_model["calls"] == []


def test_output_failure_before_request_does_not_call(request_file, tmp_path, fake_model):
    (tmp_path / "out").write_text("not a directory", encoding="utf-8")
    with pytest.raises(OSError):
        run(request_file, tmp_path, call_model=True)
    assert fake_model["calls"] == []


def test_call_model_requires_bool_not_truthy_string(request_file, tmp_path, fake_model):
    with pytest.raises(ValueError):
        run(request_file, tmp_path, call_model="False")
    assert fake_model["calls"] == []


def test_cli_dry_run_and_reject_abbreviated_spending_flag(request_file, tmp_path, fake_model, capsys):
    args = ["--input", str(request_file), "--output-root", str(tmp_path / "out")]
    assert qp.main(args) == 0
    assert json.loads(capsys.readouterr().out)["status"] == "dry_run"
    with pytest.raises(SystemExit) as exc:
        qp.main(args + ["--call"])
    assert exc.value.code == 2
    assert fake_model["calls"] == []


def test_cli_error_exit_is_nonzero(request_file, tmp_path, fake_model, capsys):
    fake_model["response"] = {"broken": True}
    assert qp.main(["--input", str(request_file), "--call-model", "--output-root", str(tmp_path / "out")]) == 1
    assert json.loads(capsys.readouterr().out)["status"] == "error"


def test_no_zhihu_or_evidence_imports_in_new_module():
    import ast
    tree = ast.parse(Path(qp.__file__).read_text(encoding="utf-8"))
    imports = [ast.unparse(node) for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert not any(token in imp for imp in imports for token in ("zhihu_client", "evidence_compiler", "ranker", "subprocess"))


def test_existing_llm_client_transport_integration_without_network(request_file, tmp_path, monkeypatch):
    """Use the real existing generate_json, replacing only HTTP send."""
    requests = []
    sentinel = "DUMMY_TEST_KEY_NEVER_REAL"
    monkeypatch.setenv("DEEPSEEK_API_KEY", sentinel)
    def send(client, request, **kwargs):
        requests.append(request)
        body = json.loads(request.content)
        assert body["model"] == llm_client.MODEL
        assert body["response_format"] == {"type": "json_object"}
        assert body["thinking"] == {"type": "disabled"}
        assert json.loads(body["messages"][1]["content"]) == inputs()
        return httpx.Response(200, request=request, json={"choices": [{
            "finish_reason": "stop", "message": {"content": json.dumps(model_plan(), ensure_ascii=False)}
        }]})
    monkeypatch.setattr(httpx.Client, "send", send)
    report = run(request_file, tmp_path, call_model=True)
    assert report["status"] == "ready_for_review"
    assert len(requests) == 1
    for path in Path(report["output_dir"]).iterdir():
        assert sentinel not in path.read_text(encoding="utf-8")


@pytest.mark.parametrize("error_message,code", [
    ("DeepSeek HTTP 401. Check key, account balance, or service status.", "llm_http_401"),
    ("DeepSeek request timed out. No automatic retry was performed.", "llm_timeout"),
    ("DeepSeek finish_reason was not 'stop'; output rejected.", "llm_output_not_complete"),
])
def test_known_llm_errors_have_safe_diagnostic_codes(request_file, tmp_path, fake_model, error_message, code):
    fake_model["error"] = llm_client.LLMError(error_message)
    report = run(request_file, tmp_path, call_model=True)
    assert report["error_code"] == code
    assert report["status"] == "error"
    assert len(fake_model["calls"]) == 1


def test_negative_control_structural_checks_do_not_prove_topic_relevance():
    """Document a limitation rather than implying schema tests evaluate relevance."""
    result = qp.validate_plan_response(model_plan(), qp.build_planner_input("学习种植番茄。", {}))
    assert result["status"] == "ready_for_review"
    assert result["semantic_quality_checked"] is False
    assert result["human_approved"] is False


def baseline_model_plan():
    payload = model_plan()
    payload["research_questions"].append({
        "research_question": "Agent 初学项目有哪些常见风险和限制？", "evidence_need": "risk",
        "why_needed": "了解实现边界。", "queries": ["Agent 初学 风险", "智能体 项目 限制"],
    })
    return payload


@pytest.mark.parametrize("mutation", ["two_questions", "one_query", "duplicate"])
def test_baseline_rejects_incomplete_or_duplicate_without_retry(fake_model, mutation):
    payload = baseline_model_plan()
    if mutation == "two_questions":
        payload["research_questions"].pop()
    elif mutation == "one_query":
        payload["research_questions"][0]["queries"].pop()
    else:
        payload["research_questions"][2]["queries"][0] = payload["research_questions"][0]["queries"][0]
    fake_model["response"] = payload
    with pytest.raises(qp.PlannerValidationError):
        qp.plan_research(GOAL, CONTEXT, planning_profile="jia-p0-baseline")
    assert len(fake_model["calls"]) == 1


def test_baseline_exact_counts_and_prompt(fake_model):
    fake_model["response"] = baseline_model_plan()
    result = qp.plan_research(GOAL, CONTEXT, planning_profile="jia-p0-baseline")
    assert result["planned_query_count"] == 6
    assert result["human_approved"] is result["coverage_verified"] is False
    prompt, sent, _ = fake_model["calls"][0]
    assert "恰好3个" in prompt and "恰好2条" in prompt
    assert sent["planning_profile"] == "jia-p0-baseline"


def test_baseline_preserves_clarification(fake_model):
    fake_model["response"] = {"status": "needs_clarification", "reason": "缺少对象",
        "research_questions": [], "clarification_questions": ["研究什么？"]}
    result = qp.plan_research(GOAL, {}, planning_profile="jia-p0-baseline")
    assert result["status"] == "needs_clarification"
    assert result["planned_query_count"] == 0
    assert len(fake_model["calls"]) == 1


@pytest.mark.parametrize("options", [{"planning_profile": "unknown"},
    {"planning_profile": "jia-p0-baseline", "max_questions": 2},
    {"planning_profile": "jia-p0-baseline", "queries_per_question": 1}])
def test_profile_options_validate_before_model(fake_model, options):
    with pytest.raises(ValueError):
        qp.plan_research(GOAL, CONTEXT, **options)
    assert not fake_model["calls"]
