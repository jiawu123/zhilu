"""Execute an already-reviewed Query Plan through the locally authenticated Zhihu CLI.

LIVE by default (user authorized paid M2 tests); --dry-run is optional.
Preserve every query/question/response occurrence and every distinct snippet.
No LLM, ranking, evidence compilation, background jobs, or automatic wrapper retries.
Only the existing zhihu_client.get_cli_path() helper is reused, lazily.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import re
import subprocess
import time
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

RETRIEVAL_VERSION = "m2-plan-retrieval-v0.1.0"
BLOCKING_ERRORS = {"authentication", "rate_or_quota_limit", "cli_unavailable", "cli_arguments"}
HINTS = {
    "authentication": "Check Zhihu CLI auth status; use the locally stored Zhihu secret, not a DeepSeek key.",
    "rate_or_quota_limit": "Stopped remaining queries. Check Zhihu quota or retry later; no automatic retry.",
    "cli_unavailable": "Check the installed Zhihu CLI path, permissions, compatibility and keychain.",
    "cli_arguments": "Check the installed CLI's search zhihu --help before another run.",
    "timeout": "CLI timed out; this query may have reached the server. No retry was made.",
    "network_error": "Check local connectivity; no retry was made for this query.",
    "upstream_error": "CLI or server rejected this search. Check numeric API/exit codes.",
    "invalid_response": "Response did not contain a successful Code=0 and Data.Items list; not an empty search.",
    "unexpected_error": "Unexpected local error; inspect code locally. Raw exception text was not logged.",
    "interrupted": "Operator interrupted this attempt; server receipt or charging may be unknown.",
}


class SearchError(RuntimeError):
    """Sanitized error category; never retain stderr, headers or raw error message."""

    def __init__(self, kind: str, *, exit_code: int | None = None, api_code: int | None = None):
        self.kind = kind if kind in HINTS else "unexpected_error"
        self.exit_code = exit_code
        self.api_code = api_code
        super().__init__(self.kind + ": " + HINTS[self.kind])

    def details(self) -> dict:
        return {"error_type": self.kind, "cli_exit_code": self.exit_code,
                "api_code": self.api_code, "hint": HINTS[self.kind]}


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write(path: Path, value: Any) -> None:
    # A failed write should leave the previous complete JSON readable.
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def _text(value: Any, name: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise ValueError(f"{name} must be a nonblank string <= {maximum} characters.")
    return value


def _key(value: str) -> str:
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", value).casefold()).rstrip("?!.。")


def _settings(count: int, timeout: float, interval: float) -> None:
    if type(count) is not int or not 1 <= count <= 10:
        raise ValueError("count must be an integer from 1 to 10.")
    for name, value, low, high in (("timeout", timeout, 0, 600), ("interval", interval, -1e-10, 60)):
        if type(value) not in (int, float) or not math.isfinite(value) or not low < value <= high:
            raise ValueError(f"Invalid {name}; timeout must be >0..600s, interval must be 0..60s.")


def load_plan(path: str | Path) -> tuple[dict, list[dict]]:
    """Validate the provided v0.1.0 plan without importing or invoking an LLM.

    Pending human_approved metadata in the old plan is not edited. Running this
    LIVE entry point is the operator's separate execution instruction, not a
    claim that the old plan has automatically acquired semantic verification.
    """
    path = Path(path)
    if path.stat().st_size > 200_000:
        raise ValueError("Plan file exceeds 200 KB.")
    plan = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(plan, dict) or plan.get("status") != "ready_for_review":
        raise ValueError("Expected a ready_for_review query_plan.json, not a manifest or clarification result.")
    if plan.get("planner_version") != "m2-query-planner-v0.1.0":
        raise ValueError("Unsupported planner version; this adapter expects v0.1.0.")
    _text(plan.get("goal"), "goal", 2000)
    if not isinstance(plan.get("user_context"), dict):
        raise ValueError("user_context must be a JSON object.")
    _canonical(plan)  # Reject nonfinite JSON numbers before any requests.
    limits = plan.get("limits")
    if not isinstance(limits, dict):
        raise ValueError("Plan limits must be an object.")
    for name, upper in (("max_questions", 3), ("queries_per_question", 2)):
        if type(limits.get(name)) is not int or not 1 <= limits[name] <= upper:
            raise ValueError("Invalid declared plan limits.")
    questions = plan.get("research_questions")
    if not isinstance(questions, list) or not 1 <= len(questions) <= limits["max_questions"]:
        raise ValueError("This runner expects 1..3 research questions.")
    if plan.get("clarification_questions"):
        raise ValueError("Resolve clarification questions before retrieval.")
    tasks, seen_questions, seen_queries = [], set(), set()
    for question in questions:
        if not isinstance(question, dict):
            raise ValueError("Every research question must be an object.")
        text = _text(question.get("research_question"), "research_question", 300)
        identity = {"goal": plan["goal"], "user_context": plan["user_context"], "research_question": text}
        qid = "rq_" + _hash(_canonical(identity))[:16]
        if question.get("question_id") != qid:
            raise ValueError("question_id no longer matches goal/context/question; use the saved original plan.")
        if _key(text) in seen_questions:
            raise ValueError("Duplicate normalized research questions.")
        seen_questions.add(_key(text))
        if question.get("evidence_need") not in {"method", "verification", "risk", "concept", "resource", "experience"}:
            raise ValueError("Unsupported evidence_need.")
        _text(question.get("why_needed"), "why_needed", 600)
        queries = question.get("queries")
        if not isinstance(queries, list) or not 1 <= len(queries) <= limits["queries_per_question"]:
            raise ValueError("Each question must have 1..2 queries.")
        for query in queries:
            _text(query, "query", 120)
            if query.startswith("-") or any(c in query for c in "\r\n\x00") or re.search(r"https?://|www\.", query, re.I):
                raise ValueError("Queries must be single-line search text, not URLs or command options.")
            if not _key(query) or _key(query) in seen_queries:
                raise ValueError("Duplicate or empty normalized query.")
            seen_queries.add(_key(query))
            tasks.append({"query_id": "sq_" + _hash(_canonical([qid, query]))[:16],
                          "question_id": qid, "research_question": text,
                          "evidence_need": question["evidence_need"], "query": query,
                          "query_position": len(tasks) + 1})
    if type(plan.get("planned_query_count")) is not int or plan["planned_query_count"] != len(tasks):
        raise ValueError("planned_query_count does not match actual query list.")
    return plan, tasks


def _cli_path() -> Path:
    # Does not require llm_client, httpx, models, or a DeepSeek key.
    try:
        from zhihu_m2.zhihu_client import get_cli_path
        path = Path(get_cli_path())
        if not path.is_file():
            raise FileNotFoundError
        return path
    except (ImportError, AttributeError, OSError, RuntimeError):
        raise SearchError("cli_unavailable") from None


def _classify(rc: int, payload: Any) -> SearchError | None:
    api_code = payload.get("Code") if isinstance(payload, dict) else None
    api_code = api_code if type(api_code) is int else None
    err = payload.get("error", {}) if isinstance(payload, dict) else {}
    code = err.get("code") if isinstance(err, dict) else None
    if rc == 3 or api_code == 20001 or code in ("AUTH_REQUIRED", "AUTH_INVALID", "ENV_SHADOWS_KEYCHAIN"):
        kind = "authentication"
    elif rc == 4 or api_code in (30001, 30002):
        kind = "rate_or_quota_limit"
    elif rc in (7, 8) or code == "KEYCHAIN_UNAVAILABLE":
        kind = "cli_unavailable"
    elif rc == 2:
        kind = "cli_arguments"
    elif rc == 5 or code in ("NETWORK_ERROR", "TIMEOUT"):
        kind = "network_error"
    elif rc != 0 or (api_code is not None and api_code != 0):
        kind = "upstream_error"
    else:
        return None
    return SearchError(kind, exit_code=rc, api_code=api_code)


def search_once(query: str, count: int = 10, timeout: float = 90) -> dict:
    """One CLI invocation. Return its full successful JSON envelope, no retry.

    Uses bytes instead of text mode to avoid newline normalization in snippets.
    CLI-internal HTTP retries, if any, are owned by the CLI and are not measured
    here. This function does not implement authentication or direct HTTP access.
    """
    _text(query, "query", 120)
    _settings(count, timeout, 0)
    command = [str(_cli_path()), "search", "zhihu", "--query", query, "--count", str(count)]
    try:
        result = subprocess.run(command, capture_output=True, stdin=subprocess.DEVNULL,
                                shell=False, timeout=timeout, check=False)
    except subprocess.TimeoutExpired:
        raise SearchError("timeout") from None
    except OSError:
        raise SearchError("cli_unavailable") from None
    try:
        payload = json.loads(result.stdout.decode("utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError):
        payload = None
    error = _classify(result.returncode, payload)
    if error is not None:
        raise error
    if not isinstance(payload, dict) or type(payload.get("Code")) is not int or payload["Code"] != 0:
        raise SearchError("invalid_response", exit_code=result.returncode)
    data = payload.get("Data")
    if not isinstance(data, dict) or not isinstance(data.get("Items"), list):
        raise SearchError("invalid_response", exit_code=result.returncode)
    try:
        _canonical(payload)
    except (ValueError, TypeError):
        raise SearchError("invalid_response", exit_code=result.returncode) from None
    return payload


def _add_occurrences(task: dict, payload: dict, retrieved: str, records: list, malformed: list) -> None:
    for index, raw in enumerate(payload["Data"]["Items"]):
        if not isinstance(raw, dict):
            malformed.append({"query_id": task["query_id"], "item_index": index,
                              "query_file": task["result_file"], "issue": "item_not_object"})
            continue
        oid = f"{task['query_id']}_item_{index + 1:03d}"
        cid, ctype = raw.get("ContentID"), raw.get("ContentType")
        known = type(cid) in (str, int) and bool(str(cid).strip()) and isinstance(ctype, str) and bool(ctype.strip())
        source_id = f"zhihu:{ctype}:{cid}" if known else f"unidentified:{oid}"
        snippet = raw.get("ContentText")
        valid_snippet = isinstance(snippet, str)
        issues = ([] if known else ["source_identity_missing"]) + ([] if valid_snippet and snippet.strip() else ["snippet_missing_or_invalid"])
        digest = _hash(snippet) if valid_snippet else None
        vid = "sv_" + _hash(_canonical([source_id, digest]))[:24] if valid_snippet else None
        records.append({"occurrence_id": oid, "question_id": task["question_id"],
                        "research_question": task["research_question"], "query_id": task["query_id"],
                        "query": task["query"], "rank_in_query": index + 1, "item_index": index,
                        "query_file": task["result_file"], "retrieved_at": retrieved,
                        "source_id": source_id, "has_source_identity": bool(known),
                        "identity_meaning": "API identity fields present; NOT author or factual verification",
                        "source_scope": "search_snippet", "snippet_sha256": digest,
                        "snippet_variant_id": vid, "issues": issues, "raw_item": copy.deepcopy(raw)})


def _aggregate(plan: dict, report: dict, records: list, malformed: list) -> dict:
    sources, variants = {}, {}
    for occurrence in records:
        sid = occurrence["source_id"]
        group = sources.setdefault(sid, {"source_id": sid, "question_ids": [], "query_ids": [],
                                       "occurrence_ids": [], "snippet_variant_ids": []})
        for key, value in (("question_ids", occurrence["question_id"]), ("query_ids", occurrence["query_id"]),
                           ("occurrence_ids", occurrence["occurrence_id"]), ("snippet_variant_ids", occurrence["snippet_variant_id"])):
            if value is not None and value not in group[key]: group[key].append(value)
        vid = occurrence["snippet_variant_id"]
        if vid:
            variant = variants.setdefault(vid, {"snippet_variant_id": vid, "source_id": sid,
                "snippet": occurrence["raw_item"]["ContentText"], "snippet_sha256": occurrence["snippet_sha256"],
                "source_scope": "search_snippet", "occurrence_ids": []})
            variant["occurrence_ids"].append(occurrence["occurrence_id"])
    questions = []
    for question in plan["research_questions"]:
        q = copy.deepcopy(question)
        selected = [o for o in records if o["question_id"] == q["question_id"]]
        q.update(query_ids=[t["query_id"] for t in report["outcomes"] if t["question_id"] == q["question_id"]],
                 occurrence_ids=[o["occurrence_id"] for o in selected],
                 source_ids=list(dict.fromkeys(o["source_id"] for o in selected)),
                 occurrence_count=len(selected))
        questions.append(q)
    return {"retrieval_version": RETRIEVAL_VERSION, "status": report["status"],
            "goal": plan["goal"], "user_context": copy.deepcopy(plan["user_context"]),
            "plan_sha256": report["plan_sha256"], "source_scope": "search_snippet",
            "timestamp_meaning": "client_received_cli_response", "ranked": False,
            "evidence_compilation_performed": False, "semantic_quality_checked": False,
            "independent_corroboration_checked": False, "questions": questions,
            "sources": list(sources.values()), "snippet_variants": list(variants.values()),
            "occurrences": records, "malformed_items": malformed, "query_outcomes": report["outcomes"]}


def retrieve_plan(plan_path: str | Path, *, count: int = 10, timeout: float = 90,
                  interval: float = 0.5, output_root: str | Path = "artifacts") -> Path:
    """Execute all plan queries, saving after each. Returns the run directory.

    Known per-query network/protocol errors continue to the next DIFFERENT query.
    Auth/quota/installation failures stop the run; future queries stay not_processed.
    Unexpected exceptions and operator interruptions stop, preserving completed data.
    Running twice is a new live experiment, NOT a resume and may consume quota again.
    """
    _settings(count, timeout, interval)
    plan, tasks = load_plan(plan_path)
    run_dir = Path(output_root) / ("retrieval_" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ_") + uuid4().hex[:8])
    (run_dir / "queries").mkdir(parents=True, exist_ok=False)
    for task in tasks:
        task.update(status="not_processed", not_processed_reason="not_started", result_count=None,
                    requested_count=count, result_file=f"queries/{task['query_position']:03d}.json")
    report = {"retrieval_version": RETRIEVAL_VERSION, "status": "running", "started_at": _now(),
              "plan_file": str(Path(plan_path).resolve()), "output_dir": str(run_dir.resolve()),
              "plan_sha256": _hash(_canonical(plan)), "execution_authorization": "operator_invoked_live_entrypoint",
              "original_plan_human_approved": plan.get("human_approved", False),
              "original_plan_metadata_unchanged": True, "query_count": len(tasks), "count_per_query": count,
              "requested_occurrences_upper_bound": len(tasks) * count, "search_calls_attempted": 0,
              "attempt_counter_meaning": "CLI wrapper attempts, not HTTP requests or billing",
              "llm_calls_attempted": 0, "automatic_wrapper_retries": False,
              "cli_internal_retry_policy": "controlled_by_installed_cli_not_measured",
              "timeout_seconds": timeout, "interval_seconds": interval,
              "new_zhihu_search": True, "reranked": False, "source_scope": "search_snippet",
              "semantic_quality_checked": False, "evidence_compilation_performed": False, "outcomes": tasks}
    records, malformed = [], []
    _write(run_dir / "query_plan.json", plan)

    def save() -> None:
        report["counts"] = {s: sum(t["status"] == s for t in tasks) for s in ("ok", "no_results", "error", "not_processed")}
        report["occurrence_count"] = len(records)
        report["unique_source_count"] = len({r["source_id"] for r in records})
        report["unique_source_count_includes_unidentified"] = True
        report["snippet_variant_count"] = len({r["snippet_variant_id"] for r in records if r["snippet_variant_id"]})
        report["malformed_item_count"] = len(malformed)
        _write(run_dir / "retrieval_results.json", _aggregate(plan, report, records, malformed))
        _write(run_dir / "manifest.json", report)

    save()  # Fail on unwritable output before a network request.
    current = None
    try:
        for task in tasks:
            current = task
            print(f"[{task['query_position']}/{len(tasks)}] {task['query']}", flush=True)
            task.update(status="running", started_at=_now())
            task.pop("not_processed_reason", None)
            report["search_calls_attempted"] += 1
            save()
            try:
                payload = search_once(task["query"], count=count, timeout=timeout)
                retrieved = _now()
                document = {"query_id": task["query_id"], "question_id": task["question_id"],
                            "research_question": task["research_question"], "query": task["query"],
                            "requested_count": count, "retrieved_at": retrieved,
                            "timestamp_meaning": "client_received_cli_response", "source_scope": "search_snippet",
                            "raw_response": payload}
                _write(run_dir / task["result_file"], document)
                _add_occurrences(task, payload, retrieved, records, malformed)
                n = len(payload["Data"]["Items"])
                task.update(status="ok" if n else "no_results", result_count=n,
                            retrieved_at=retrieved, completed_at=_now(),
                            response_sha256=_hash(_canonical(payload)),
                            response_exceeds_requested_count=n > count)
                print(f"    {task['status']}: {n} results", flush=True)
            except SearchError as error:
                task.update(status="error", completed_at=_now(), **error.details())
                _write(run_dir / task["result_file"], {**task, "raw_response": None})
                print(f"    error: {error}", flush=True)
                if error.kind in BLOCKING_ERRORS:
                    report.update(status="stopped", stop_reason=error.kind)
                    for remaining in tasks:
                        if remaining["status"] == "not_processed": remaining["not_processed_reason"] = error.kind
                    save()
                    break
            save()
            if task is not tasks[-1] and interval:
                time.sleep(interval)
        else:
            report["status"] = "completed_with_errors" if any(t["status"] == "error" for t in tasks) else "completed"
    except KeyboardInterrupt:
        if current and current["status"] == "running":
            current.update(status="error", completed_at=_now(), **SearchError("interrupted").details())
        report.update(status="interrupted", stop_reason="operator_interrupt")
        for t in tasks:
            if t["status"] == "not_processed": t["not_processed_reason"] = "operator_interrupt"
    except Exception as error:
        if current and current["status"] == "running":
            current.update(status="error", completed_at=_now(), **SearchError("unexpected_error").details())
        report.update(status="failed", error_type=type(error).__name__, stop_reason="unexpected_error")
        for t in tasks:
            if t["status"] == "not_processed": t["not_processed_reason"] = "unexpected_error"
        # Message/traceback are deliberately not logged: may contain secrets or private payloads.
    report["completed_at"] = _now()
    save()
    return run_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="LIVE Zhihu search for a saved Query Plan; no DeepSeek calls.", allow_abbrev=False)
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--count", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--interval", type=float, default=0.5)
    parser.add_argument("--output-root", type=Path, default=Path("artifacts"))
    parser.add_argument("--dry-run", action="store_true", help="Optional offline preview; live is the default.")
    args = parser.parse_args(argv)
    try:
        _settings(args.count, args.timeout, args.interval)
        _, tasks = load_plan(args.plan)
        if args.dry_run:
            print(json.dumps({"status": "dry_run", "query_count": len(tasks), "count_per_query": args.count,
                              "search_calls_attempted": 0, "llm_calls_attempted": 0, "tasks": tasks}, ensure_ascii=False, indent=2))
            return 0
        print(f"LIVE: {len(tasks)} Zhihu CLI searches, up to {args.count} results each; DeepSeek calls: 0.", flush=True)
        d = retrieve_plan(args.plan, count=args.count, timeout=args.timeout, interval=args.interval, output_root=args.output_root)
        report = json.loads((d / "manifest.json").read_text(encoding="utf-8"))
        print("Saved run: " + str(d.resolve()))
        print(json.dumps({k: report[k] for k in ("status", "counts", "search_calls_attempted", "occurrence_count", "unique_source_count", "snippet_variant_count")}, ensure_ascii=False, indent=2))
        return 0 if report["status"] == "completed" else 1
    except (OSError, ValueError) as error:
        print(f"ERROR: {type(error).__name__}: cannot read/validate input or write run files; inspect paths and input locally.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
