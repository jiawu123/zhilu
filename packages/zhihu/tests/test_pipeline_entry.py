"""Offline entry tests. Use the real query_planner; replace only its LLM client.

No real API calls. The temporary module is isolated so other project tests keep
using their original modules. Run from packages/zhihu with:
    python -m pytest tests/test_pipeline_entry.py -q
"""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import types

import pytest
import zhihu_m2
from zhihu_m2 import pipeline

REQUEST = {
    "goal": "8周内完成一个可运行、带基本测试的 Agent 小项目。",
    "user_context": {"python_level": "beginner", "weekly_hours": 10},
}
MODEL_RESPONSE = {
    "status": "ok", "reason": "研究检查程序逻辑的方法。",
    "research_questions": [{
        "research_question": "如何检查 Agent 程序的运行逻辑？",
        "evidence_need": "verification", "why_needed": "为项目确定测试方法。",
        "queries": ["Agent 程序 逻辑 测试 方法"],
    }],
    "clarification_questions": [],
}


@pytest.fixture
def planner_backend(monkeypatch):
    """Load uploaded production planner with an isolated, offline LLM seam."""
    fake = types.ModuleType("zhihu_m2.llm_client")
    fake.MODEL = "offline-test-only"
    fake.LLMError = type("LLMError", (RuntimeError,), {})
    state = types.SimpleNamespace(calls=[], response=copy.deepcopy(MODEL_RESPONSE),
                                  error=None, noise=False)

    def generate_json(*args, **kwargs):
        state.calls.append((args, kwargs))
        if state.noise:
            print("ordinary backend diagnostic")
        if state.error is not None:
            raise state.error
        return copy.deepcopy(state.response)

    fake.generate_json = generate_json
    monkeypatch.setitem(sys.modules, "zhihu_m2.llm_client", fake)
    monkeypatch.setattr(zhihu_m2, "llm_client", fake, raising=False)
    path = Path(pipeline.__file__).with_name("query_planner.py")
    spec = importlib.util.spec_from_file_location("_entry_test_planner", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(pipeline, "_load_planner", lambda: module)
    state.module = module
    state.client = fake
    return state


def invoke(monkeypatch, capsys, request=REQUEST, argv=None, *, raw=None):
    text = json.dumps(request, ensure_ascii=False) if raw is None else raw
    monkeypatch.setattr(sys, "stdin", io.StringIO(text))
    rc = pipeline.main(["--action", "plan"] if argv is None else argv)
    streams = capsys.readouterr()
    return rc, json.loads(streams.out), streams.err


def test_entry_exposes_callable_main():
    assert callable(getattr(pipeline, "main", None))


def test_live_plan_calls_existing_planner_once(monkeypatch, capsys, planner_backend):
    rc, body, _ = invoke(monkeypatch, capsys)
    assert rc == 0 and body["ok"] is True
    assert body["action"] == "plan"
    assert body["protocol_version"] == "m2-entry-v0.1"
    assert body["data"]["status"] == "ready_for_review"
    assert body["data"]["human_approved"] is False
    assert body["data"]["queries_executed"] is False
    assert body["data"]["evidence_compilation_performed"] is False
    assert body["data"]["research_questions"][0]["question_id"].startswith("rq_")
    assert body["error"] is None
    assert body["metrics"]["planner_calls_attempted"] == 1
    assert len(planner_backend.calls) == 1


def test_dry_run_is_explicit_and_makes_no_model_call(monkeypatch, capsys, planner_backend):
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--dry-run"])
    assert rc == 0 and body["data"]["status"] == "dry_run"
    assert body["metrics"]["planner_calls_attempted"] == 0
    assert planner_backend.calls == []


def test_clarification_is_not_evidence_or_approval(monkeypatch, capsys, planner_backend):
    planner_backend.response = {"status": "needs_clarification", "reason": "目标对象不清楚。",
                                "research_questions": [],
                                "clarification_questions": ["你希望完成哪种项目？"]}
    rc, body, _ = invoke(monkeypatch, capsys)
    assert rc == 0 and body["ok"]
    assert body["data"]["status"] == "needs_clarification"
    assert body["data"]["research_questions"] == []
    assert len(planner_backend.calls) == 1


@pytest.mark.parametrize("payload", [
    {"goal": "x"}, {"goal": "x", "user_context": {}, "request_id": "extra"},
    {"goal": "", "user_context": {}}, {"goal": " ", "user_context": {}},
    {"goal": 5, "user_context": {}}, {"goal": "x", "user_context": []},
    {"goal": "x", "user_context": {"nested": {"Authorization": "PRIVATE"}}},
    {"goal": "x", "user_context": {"api_key": "PRIVATE"}},
    {"goal": "x" * 2001, "user_context": {}},
])
def test_invalid_plan_input_stops_before_paid_call(monkeypatch, capsys, planner_backend, payload):
    rc, body, _ = invoke(monkeypatch, capsys, request=payload)
    assert rc == 2 and body["error"]["code"] == "invalid_request"
    assert not body["ok"] and body["data"] is None
    assert planner_backend.calls == []


@pytest.mark.parametrize("raw", ["", "{", '[]', 'null',
    '{"goal":"x","goal":"y","user_context":{}}',
    '{"goal":"x","user_context":{"n":NaN}}',
    '{"goal":"x","user_context":{"n":Infinity}}',
    '{"goal":"x","user_context":{"n":1e999}}',
    '{"goal":"x","user_context":{"x":1,"x":2}}',
    '{"goal":"x","user_context":{}} {}',
    '{"goal":"\\ud800","user_context":{}}',
])
def test_invalid_json_is_rejected(monkeypatch, capsys, planner_backend, raw):
    rc, body, _ = invoke(monkeypatch, capsys, raw=raw)
    assert rc == 2 and not body["ok"]
    assert planner_backend.calls == []


def test_oversized_request_is_rejected(monkeypatch, capsys, planner_backend):
    rc, body, _ = invoke(monkeypatch, capsys, raw=" " * 64001)
    assert rc == 2 and body["error"]["code"] == "input_too_large"
    assert planner_backend.calls == []


def test_utf8_bom_is_accepted(monkeypatch, capsys, planner_backend):
    raw = "\ufeff" + json.dumps(REQUEST, ensure_ascii=False)
    rc, body, _ = invoke(monkeypatch, capsys, raw=raw)
    assert rc == 0 and body["data"]["goal"] == REQUEST["goal"]


def test_backend_stdout_diagnostics_are_redirected(monkeypatch, capsys, planner_backend):
    planner_backend.noise = True
    rc, body, stderr = invoke(monkeypatch, capsys)
    assert rc == 0 and body["ok"]
    assert "ordinary backend diagnostic" in stderr


def test_model_validation_error_is_not_no_evidence(monkeypatch, capsys, planner_backend):
    planner_backend.response = {"unexpected": "PRIVATE"}
    rc, body, stderr = invoke(monkeypatch, capsys)
    assert rc == 1 and body["error"]["code"] == "invalid_plan_output"
    assert body["data"] is None and len(planner_backend.calls) == 1
    assert "PRIVATE" not in json.dumps(body) + stderr


def test_llm_error_is_sanitized_and_not_retried(monkeypatch, capsys, planner_backend):
    planner_backend.error = planner_backend.client.LLMError("PRIVATE API KEY")
    rc, body, stderr = invoke(monkeypatch, capsys)
    assert rc == 1 and body["error"]["code"] == "llm_error"
    assert len(planner_backend.calls) == 1
    assert "PRIVATE" not in json.dumps(body) + stderr


def test_unknown_backend_exception_is_sanitized(monkeypatch, capsys, planner_backend):
    planner_backend.error = RuntimeError("PRIVATE TOKEN")
    rc, body, stderr = invoke(monkeypatch, capsys)
    assert rc == 1 and body["error"]["code"] == "execution_error"
    assert "PRIVATE" not in json.dumps(body) + stderr
    assert len(planner_backend.calls) == 1


def test_keyboard_interrupt_is_nonzero(monkeypatch, capsys, planner_backend):
    planner_backend.error = KeyboardInterrupt()
    rc, body, _ = invoke(monkeypatch, capsys)
    assert rc == 130 and body["error"]["code"] == "interrupted"


def test_research_invalid_request_never_calls_planner(monkeypatch, capsys):
    def forbidden():
        pytest.fail("research must not import/call the planner")
    monkeypatch.setattr(pipeline, "_load_planner", forbidden)
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "research"])
    assert rc == 2 and not body["ok"]
    assert body["data"] is None
    assert body["error"]["code"] == "invalid_request"
    assert body["metrics"]["planner_calls_attempted"] == 0


def test_missing_dependency_is_json_error(monkeypatch, capsys):
    def missing():
        raise ModuleNotFoundError("PRIVATE LOCAL PATH")
    monkeypatch.setattr(pipeline, "_load_planner", missing)
    rc, body, stderr = invoke(monkeypatch, capsys)
    assert rc == 1 and body["error"]["code"] == "dependency_unavailable"
    assert "PRIVATE" not in json.dumps(body) + stderr


@pytest.mark.parametrize("argv", [[], ["--action", "bad"],
    ["--action", "plan", "--private-unknown", "PRIVATE"],
    ["--action", "plan", "--max-questions", "4"],
    ["--action", "plan", "--queries-per-question", "3"]])
def test_invalid_arguments_return_json(monkeypatch, capsys, argv):
    rc, body, stderr = invoke(monkeypatch, capsys, argv=argv)
    assert rc == 2 and body["error"]["code"] == "invalid_arguments"
    assert "PRIVATE" not in json.dumps(body) + stderr


def test_file_input_and_utf8_output(monkeypatch, capsys, planner_backend, tmp_path):
    source = tmp_path / "request.json"
    target = tmp_path / "output" / "plan.json"
    source.write_text(json.dumps(REQUEST, ensure_ascii=False), encoding="utf-8-sig")
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--input", str(source),
                                                    "--output", str(target)])
    assert rc == 0
    assert json.loads(target.read_text(encoding="utf-8")) == body
    assert not target.read_bytes().startswith(b"\xef\xbb\xbf")


def test_dont_overwrite_request_file(monkeypatch, capsys, planner_backend, tmp_path):
    source = tmp_path / "request.json"
    original = json.dumps(REQUEST, ensure_ascii=False)
    source.write_text(original, encoding="utf-8")
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--input", str(source),
                                                    "--output", str(source)])
    assert rc == 2 and body["error"]["code"] == "invalid_arguments"
    assert source.read_text(encoding="utf-8") == original
    assert planner_backend.calls == []


def test_unwritable_output_stops_before_model(monkeypatch, capsys, planner_backend, tmp_path):
    blocker = tmp_path / "not_a_directory"
    blocker.write_text("x", encoding="utf-8")
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--output", str(blocker / "x.json")])
    assert rc == 1 and body["error"]["code"] == "output_io_error"
    assert planner_backend.calls == []


def test_missing_input_file_is_nonzero(monkeypatch, capsys, planner_backend, tmp_path):
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--input", str(tmp_path / "missing.json")])
    assert rc == 2 and body["error"]["code"] == "input_io_error"
    assert planner_backend.calls == []


def test_unique_run_ids(monkeypatch, capsys, planner_backend):
    _, first, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--dry-run"])
    _, second, _ = invoke(monkeypatch, capsys, argv=["--action", "plan", "--dry-run"])
    assert first["run_id"] != second["run_id"]


def test_real_subprocess_stdin_protocol_has_no_external_calls():
    root = Path(pipeline.__file__).resolve().parents[1]
    env = dict(os.environ, PYTHONPATH=str(root))
    completed = subprocess.run(
        [sys.executable, "-X", "utf8", "-u", "-m", "zhihu_m2.pipeline", "--action", "research"],
        input=json.dumps(REQUEST, ensure_ascii=False).encode("utf-8"),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=root, env=env, timeout=10,
    )
    body = json.loads(completed.stdout.decode("utf-8"))
    assert completed.returncode == 2
    assert body["error"]["code"] == "invalid_request"
    assert body["data"] is None


@pytest.mark.parametrize("code", [0, 7])
def test_backend_systemexit_is_not_protocol_success(monkeypatch, capsys, planner_backend, code):
    planner_backend.error = SystemExit(code)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps(REQUEST)))
    rc = pipeline.main(["--action", "plan"])
    streams = capsys.readouterr()
    assert streams.out, "A backend exit must still produce an error JSON response"
    body = json.loads(streams.out)
    assert rc == 1 and body["error"]["code"] == "execution_error"


def test_final_file_write_failure_is_not_success(monkeypatch, capsys, planner_backend, tmp_path):
    def unavailable(*args, **kwargs):
        raise OSError("PRIVATE DEVICE DETAILS")
    monkeypatch.setattr(Path, "replace", unavailable)
    rc, body, stderr = invoke(monkeypatch, capsys, argv=["--action", "plan", "--output", str(tmp_path / "out.json")])
    assert rc == 1 and body["error"]["code"] == "output_io_error"
    assert "PRIVATE" not in json.dumps(body) + stderr
    assert len(planner_backend.calls) == 1


def test_help_is_available_without_planner(monkeypatch, capsys):
    def forbidden():
        pytest.fail("--help must not import the planner")
    monkeypatch.setattr(pipeline, "_load_planner", forbidden)
    assert pipeline.main(["--help"]) == 0
    streams = capsys.readouterr()
    assert "--action" in streams.out


@pytest.mark.parametrize("options", [["--dry-run"], ["--max-questions", "3"],
    ["--queries-per-question", "2"], ["--planning-profile", "jia-p0-baseline"]])
def test_research_rejects_plan_flags(monkeypatch, capsys, options):
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "research"] + options)
    assert rc == 2 and body["error"]["code"] == "invalid_arguments"


def test_pipeline_baseline_rejects_short_plan(monkeypatch, capsys, planner_backend):
    rc, body, _ = invoke(monkeypatch, capsys,
        argv=["--action", "plan", "--planning-profile", "jia-p0-baseline"])
    assert rc == 1 and body["error"]["code"] == "invalid_plan_output"
    assert len(planner_backend.calls) == 1


def test_pipeline_baseline_clarification_zero_search(monkeypatch, capsys, planner_backend):
    planner_backend.response = {"status": "needs_clarification", "reason": "缺少主题",
        "research_questions": [], "clarification_questions": ["研究什么？"]}
    rc, body, _ = invoke(monkeypatch, capsys,
        argv=["--action", "plan", "--planning-profile", "jia-p0-baseline"])
    assert rc == 0 and body["data"]["status"] == "needs_clarification"
    assert body["metrics"]["search_calls_attempted"] == 0


@pytest.fixture
def research_backend(monkeypatch):
    class ResearchError(ValueError):
        def __init__(self, code, exit_code=1):
            self.code, self.exit_code = code, exit_code
            super().__init__("PRIVATE SECRET")
    state = types.SimpleNamespace(calls=[], error=None)
    def execute(payload, *, metrics):
        state.calls.append(payload)
        metrics.update(search_calls_attempted=2, compiler_calls_attempted=1,
                       candidate_count=3, evidence_count=0)
        print("ordinary research diagnostic")
        if state.error:
            raise state.error
        return {"requestId": "rq-test", "status": "no_evidence", "compilerOutputs": [],
                "routeCandidates": [], "unresolvedQuestions": ["没有适用证据"], "issues": []}
    backend = types.SimpleNamespace(ResearchError=ResearchError, run_research=execute)
    monkeypatch.setattr(pipeline, "_load_research_runner", lambda: backend)
    state.error_type = ResearchError
    return state


def test_research_protocol_metrics_and_output_file(monkeypatch, capsys, research_backend, tmp_path):
    target = tmp_path / "研究.json"
    source = tmp_path / "请求.json"
    source.write_text(json.dumps(REQUEST, ensure_ascii=False), encoding="utf-8")
    rc, body, err = invoke(monkeypatch, capsys, argv=["--action", "research",
        "--input", str(source), "--output", str(target)])
    assert rc == 0 and body["ok"]
    assert body["data"]["status"] == "no_evidence"
    assert body["metrics"]["search_calls_attempted"] == 2
    assert body["metrics"]["compiler_calls_attempted"] == 1
    assert body["metrics"]["planner_calls_attempted"] == 0
    assert "ordinary research diagnostic" in err
    assert json.loads(target.read_text(encoding="utf-8")) == body


@pytest.mark.parametrize("code", ["invalid_request", "input_too_large", "dependency_unavailable",
    "authentication_failed", "configuration_error", "rate_or_quota_limit", "research_failed",
    "compilation_failed", "research_timeout", "execution_error", "evidence_id_conflict", "PRIVATE_UNKNOWN"])
def test_research_errors_are_allowlisted(monkeypatch, capsys, research_backend, code):
    research_backend.error = research_backend.error_type(code, 2 if code in {"invalid_request", "input_too_large"} else 1)
    rc, body, err = invoke(monkeypatch, capsys, argv=["--action", "research"])
    assert rc != 0 and not body["ok"] and body["data"] is None
    assert body["error"]["code"] == ("execution_error" if code == "PRIVATE_UNKNOWN" else code)
    assert "PRIVATE" not in json.dumps(body) + err
    assert len(research_backend.calls) == 1


@pytest.mark.parametrize("error,code,rc", [(RuntimeError("PRIVATE"), "execution_error", 1),
    (KeyboardInterrupt(), "interrupted", 130), (SystemExit(0), "execution_error", 1)])
def test_research_unknown_errors_and_interrupts(monkeypatch, capsys, research_backend, error, code, rc):
    research_backend.error = error
    actual, body, err = invoke(monkeypatch, capsys, argv=["--action", "research"])
    assert actual == rc and body["error"]["code"] == code
    assert "PRIVATE" not in json.dumps(body) + err


def test_research_late_output_failure_preserves_old_file_but_reports_failure(monkeypatch, capsys, research_backend, tmp_path):
    target = tmp_path / "old.json"
    target.write_text("old result", encoding="utf-8")
    def unavailable(*args, **kwargs):
        raise OSError("PRIVATE")
    monkeypatch.setattr(Path, "replace", unavailable)
    rc, body, err = invoke(monkeypatch, capsys, argv=["--action", "research", "--output", str(target)])
    assert rc == 1 and body["error"]["code"] == "output_io_error"
    assert "may have occurred" in body["error"]["message"]
    assert target.read_text(encoding="utf-8") == "old result"
    assert len(research_backend.calls) == 1


@pytest.mark.parametrize("raw,code", [('{"request":{},"request":{}}', "invalid_json"),
    ('{"request":{"x":Infinity}}', "invalid_json"), (" " * 64001, "input_too_large")],
    ids=["duplicate-key", "non-finite", "over-size"])
def test_research_bad_json_no_runner_call(monkeypatch, capsys, research_backend, raw, code):
    rc, body, _ = invoke(monkeypatch, capsys, argv=["--action", "research"], raw=raw)
    assert rc == 2 and body["error"]["code"] == code
    assert not research_backend.calls


def test_help_does_not_load_research(monkeypatch, capsys):
    def forbidden():
        pytest.fail("help cannot initialize research")
    monkeypatch.setattr(pipeline, "_load_research_runner", forbidden)
    assert pipeline.main(["--help"]) == 0
    assert "--planning-profile" in capsys.readouterr().out
