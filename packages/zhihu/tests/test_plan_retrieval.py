"""Offline checks. Mock only the subprocess/search boundary; never use credentials."""
import copy
import hashlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from zhihu_m2 import plan_retrieval as m


def make_plan():
    plan = {
        "planner_version": "m2-query-planner-v0.1.0",
        "status": "ready_for_review", "human_approved": False,
        "semantic_quality_checked": False, "queries_executed": False,
        "goal": "完成一个带基本测试的 Agent 项目。",
        "user_context": {"python_level": "beginner", "is_demo": True},
        "limits": {"max_questions": 3, "queries_per_question": 2},
        "research_questions": [], "clarification_questions": [],
        "planned_query_count": 6,
    }
    for index, focus in enumerate(["实现路线", "自动化测试", "开发风险"]):
        question = f"Python 初学者的 Agent 项目有哪些{focus}？"
        identity = {"goal": plan["goal"], "user_context": plan["user_context"],
                    "research_question": question}
        digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False,
                             sort_keys=True, allow_nan=False).encode()).hexdigest()[:16]
        plan["research_questions"].append({
            "question_id": "rq_" + digest, "research_question": question,
            "evidence_need": ["method", "verification", "risk"][index],
            "why_needed": f"寻找{focus}依据。",
            "queries": [f"Python Agent {focus}", f"智能体 {focus} 实践"],
        })
    return plan


def write_plan(tmp_path, plan=None):
    p = tmp_path / "query_plan.json"
    p.write_text(json.dumps(make_plan() if plan is None else plan, ensure_ascii=False), encoding="utf-8")
    return p


def item(content_id="123", text="第一步调用模型。\r\n第二步测试。", title="同一标题"):
    return {"ContentType": "Answer", "ContentID": content_id, "Title": title,
            "ContentText": text, "Url": "https://www.zhihu.com/test?utm_source=demo",
            "AuthorName": "测试作者", "VoteUpCount": 3}


def response(*items):
    return {"Code": 0, "Message": "success", "Data": {
        "Items": list(items), "HasMore": False, "SearchHashId": "fixture"}}


def read(p):
    return json.loads(p.read_text(encoding="utf-8"))


def run(tmp_path, monkeypatch, fetch):
    monkeypatch.setattr(m, "search_once", fetch)
    return m.retrieve_plan(write_plan(tmp_path), output_root=tmp_path / "runs", interval=0)


def test_tasks_preserve_questions_queries_and_input(tmp_path):
    plan = make_plan(); frozen = copy.deepcopy(plan)
    checked, tasks = m.load_plan(write_plan(tmp_path, plan))
    assert checked == frozen == plan
    assert len(tasks) == 6
    assert [t["query"] for t in tasks] == [q for x in plan["research_questions"] for q in x["queries"]]
    assert tasks[0]["research_question"] == plan["research_questions"][0]["research_question"]
    assert len({t["query_id"] for t in tasks}) == 6


@pytest.mark.parametrize("mutate", [
    lambda p: p.update(status="needs_clarification"),
    lambda p: p.update(planned_query_count=7),
    lambda p: p.update(research_questions=[]),
    lambda p: p.update(goal=""),
    lambda p: p.update(user_context=[]),
    lambda p: p["research_questions"][0].update(question_id="../../bad"),
    lambda p: p["research_questions"][0].update(queries=[]),
    lambda p: p["research_questions"][0].update(queries=["a", "b", "c"]),
    lambda p: p["research_questions"][0].update(queries=["--help"]),
    lambda p: p["research_questions"][0].update(queries=["a\nb"]),
    lambda p: p["research_questions"][0].update(queries=["https://example.com"]),
    lambda p: p["research_questions"][0].update(queries=["Agent", "agent"]),
    lambda p: p["research_questions"][0].update(evidence_need="verified"),
    lambda p: p.update(research_questions=p["research_questions"] * 2),
    lambda p: p["research_questions"][0].update(research_question="被修改的问题和旧的ID不匹配？"),
])
def test_invalid_plans_fail_before_any_request(tmp_path, monkeypatch, mutate):
    plan = make_plan(); mutate(plan)
    def forbidden(*a, **k):
        raise AssertionError("must not send a request")
    monkeypatch.setattr(m, "search_once", forbidden)
    with pytest.raises(ValueError):
        m.retrieve_plan(write_plan(tmp_path, plan), output_root=tmp_path / "runs", interval=0)
    assert not (tmp_path / "runs").exists()


@pytest.mark.parametrize("count", [0, 11, True, 1.5])
def test_bad_count_rejected(tmp_path, count):
    with pytest.raises(ValueError):
        m.retrieve_plan(write_plan(tmp_path), count=count, output_root=tmp_path / "runs")


@pytest.mark.parametrize("timeout", [0, -1, True, float("nan"), float("inf")])
def test_invalid_timeout_rejected(tmp_path, timeout):
    with pytest.raises(ValueError):
        m.retrieve_plan(write_plan(tmp_path), timeout=timeout, output_root=tmp_path / "runs")


def test_six_live_attempts_no_extra_queries_and_old_plan_unchanged(tmp_path, monkeypatch):
    calls = []
    def fetch(query, count, timeout):
        calls.append((query, count, timeout)); return response(item())
    run_dir = run(tmp_path, monkeypatch, fetch)
    manifest = read(run_dir / "manifest.json")
    assert len(calls) == manifest["search_calls_attempted"] == 6
    assert all(x[1] == 10 for x in calls)
    assert manifest["status"] == "completed"
    assert manifest["counts"] == {"ok": 6, "no_results": 0, "error": 0, "not_processed": 0}
    assert manifest["llm_calls_attempted"] == 0
    assert read(run_dir / "query_plan.json")["human_approved"] is False
    assert read(run_dir / "query_plan.json")["queries_executed"] is False


def test_identity_variants_and_per_question_links(tmp_path, monkeypatch):
    counter = 0
    def fetch(*a, **k):
        nonlocal counter
        counter += 1
        return response(item(text="原摘要 A" if counter % 2 else "原摘要 B"))
    d = run(tmp_path, monkeypatch, fetch)
    data = read(d / "retrieval_results.json")
    assert len(data["occurrences"]) == 6
    assert len(data["sources"]) == 1
    assert len(data["snippet_variants"]) == 2
    assert len(data["sources"][0]["question_ids"]) == 3
    assert all(len(q["occurrence_ids"]) == 2 for q in data["questions"])
    for o in data["occurrences"]:
        assert o["raw_item"]["ContentText"] in {"原摘要 A", "原摘要 B"}
        assert o["snippet_sha256"] == hashlib.sha256(o["raw_item"]["ContentText"].encode()).hexdigest()
        assert o["retrieved_at"].endswith("+00:00")


def test_identical_titles_are_not_deduplicated(tmp_path, monkeypatch):
    d = run(tmp_path, monkeypatch, lambda *a, **k: response(item("1"), item("2")))
    data = read(d / "retrieval_results.json")
    assert len(data["sources"]) == 2
    assert len(data["occurrences"]) == 12


def test_missing_ids_not_merged_and_bad_items_retained_in_raw(tmp_path, monkeypatch):
    bad = item(); del bad["ContentID"]
    d = run(tmp_path, monkeypatch, lambda *a, **k: response(bad, item(None), None))
    data = read(d / "retrieval_results.json")
    assert len(data["sources"]) == 12
    assert len(data["malformed_items"]) == 6
    assert read(d / "queries" / "001.json")["raw_response"]["Data"]["Items"][2] is None
    assert all(o["has_source_identity"] is False for o in data["occurrences"])


def test_numeric_ids_negative_ids_and_missing_text(tmp_path, monkeypatch):
    one = item(-42); two = item("x"); two["ContentText"] = None
    d = run(tmp_path, monkeypatch, lambda *a, **k: response(one, two))
    data = read(d / "retrieval_results.json")
    assert {s["source_id"] for s in data["sources"]} == {"zhihu:Answer:-42", "zhihu:Answer:x"}
    empty = [o for o in data["occurrences"] if o["source_id"].endswith(":x")]
    assert all("snippet_missing_or_invalid" in o["issues"] and o["raw_item"]["ContentText"] is None for o in empty)


def test_empty_searches_are_not_errors(tmp_path, monkeypatch):
    d = run(tmp_path, monkeypatch, lambda *a, **k: response())
    report = read(d / "manifest.json")
    assert report["counts"]["no_results"] == 6
    assert report["counts"]["error"] == 0
    assert report["status"] == "completed"
    assert read(d / "retrieval_results.json")["occurrences"] == []


def test_network_error_recorded_others_continue_without_retry(tmp_path, monkeypatch):
    calls = []
    def fetch(query, **k):
        calls.append(query)
        if len(calls) == 1: raise m.SearchError("network_error")
        return response(item())
    d = run(tmp_path, monkeypatch, fetch)
    report = read(d / "manifest.json")
    assert len(calls) == 6 and len(set(calls)) == 6
    assert report["status"] == "completed_with_errors"
    assert report["counts"] == {"ok": 5, "no_results": 0, "error": 1, "not_processed": 0}


@pytest.mark.parametrize("kind", ["authentication", "rate_or_quota_limit", "cli_unavailable"])
def test_blocking_errors_stop_remaining_queries(tmp_path, monkeypatch, kind):
    calls = []
    def fetch(query, **k): calls.append(query); raise m.SearchError(kind)
    d = run(tmp_path, monkeypatch, fetch)
    report = read(d / "manifest.json")
    assert len(calls) == 1
    assert report["status"] == "stopped"
    assert report["counts"] == {"ok": 0, "no_results": 0, "error": 1, "not_processed": 5}
    assert all(t["not_processed_reason"] == kind for t in report["outcomes"][1:])


def test_unexpected_error_recorded_without_leaking_message(tmp_path, monkeypatch):
    def fetch(*a, **k): raise RuntimeError("secret-forbidden-in-log")
    d = run(tmp_path, monkeypatch, fetch)
    report = read(d / "manifest.json")
    assert report["status"] == "failed"
    assert report["counts"]["not_processed"] == 5
    assert "secret-forbidden-in-log" not in "".join(
    x.read_text(encoding="utf-8")
    for x in d.rglob("*.json")
)


def test_keyboard_interrupt_records_and_stops(tmp_path, monkeypatch):
    def fetch(*a, **k): raise KeyboardInterrupt
    d = run(tmp_path, monkeypatch, fetch)
    report = read(d / "manifest.json")
    assert report["status"] == "interrupted"
    assert report["counts"]["not_processed"] == 5
    assert report["search_calls_attempted"] == 1


def test_two_runs_use_distinct_folders(tmp_path, monkeypatch):
    monkeypatch.setattr(m, "search_once", lambda *a, **k: response())
    p = write_plan(tmp_path)
    d1 = m.retrieve_plan(p, output_root=tmp_path / "runs", interval=0)
    before = (d1 / "manifest.json").read_bytes()
    d2 = m.retrieve_plan(p, output_root=tmp_path / "runs", interval=0)
    assert d1 != d2 and (d1 / "manifest.json").read_bytes() == before


def test_cli_default_is_live_no_extra_confirmation(tmp_path, monkeypatch, capsys):
    calls = []
    def fetch(query, **kwargs): calls.append(query); return response()
    monkeypatch.setattr(m, "search_once", fetch)
    rc = m.main(["--plan", str(write_plan(tmp_path)), "--output-root", str(tmp_path / "runs"), "--interval", "0"])
    assert rc == 0 and len(calls) == 6
    assert "6/6" in capsys.readouterr().out


def test_optional_dry_run_never_imports_cli_or_creates_output(tmp_path, monkeypatch):
    def forbidden(*a, **k): raise AssertionError
    monkeypatch.setattr(m, "search_once", forbidden)
    assert m.main(["--plan", str(write_plan(tmp_path)), "--dry-run", "--output-root", str(tmp_path / "runs")]) == 0
    assert not (tmp_path / "runs").exists()


def test_response_is_saved_before_next_search(tmp_path, monkeypatch):
    called = 0
    def fetch(*a, **k):
        nonlocal called
        called += 1
        if called > 1:
            paths = list((tmp_path / "runs").glob("*/queries/001.json"))
            assert len(paths) == 1 and read(paths[0])["raw_response"]["Code"] == 0
        return response(item())
    run(tmp_path, monkeypatch, fetch)


def completed(payload, rc=0):
    return SimpleNamespace(returncode=rc, stdout=json.dumps(payload, ensure_ascii=False).encode("utf-8"), stderr=b"never-log-raw-stderr")


def test_subprocess_has_no_shell_preserves_bytes_and_timeout(monkeypatch, tmp_path):
    path = tmp_path / "zhihu-cli.exe"; path.touch()
    monkeypatch.setattr(m, "_cli_path", lambda: path)
    query = "Python 测试; $(echo nope)"
    def fake(command, **kwargs):
        assert command == [str(path), "search", "zhihu", "--query", query, "--count", "10"]
        assert kwargs["shell"] is False and kwargs["timeout"] == 45
        assert kwargs["stdin"] == subprocess.DEVNULL
        assert "text" not in kwargs or kwargs["text"] is False
        return completed(response(item()))
    monkeypatch.setattr(m.subprocess, "run", fake)
    assert m.search_once(query, count=10, timeout=45)["Data"]["Items"][0]["ContentText"] == item()["ContentText"]


@pytest.mark.parametrize("payload,rc,kind", [
    ({"ok": False, "error": {"code": "AUTH_REQUIRED", "message": "secret-value"}}, 3, "authentication"),
    ({"Code": 30001, "Message": "rate"}, 0, "rate_or_quota_limit"),
    ({"Code": 30002}, 4, "rate_or_quota_limit"),
    ({"Code": 20001}, 0, "authentication"),
    ({"ok": False, "error": {"code": "TIMEOUT"}}, 5, "network_error"),
    ({"Code": 500}, 6, "upstream_error"),
    ({"Code": 0, "Data": {}}, 0, "invalid_response"),
    ({"Code": 0, "Data": {"Items": None}}, 0, "invalid_response"),
    ({"Code": False, "Data": {"Items": []}}, 0, "invalid_response"),
    ({"Code": 0, "Data": {"Items": []}}, 3, "authentication"),
])
def test_cli_error_classification_and_no_secret_logging(monkeypatch, tmp_path, payload, rc, kind):
    monkeypatch.setattr(m, "_cli_path", lambda: tmp_path / "cli.exe")
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: completed(payload, rc))
    with pytest.raises(m.SearchError) as e:
        m.search_once("test")
    assert e.value.kind == kind
    assert "secret-value" not in str(e.value) and "stderr" not in str(e.value)


def test_process_timeout_is_sanitized(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "_cli_path", lambda: tmp_path / "cli.exe")
    def fake(*a, **k): raise subprocess.TimeoutExpired("secret-command", 1, output=b"secret-output")
    monkeypatch.setattr(m.subprocess, "run", fake)
    with pytest.raises(m.SearchError) as e: m.search_once("test")
    assert e.value.kind == "timeout" and "secret" not in str(e.value)


def test_non_json_response_is_not_empty_search(monkeypatch, tmp_path):
    monkeypatch.setattr(m, "_cli_path", lambda: tmp_path / "cli.exe")
    monkeypatch.setattr(m.subprocess, "run", lambda *a, **k: SimpleNamespace(returncode=0, stdout=b"<html>bad</html>", stderr=b""))
    with pytest.raises(m.SearchError, match="invalid_response"): m.search_once("test")


@pytest.mark.parametrize("limits", [{"max_questions": 1, "queries_per_question": 2},
                                      {"max_questions": 3, "queries_per_question": 1},
                                      {"max_questions": True, "queries_per_question": 2},
                                      {"max_questions": 3, "queries_per_question": 0}, None])
def test_plan_declared_limits_enforced(tmp_path, limits):
    p = make_plan(); p["limits"] = limits
    with pytest.raises(ValueError): m.load_plan(write_plan(tmp_path, p))
