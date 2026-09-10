"""Offline orchestration tests; real compiler validation, never live quality tests."""
import copy
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest

from zhihu_m2 import batch_evidence as batch
from zhihu_m2 import evidence_compiler as ec
from zhihu_m2 import llm_client

TIME = "2026-09-10T06:44:00.382511+00:00"
QUESTION = "在开发练习中，可以怎样检验程序流程是否按预期工作？"
QUOTE = "给程序输入固定样例，并把输出与事先写好的期望结果逐项比较。"
RAW_TEXT = "资料介绍。\n加老师领取课程资料包。\n" + QUOTE


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, data):
    Path(path).write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "offline-test-placeholder")
    def forbidden(*args, **kwargs):
        pytest.fail("A unit test attempted a real HTTP request.")
    monkeypatch.setattr(httpx.Client, "send", forbidden)


@pytest.fixture
def cache(tmp_path):
    folder = tmp_path / "live_fixture"
    folder.mkdir()
    raws = []
    for i in range(1, 6):
        raws.append({
            "ContentType": "Answer", "ContentID": str(i), "Title": f"资料{i}",
            "AuthorName": "Same author" if i in (1, 3) else f"作者{i}",
            "AuthorSignature": "same-author" if i in (1, 3) else f"author-{i}",
            "ContentText": RAW_TEXT,
            "Url": f"https://www.zhihu.com/question/1/answer/{i}?utm_source=fixture",
            "VoteUpCount": i, "CommentCount": 0,
        })
    snap = {
        "query": "测试方法", "goal": "完成经过基本测试的小项目。",
        "research_question": "如何学习并安排实践和测试？",
        "user_context": {"python_level": "beginner", "weekly_hours": 10, "is_demo": True},
        "retrieved_at": TIME, "source_scope": "search_snippet", "raw_results": raws,
    }
    ranked = []
    # Deliberately NOT search order; two leading sources have the same author.
    for rank, i in enumerate([3, 1, 2, 5, 4], 1):
        raw = raws[i - 1]
        ranked.append({
            "rank": rank, "source_id": f"zhihu:Answer:{i}", "title": raw["Title"],
            "url": raw["Url"], "score": 1.0 - rank / 10,
        })
    write_json(folder / "search_snapshot.json", snap)
    write_json(folder / "run_report.json", {"status": "ok", "query": snap["query"], "retrieved_at": TIME, "ranked_candidates": ranked})
    return folder


@pytest.fixture
def fake_model(monkeypatch):
    state = {"calls": [], "behavior": {}}
    def generate(system_prompt, user_prompt, *, max_tokens):
        data = json.loads(user_prompt)
        state["calls"].append((system_prompt, data, max_tokens))
        sid = data["source"]["source_id"]
        behavior = state["behavior"].get(sid, "ok")
        if behavior == "llm_error":
            raise llm_client.LLMError("SECRET_SENTINEL must not be logged")
        if behavior == "bug":
            raise RuntimeError("SECRET_SENTINEL unexpected programmer error")
        if behavior == "interrupt":
            raise KeyboardInterrupt()
        if behavior == "no_evidence":
            return {"status": "no_evidence", "reason": "本来源未提供该子问题的依据。", "evidence_cards": []}
        card = {
            "source_id": sid, "supporting_quote": QUOTE,
            "claim": "作者建议用固定输入和期望输出来检查程序。", "claim_type": "advice",
            "applies_when": "对需要检查程序流程的初学者可能适用。", "caveats": [],
        }
        if behavior == "invalid_quote":
            card["supporting_quote"] = "这是输入中不存在的伪造引用。"
        if behavior == "invalid_source":
            card["source_id"] = "zhihu:Answer:999999"
        if behavior == "unverified_but_unsupported_claim":
            card["claim"] = "作者保证一天学会编程。"
        return {"status": "ok", "reason": "引文描述检查方法。", "evidence_cards": [card]}
    monkeypatch.setattr(llm_client, "generate_json", generate)
    return state


def run(cache, tmp_path, **kwargs):
    return batch.run_batch(cache, research_question=QUESTION, output_root=tmp_path / "out", **kwargs)


def test_dry_run_is_default_offline_and_creates_no_output(cache, tmp_path, fake_model, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    manifest = run(cache, tmp_path)
    assert manifest["status"] == "dry_run"
    assert manifest["compiler_calls_attempted"] == 0
    assert manifest["selected_count"] == 3
    assert manifest["candidate_count"] == 5
    assert manifest["new_zhihu_search"] is False
    assert manifest["reranked"] is False
    assert [x["source_id"] for x in manifest["outcomes"] if x["selected"]] == ["zhihu:Answer:3", "zhihu:Answer:1", "zhihu:Answer:2"]
    assert set(x["status"] for x in manifest["outcomes"]) == {"not_processed"}
    assert fake_model["calls"] == []
    assert not (tmp_path / "out").exists()


def test_mixed_results_keep_statuses_and_do_not_replace_or_retry(cache, tmp_path, fake_model):
    fake_model["behavior"] = {"zhihu:Answer:1": "no_evidence", "zhihu:Answer:2": "llm_error"}
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["status"] == "completed_with_errors"
    assert manifest["counts"] == {"ok": 1, "no_evidence": 1, "error": 1, "not_processed": 2}
    assert manifest["compiler_calls_attempted"] == 3
    assert [x[1]["source"]["source_id"] for x in fake_model["calls"]] == ["zhihu:Answer:3", "zhihu:Answer:1", "zhihu:Answer:2"]
    assert manifest["outcomes"][1]["reason"] == "本来源未提供该子问题的依据。"
    assert manifest["outcomes"][2]["error_type"] == "LLMError"
    assert manifest["outcomes"][3]["not_processed_reason"] == "candidate_limit"
    folder = Path(manifest["output_dir"])
    aggregate = read_json(folder / "batch_evidence.json")
    assert len(aggregate["evidence_cards"]) == 1
    assert (folder / "results/001.json").exists()
    assert (folder / "results/002.json").exists()
    assert not (folder / "results/003.json").exists()
    assert "SECRET_SENTINEL" not in "\n".join(p.read_text(encoding="utf-8") for p in folder.rglob("*.json"))


@pytest.mark.parametrize("limit", [1, 2, 3])
def test_small_limits_and_question_binding(cache, tmp_path, fake_model, limit):
    manifest = run(cache, tmp_path, call_model=True, max_candidates=limit)
    assert manifest["status"] == "completed"
    assert manifest["compiler_calls_attempted"] == limit == len(fake_model["calls"])
    assert manifest["counts"]["not_processed"] == 5 - limit
    aggregate = read_json(Path(manifest["output_dir"]) / "batch_evidence.json")
    assert aggregate["research_question"] == QUESTION
    assert aggregate["interpretation_scope"] == "single_question_cached_candidates"
    assert aggregate["semantic_support_checked"] is False
    for card in aggregate["evidence_cards"]:
        assert card["research_question"] == QUESTION
        assert card["question_id"] == aggregate["question_id"]
        assert card["verification_status"] == "unverified"
        assert card["citation_status"] == "exact_match"
        assert "semantic_support_not_checked" in card["risk_flags"]


def test_preserves_raw_source_task_timestamp_and_prompt(cache, tmp_path, fake_model):
    before = {p.name: p.read_bytes() for p in cache.iterdir()}
    manifest = run(cache, tmp_path, call_model=True, max_candidates=1)
    system, user, max_tokens = fake_model["calls"][0]
    snap = read_json(cache / "search_snapshot.json")
    assert user["source"]["snippet"] == RAW_TEXT  # including promotional content
    assert user["goal"] == snap["goal"]
    assert user["user_context"] == snap["user_context"]
    assert user["research_question"] == QUESTION
    assert system == ec.SYSTEM_PROMPT
    assert max_tokens == 1600
    folder = Path(manifest["output_dir"])
    result = read_json(folder / "results/001.json")
    assert result["source"]["retrievedAt"] == TIME
    quote_card = result["evidence_cards"][0]
    assert result["source"]["snippet"][quote_card["quote_start"]:quote_card["quote_end"]] == QUOTE
    assert "question_id" not in quote_card  # raw compiler output unmodified
    assert manifest["system_prompt_sha256"] == hashlib.sha256(system.encode()).hexdigest()
    assert (folder / "system_prompt.txt").read_text(encoding="utf-8") == system
    assert before == {p.name: p.read_bytes() for p in cache.iterdir()}
    assert (folder / "search_snapshot.json").read_bytes() == before["search_snapshot.json"]


@pytest.mark.parametrize("failure", ["invalid_quote", "invalid_source"])
def test_bad_evidence_is_rejected_and_next_selected_source_continues(cache, tmp_path, fake_model, failure):
    fake_model["behavior"]["zhihu:Answer:3"] = failure
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["outcomes"][0]["status"] == "error"
    assert manifest["outcomes"][0]["error_type"] == "EvidenceValidationError"
    assert manifest["counts"]["ok"] == 2
    assert len(fake_model["calls"]) == 3
    assert manifest["card_count"] == 2


def test_every_source_can_decline_without_claiming_global_absence(cache, tmp_path, fake_model):
    fake_model["behavior"] = {f"zhihu:Answer:{i}": "no_evidence" for i in range(1, 6)}
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["status"] == "completed"
    assert manifest["card_count"] == 0
    assert manifest["counts"]["no_evidence"] == 3
    assert manifest["counts"]["not_processed"] == 2


def test_all_model_failures_are_errors_not_no_evidence(cache, tmp_path, fake_model):
    fake_model["behavior"] = {f"zhihu:Answer:{i}": "llm_error" for i in range(1, 6)}
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["counts"]["error"] == 3
    assert manifest["counts"]["no_evidence"] == 0
    assert manifest["status"] == "completed_with_errors"


def test_duplicate_content_keeps_first_and_same_author_is_not_removed(cache, tmp_path, fake_model):
    path = cache / "search_snapshot.json"
    snapshot = read_json(path)
    snapshot["raw_results"].append(copy.deepcopy(snapshot["raw_results"][2]))
    write_json(path, snapshot)
    path = cache / "run_report.json"
    report = read_json(path)
    duplicated = dict(report["ranked_candidates"][0], rank=6)
    report["ranked_candidates"].append(duplicated)
    write_json(path, report)
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["duplicates_removed"] == 1
    assert manifest["candidate_count"] == 5
    assert len(fake_model["calls"]) == 3
    assert [x[1]["source"]["source_id"] for x in fake_model["calls"]][:2] == ["zhihu:Answer:3", "zhihu:Answer:1"]


def test_empty_cache_does_not_require_key_or_call_model(cache, tmp_path, fake_model, monkeypatch):
    for filename, field in [("search_snapshot.json", "raw_results"), ("run_report.json", "ranked_candidates")]:
        path = cache / filename
        data = read_json(path)
        data[field] = []
        write_json(path, data)
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["counts"] == {"ok": 0, "no_evidence": 0, "error": 0, "not_processed": 0}
    assert manifest["status"] == "completed"
    assert manifest["card_count"] == 0
    assert fake_model["calls"] == []


@pytest.mark.parametrize("limit", [0, 4, -1, True, 1.5, "3", None])
def test_invalid_budget_fails_before_calls(cache, tmp_path, fake_model, limit):
    with pytest.raises(ValueError):
        run(cache, tmp_path, call_model=True, max_candidates=limit)
    assert fake_model["calls"] == []


@pytest.mark.parametrize("question", ["", "   ", None, 123, "字" * 2001])
def test_invalid_question_fails_before_calls(cache, tmp_path, fake_model, question):
    with pytest.raises(ValueError):
        batch.run_batch(cache, research_question=question, call_model=True, output_root=tmp_path / "out")
    assert fake_model["calls"] == []


@pytest.mark.parametrize("mutation", ["scope", "timestamp", "context", "blank_source", "bad_url", "conflicting_duplicate", "missing_rank", "rank_id", "rank_title", "rank_url", "report_time", "query", "rank_number"])
def test_bad_cache_fails_before_calls(cache, tmp_path, fake_model, mutation):
    spath, rpath = cache / "search_snapshot.json", cache / "run_report.json"
    snap, report = read_json(spath), read_json(rpath)
    if mutation == "scope":
        snap["source_scope"] = "full_text"
    elif mutation == "timestamp":
        snap["retrieved_at"] = "2026-09-10"
    elif mutation == "context":
        snap["user_context"] = []
    elif mutation == "blank_source":
        snap["raw_results"][0]["ContentText"] = ""
    elif mutation == "bad_url":
        snap["raw_results"][0]["Url"] = "https://example.org/other"
    elif mutation == "conflicting_duplicate":
        snap["raw_results"].append(dict(snap["raw_results"][0], ContentText="另一个不一致的摘要。"))
    elif mutation == "missing_rank":
        report["ranked_candidates"].pop()
    elif mutation == "rank_id":
        report["ranked_candidates"][0]["source_id"] = "zhihu:Answer:123456"
    elif mutation == "rank_title":
        report["ranked_candidates"][0]["title"] = "changed title"
    elif mutation == "rank_url":
        report["ranked_candidates"][0]["url"] = "https://www.zhihu.com/other"
    elif mutation == "report_time":
        report["retrieved_at"] = "2020-01-01T00:00:00+00:00"
    elif mutation == "query":
        report["query"] = "a different query"
    else:
        report["ranked_candidates"][0]["rank"] = True
    write_json(spath, snap)
    write_json(rpath, report)
    with pytest.raises(ValueError):
        run(cache, tmp_path, call_model=True)
    assert fake_model["calls"] == []


def test_missing_key_fails_before_creating_output(cache, tmp_path, fake_model, monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY")
    with pytest.raises(ValueError, match="DEEPSEEK_API_KEY"):
        run(cache, tmp_path, call_model=True)
    assert fake_model["calls"] == []
    assert not (tmp_path / "out").exists()


def test_key_never_saved(cache, tmp_path, fake_model, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "SECRET_TEST_SENTINEL_NEVER_SAVE")
    manifest = run(cache, tmp_path, call_model=True)
    all_text = "\n".join(p.read_text(encoding="utf-8") for p in Path(manifest["output_dir"]).rglob("*") if p.is_file())
    assert "SECRET_TEST_SENTINEL_NEVER_SAVE" not in all_text


def test_repeat_execution_uses_new_directory(cache, tmp_path, fake_model):
    a = run(cache, tmp_path, call_model=True, max_candidates=1)
    b = run(cache, tmp_path, call_model=True, max_candidates=1)
    assert a["output_dir"] != b["output_dir"]
    assert a["frozen_input_sha256"] == b["frozen_input_sha256"]


def test_progress_exists_before_each_paid_call(cache, tmp_path, fake_model, monkeypatch):
    original = llm_client.generate_json
    def inspect(*args, **kwargs):
        folders = list((tmp_path / "out").iterdir())
        report = read_json(folders[0] / "manifest.json")
        assert report["status"] == "running"
        assert report["compiler_calls_attempted"] == len(fake_model["calls"]) + 1
        assert report["current_source_id"]
        if len(fake_model["calls"]) >= 1:
            assert report["counts"]["ok"] == len(fake_model["calls"])
        return original(*args, **kwargs)
    monkeypatch.setattr(llm_client, "generate_json", inspect)
    run(cache, tmp_path, call_model=True)


@pytest.mark.parametrize("failure", ["bug", "interrupt"])
def test_unexpected_errors_and_interrupts_stop_future_calls(cache, tmp_path, fake_model, failure):
    fake_model["behavior"]["zhihu:Answer:1"] = failure
    with pytest.raises(batch.BatchRunError) as info:
        run(cache, tmp_path, call_model=True)
    assert len(fake_model["calls"]) == 2
    report = read_json(info.value.output_dir / "manifest.json")
    assert report["status"] == ("interrupted" if failure == "interrupt" else "failed")
    assert report["counts"] == {"ok": 1, "no_evidence": 0, "error": 1, "not_processed": 2 + 1}
    assert report["outcomes"][2]["not_processed_reason"] == "batch_aborted"
    assert "SECRET_SENTINEL" not in str(info.value)


def test_output_directory_failure_prevents_model_call(cache, tmp_path, fake_model):
    (tmp_path / "out").write_text("cannot be a directory")
    with pytest.raises(OSError):
        run(cache, tmp_path, call_model=True)
    assert fake_model["calls"] == []


def test_structural_validation_is_not_semantic_evaluation(cache, tmp_path, fake_model):
    fake_model["behavior"]["zhihu:Answer:3"] = "unverified_but_unsupported_claim"
    manifest = run(cache, tmp_path, call_model=True, max_candidates=1)
    card = read_json(Path(manifest["output_dir"]) / "batch_evidence.json")["evidence_cards"][0]
    assert card["claim"] == "作者保证一天学会编程。"
    assert card["verification_status"] == "unverified"
    assert "semantic_support_not_checked" in card["risk_flags"]


def test_cli_preview_accepts_literal_question(cache, tmp_path, fake_model, monkeypatch, capsys):
    monkeypatch.setattr(sys, "argv", ["batch_evidence", "--run-dir", str(cache), "--research-question", QUESTION, "--output-root", str(tmp_path / "out")])
    batch.main()
    printed = capsys.readouterr().out
    assert '"status": "dry_run"' in printed
    assert fake_model["calls"] == []


def test_dry_and_execute_freeze_the_same_candidate_input(cache, tmp_path, fake_model):
    preview = run(cache, tmp_path)
    executed = run(cache, tmp_path, call_model=True)
    assert preview["frozen_input_sha256"] == executed["frozen_input_sha256"]
    assert preview["system_prompt_sha256"] == executed["system_prompt_sha256"]
    assert preview["question_id"] == executed["question_id"]


@pytest.mark.parametrize("filename", ["search_snapshot.json", "run_report.json"])
def test_missing_original_file_is_reported_before_calls(cache, tmp_path, fake_model, filename):
    (cache / filename).unlink()
    with pytest.raises(ValueError, match=filename):
        run(cache, tmp_path, call_model=True)
    assert fake_model["calls"] == []


def test_available_candidates_less_than_budget_are_all_processed(cache, tmp_path, fake_model):
    spath, rpath = cache / "search_snapshot.json", cache / "run_report.json"
    snap, report = read_json(spath), read_json(rpath)
    snap["raw_results"] = [snap["raw_results"][2], snap["raw_results"][0]]
    report["ranked_candidates"] = report["ranked_candidates"][:2]
    write_json(spath, snap)
    write_json(rpath, report)
    manifest = run(cache, tmp_path, call_model=True)
    assert manifest["selected_count"] == 2
    assert manifest["compiler_calls_attempted"] == 2
    assert manifest["counts"]["not_processed"] == 0


def test_storage_failure_stops_before_next_source(cache, tmp_path, fake_model, monkeypatch):
    original = batch._write
    def disk_full(path, value):
        if path.name == "002.json":
            raise OSError("SECRET_SENTINEL disk error")
        return original(path, value)
    monkeypatch.setattr(batch, "_write", disk_full)
    with pytest.raises(batch.BatchRunError) as info:
        run(cache, tmp_path, call_model=True)
    folder = info.value.output_dir
    report = read_json(folder / "manifest.json")
    assert report["status"] == "failed"
    assert report["stage"] == "save_source_output"
    assert len(fake_model["calls"]) == 2
    assert (folder / "results/001.json").exists()
    assert report["outcomes"][2]["status"] == "not_processed"


def test_article_and_answer_with_same_id_are_distinct(cache, tmp_path, fake_model):
    spath, rpath = cache / "search_snapshot.json", cache / "run_report.json"
    snap, report = read_json(spath), read_json(rpath)
    article = dict(snap["raw_results"][2], ContentType="Article", Url="https://zhuanlan.zhihu.com/p/3", Title="另一篇文章")
    snap["raw_results"].append(article)
    report["ranked_candidates"].append({"rank": 6, "source_id": "zhihu:Article:3", "title": article["Title"], "url": article["Url"], "score": 0.1})
    write_json(spath, snap)
    write_json(rpath, report)
    manifest = run(cache, tmp_path)
    assert manifest["candidate_count"] == 6
    assert manifest["duplicates_removed"] == 0
    assert manifest["outcomes"][-1]["source_id"] == "zhihu:Article:3"


def test_cli_requires_full_paid_flag_not_an_abbreviation(cache, tmp_path, fake_model, monkeypatch):
    monkeypatch.setattr(sys, "argv", ["batch_evidence", "--run-dir", str(cache), "--research-question", QUESTION, "--call"])
    with pytest.raises(SystemExit) as info:
        batch.main()
    assert info.value.code == 2
    assert fake_model["calls"] == []
