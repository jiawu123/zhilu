"""Replay plumbing tests, NOT semantic evaluations of real model responses."""
import copy
import hashlib
import json
from pathlib import Path

import httpx
import pytest

from zhihu_m2 import evidence_compiler as ec
from zhihu_m2 import llm_client
from zhihu_m2 import replay_evidence as replay

QUOTE = "用固定输入执行程序，再将输出与预先写下的期望结果比较。"
TIME = "2026-09-10T06:44:00.382511+00:00"
QUESTION = "如何检查练习程序的输出？"


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    def forbidden(*args, **kwargs):
        raise AssertionError("No real network calls are allowed in offline tests.")
    monkeypatch.setattr(httpx.Client, "send", forbidden)


@pytest.fixture
def run_dir(tmp_path):
    folder = tmp_path / "previous_live"
    folder.mkdir()
    raw = {
        "ContentType": "Answer", "ContentID": "123",
        "Title": "测试方法", "AuthorName": "测试作者",
        "ContentText": "资料介绍。\n" + QUOTE,
        "Url": "https://www.zhihu.com/question/1/answer/2?utm_source=test",
        "VoteUpCount": 6,
    }
    # Deliberately place the selected source second: replay must not pick index 0.
    other = dict(raw, ContentID="999", Title="Other", ContentText="另一条材料。")
    snapshot = {
        "query": "测试入门", "goal": "完成一个经过测试的小程序。",
        "research_question": QUESTION,
        "user_context": {"python_level": "beginner", "is_demo": True},
        "retrieved_at": TIME, "source_scope": "search_snippet",
        "raw_results": [other, raw],
    }
    source = {
        "id": "zhihu:Answer:123", "provider": "zhihu",
        "title": raw["Title"], "url": raw["Url"], "author": raw["AuthorName"],
        "snippet": raw["ContentText"], "retrievedAt": TIME,
        "source_scope": "search_snippet",
    }
    write_json(folder / "search_snapshot.json", snapshot)
    write_json(folder / "evidence.json", {"status": "ok", "source": source, "evidence_cards": []})
    return folder


@pytest.fixture
def model(monkeypatch):
    state = {"calls": [], "error": None, "payload": {
        "status": "ok", "reason": "引文给出比较输出的具体方法。", "evidence_cards": [{
            "source_id": "zhihu:Answer:123", "supporting_quote": QUOTE,
            "claim": "作者建议用固定输入和期望结果检查程序输出。",
            "claim_type": "advice", "applies_when": "对正在编写小程序的初学者可能适用。",
            "caveats": [],
        }],
    }}
    def fake_generate(system_prompt, user_prompt, *, max_tokens):
        state["calls"].append((system_prompt, json.loads(user_prompt), max_tokens))
        if state["error"] is not None:
            raise state["error"]
        return copy.deepcopy(state["payload"])
    monkeypatch.setattr(llm_client, "generate_json", fake_generate)
    return state


def test_default_dry_run_makes_no_model_call_and_no_output_folder(run_dir, tmp_path, model):
    root = tmp_path / "new_artifacts"
    output = replay.replay_saved_run(run_dir, output_root=root)
    assert output["status"] == "dry_run"
    assert output["model_calls_attempted"] == 0
    assert output["source_id"] == "zhihu:Answer:123"
    assert output["retrieved_at"] == TIME
    assert len(output["system_prompt_sha256"]) == 64
    assert model["calls"] == []
    assert not root.exists()


def test_live_replay_preserves_source_task_and_time_and_calls_once(run_dir, tmp_path, model):
    before = {p.name: p.read_bytes() for p in run_dir.iterdir()}
    output = replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    assert output["status"] == "ok"
    assert output["model_calls_attempted"] == 1
    assert len(model["calls"]) == 1
    system, user, tokens = model["calls"][0]
    assert system == ec.SYSTEM_PROMPT
    assert user["source"]["source_id"] == "zhihu:Answer:123"
    assert user["source"]["snippet"] == "资料介绍。\n" + QUOTE
    assert user["research_question"] == QUESTION
    assert user["user_context"] == {"python_level": "beginner", "is_demo": True}
    saved = Path(output["output_dir"])
    evidence = json.loads((saved / "evidence.json").read_text(encoding="utf-8"))
    assert evidence["source"]["retrievedAt"] == TIME
    assert evidence["evidence_cards"][0]["citation_status"] == "exact_match"
    assert evidence["evidence_cards"][0]["verification_status"] == "unverified"
    assert before == {p.name: p.read_bytes() for p in run_dir.iterdir()}
    saved_prompt = (saved / "system_prompt.txt").read_text(encoding="utf-8")
    assert saved_prompt == ec.SYSTEM_PROMPT
    assert hashlib.sha256(saved_prompt.encode("utf-8")).hexdigest() == output["system_prompt_sha256"]
    frozen = json.loads((saved / "replay_input.json").read_text(encoding="utf-8"))
    assert frozen["source"]["snippet"] == user["source"]["snippet"]
    assert frozen["research_question"] == QUESTION


@pytest.mark.parametrize("mutation", ["missing_source", "duplicate_source", "changed_snippet", "changed_time", "missing_time", "bad_question", "non_dict_context"])
def test_inconsistent_snapshot_is_rejected_before_paid_call(run_dir, tmp_path, model, mutation):
    path = run_dir / "search_snapshot.json"
    snapshot = json.loads(path.read_text(encoding="utf-8"))
    if mutation == "missing_source":
        snapshot["raw_results"] = snapshot["raw_results"][:1]
    elif mutation == "duplicate_source":
        snapshot["raw_results"].append(snapshot["raw_results"][1])
    elif mutation == "changed_snippet":
        snapshot["raw_results"][1]["ContentText"] += "改动"
    elif mutation == "changed_time":
        snapshot["retrieved_at"] = "2026-09-10T09:00:00+00:00"
    elif mutation == "missing_time":
        del snapshot["retrieved_at"]
    elif mutation == "bad_question":
        snapshot["research_question"] = ""
    else:
        snapshot["user_context"] = []
    write_json(path, snapshot)
    with pytest.raises(ValueError):
        replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    assert model["calls"] == []


def test_missing_input_file_fails_without_model_call(run_dir, model):
    (run_dir / "evidence.json").unlink()
    with pytest.raises(ValueError):
        replay.replay_saved_run(run_dir, call_model=True)
    assert model["calls"] == []


def test_no_evidence_is_saved_as_a_business_outcome(run_dir, tmp_path, model):
    model["payload"] = {"status": "no_evidence", "reason": "没有足够的直接依据。", "evidence_cards": []}
    output = replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    assert output["status"] == "no_evidence"
    assert len(model["calls"]) == 1
    assert (Path(output["output_dir"]) / "evidence.json").exists()


@pytest.mark.parametrize("failure", ["llm", "quote"])
def test_errors_are_recorded_and_raised_without_retry(run_dir, tmp_path, model, failure):
    if failure == "llm":
        model["error"] = llm_client.LLMError("offline simulated failure")
    else:
        model["payload"]["evidence_cards"][0]["supporting_quote"] = "这段引文根本不存在于输入中。"
    with pytest.raises(replay.ReplayError) as info:
        replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    folder = info.value.output_dir
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["status"] == "error"
    assert manifest["model_calls_attempted"] == 1
    assert "error_type" in manifest
    assert not (folder / "evidence.json").exists()
    assert len(model["calls"]) == 1


def test_each_replay_uses_new_output_directory(run_dir, tmp_path, model):
    first = replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    second = replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    assert first["output_dir"] != second["output_dir"]


def test_unsupported_claim_is_still_not_automatically_semantically_rejected(run_dir, tmp_path, model):
    # The quote exists, but this deliberately bad claim is NOT implied by it.
    # A passing structural validator is not a semantic quality benchmark.
    model["payload"]["evidence_cards"][0]["claim"] = "作者保证两天内能精通编程。"
    output = replay.replay_saved_run(run_dir, call_model=True, output_root=tmp_path / "out")
    card = json.loads((Path(output["output_dir"]) / "evidence.json").read_text(encoding="utf-8"))["evidence_cards"][0]
    assert "semantic_support_not_checked" in card["risk_flags"]
    assert card["verification_status"] == "unverified"


# Question-scope diagnostic tests. These assert provenance and call behavior,
# NOT whether a live model will select a helpful claim.
FOCUSED_QUESTION = "可以怎样检验程序流程或逻辑是否按预期工作？"


def test_question_override_changes_only_question_sent_to_model(run_dir, tmp_path, model):
    snapshot = json.loads((run_dir / "search_snapshot.json").read_text(encoding="utf-8"))
    before = {p.name: p.read_bytes() for p in run_dir.iterdir()}
    output = replay.replay_saved_run(
        run_dir, call_model=True, output_root=tmp_path / "out",
        research_question=FOCUSED_QUESTION,
    )
    assert len(model["calls"]) == 1
    system, user, tokens = model["calls"][0]
    assert system == ec.SYSTEM_PROMPT
    assert tokens == 1600
    assert user["research_question"] == FOCUSED_QUESTION
    assert user["goal"] == snapshot["goal"]
    assert user["user_context"] == snapshot["user_context"]
    assert user["source"]["snippet"] == snapshot["raw_results"][1]["ContentText"]
    assert user["source"]["source_id"] == "zhihu:Answer:123"
    assert before == {p.name: p.read_bytes() for p in run_dir.iterdir()}
    assert output["original_research_question"] == QUESTION
    assert output["research_question"] == FOCUSED_QUESTION
    assert output["question_changed"] is True
    assert output["run_kind"] == "question_scope_probe"
    assert output["interpretation_scope"] == "single_source_effective_question"
    assert output["semantic_support_checked"] is False


def test_probe_records_original_and_effective_inputs_and_hashes(run_dir, tmp_path, model):
    output = replay.replay_saved_run(
        run_dir, call_model=True, output_root=tmp_path / "out",
        research_question=FOCUSED_QUESTION,
    )
    folder = Path(output["output_dir"])
    original = json.loads((folder / "original_replay_input.json").read_text(encoding="utf-8"))
    effective = json.loads((folder / "replay_input.json").read_text(encoding="utf-8"))
    assert original["research_question"] == QUESTION
    assert effective["research_question"] == FOCUSED_QUESTION
    assert {k for k in original if original[k] != effective[k]} == {"research_question"}
    for field, record in [("original_frozen_input_sha256", original), ("frozen_input_sha256", effective)]:
        encoded = json.dumps(record, ensure_ascii=False, sort_keys=True).encode("utf-8")
        assert output[field] == hashlib.sha256(encoded).hexdigest()
    assert output["frozen_input_sha256"] != output["original_frozen_input_sha256"]
    assert output["snippet_sha256"] == hashlib.sha256(original["source"]["snippet"].encode("utf-8")).hexdigest()
    assert output["retrieved_at"] == TIME
    evidence = json.loads((folder / "evidence.json").read_text(encoding="utf-8"))
    assert evidence["source"]["retrievedAt"] == TIME
    assert evidence["evidence_cards"][0]["verification_status"] == "unverified"
    assert evidence["evidence_cards"][0]["citation_status"] == "exact_match"


def test_probe_is_dry_run_by_default(run_dir, tmp_path, model):
    root = tmp_path / "out"
    output = replay.replay_saved_run(run_dir, research_question=FOCUSED_QUESTION, output_root=root)
    assert output["status"] == "dry_run"
    assert output["model_calls_attempted"] == 0
    assert output["research_question"] == FOCUSED_QUESTION
    assert output["question_changed"] is True
    assert output["new_zhihu_search"] is False
    assert not root.exists()
    assert model["calls"] == []


def test_no_override_keeps_exact_replay_and_unchanged_hash(run_dir, model):
    output = replay.replay_saved_run(run_dir)
    assert output["run_kind"] == "exact_replay"
    assert output["question_changed"] is False
    assert output["research_question"] == QUESTION
    assert output["original_research_question"] == QUESTION
    assert output["original_frozen_input_sha256"] == output["frozen_input_sha256"]
    assert output["replay_version"] == "m2-replay-v0.2.0"
    assert model["calls"] == []


def test_equal_question_is_not_mislabeled_as_changed(run_dir, model):
    output = replay.replay_saved_run(run_dir, research_question=QUESTION)
    assert output["question_changed"] is False
    assert output["run_kind"] == "exact_replay"
    assert output["original_frozen_input_sha256"] == output["frozen_input_sha256"]


@pytest.mark.parametrize(
    "invalid", ["", " \n\t ", "问" * 2001, 12, False, [], {}],
    ids=["empty", "blank", "too_long", "int", "bool", "list", "dict"],
)
def test_bad_question_override_rejected_before_call_or_new_folder(run_dir, tmp_path, model, invalid):
    root = tmp_path / "out"
    with pytest.raises(ValueError):
        replay.replay_saved_run(run_dir, research_question=invalid, call_model=True, output_root=root)
    assert model["calls"] == []
    assert not root.exists()


def test_question_limit_accepts_2000_characters_without_rewriting(run_dir, model):
    value = "问" * 2000
    output = replay.replay_saved_run(run_dir, research_question=value)
    assert output["research_question"] == value
    assert model["calls"] == []


def test_probe_no_evidence_is_not_repaired_or_retried(run_dir, tmp_path, model):
    model["payload"] = {"status": "no_evidence", "reason": "该子问题没有足够依据。", "evidence_cards": []}
    output = replay.replay_saved_run(
        run_dir, research_question=FOCUSED_QUESTION, call_model=True, output_root=tmp_path / "out",
    )
    assert output["status"] == "no_evidence"
    assert output["card_count"] == 0
    assert output["research_question"] == FOCUSED_QUESTION
    assert output["original_research_question"] == QUESTION
    assert len(model["calls"]) == 1
    evidence = json.loads((Path(output["output_dir"]) / "evidence.json").read_text(encoding="utf-8"))
    assert evidence["reason"] == model["payload"]["reason"]


@pytest.mark.parametrize("kind", ["quote", "transport"])
def test_probe_does_not_bypass_failures_or_retry(run_dir, tmp_path, model, kind):
    if kind == "quote":
        model["payload"]["evidence_cards"][0]["supporting_quote"] = "这段引用是虚构的，根本不在摘要中。"
    else:
        model["error"] = llm_client.LLMError("TEST_PRIVATE_CONTENT")
    with pytest.raises(replay.ReplayError) as exc:
        replay.replay_saved_run(
            run_dir, research_question=FOCUSED_QUESTION, call_model=True, output_root=tmp_path / "out",
        )
    assert len(model["calls"]) == 1
    folder = exc.value.output_dir
    text = (folder / "manifest.json").read_text(encoding="utf-8")
    assert "TEST_PRIVATE_CONTENT" not in text
    manifest = json.loads(text)
    assert manifest["status"] == "error"
    assert manifest["question_changed"] is True
    assert manifest["model_calls_attempted"] == 1
    assert (folder / "original_replay_input.json").exists()
    assert (folder / "replay_input.json").exists()
    assert not (folder / "evidence.json").exists()


def test_cli_accepts_research_question_without_enabling_paid_call(run_dir, tmp_path, model, monkeypatch, capsys):
    import sys
    root = tmp_path / "out"
    monkeypatch.setattr(sys, "argv", [
        "replay_evidence", "--run-dir", str(run_dir),
        "--research-question", FOCUSED_QUESTION, "--output-root", str(root),
    ])
    replay.main()
    output = capsys.readouterr().out
    assert FOCUSED_QUESTION in output
    assert '"question_changed": true' in output
    assert '"model_calls_attempted": 0' in output
    assert not root.exists()
    assert model["calls"] == []
