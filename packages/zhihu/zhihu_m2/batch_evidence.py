"""One explicit question -> at most three frozen, saved-ranked Zhihu sources.

Default is an offline preview. --call-model permits sequential compiler calls,
never searches, re-ranks, cleans source text, retries, or substitutes candidate 4.
Reuses evidence_compiler v0.1.2 without altering its prompt or validators.
This is orchestration/provenance checking, NOT semantic or fact verification.
"""
import argparse
import copy
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from zhihu_m2 import evidence_compiler as ec
from zhihu_m2 import llm_client, normalizer

BATCH_VERSION = "m2-batch-v0.1.0"
STATUSES = ("ok", "no_evidence", "error", "not_processed")


class BatchRunError(RuntimeError):
    """Fatal failure with a local checkpoint; no raw model/error text is exposed."""

    def __init__(self, error_type: str, output_dir: Path):
        self.output_dir = output_dir
        super().__init__(f"error_type={error_type}; see {output_dir / 'manifest.json'}")


def _json(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, sort_keys=True, allow_nan=False)


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _read(path: Path) -> tuple[dict, bytes]:
    """Read bounded, local saved JSON only; never interpret source text as code."""
    try:
        if path.stat().st_size > 4_000_000:
            raise ValueError("Saved JSON file exceeds 4 MB.")
        original_bytes = path.read_bytes()
        data = json.loads(original_bytes.decode("utf-8-sig"))
        if not isinstance(data, dict):
            raise ValueError("Saved JSON must be an object.")
        _json(data)  # Also reject nonfinite numbers.
    except (OSError, UnicodeError, ValueError, TypeError):
        raise ValueError(f"Cannot read valid local JSON: {path.name}") from None
    return data, original_bytes


def _write(path: Path, data: Any) -> None:
    """Replace one JSON file atomically; a batch directory is not a transaction."""
    text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    temp = path.with_name(path.name + ".tmp")
    temp.write_text(text, encoding="utf-8")
    temp.replace(path)


def _text(value: Any, name: str, limit: int = 2000) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f"{name} must be nonblank text of at most {limit} characters.")
    return value


def _prepare(run_dir: Path, question: str, limit: int):
    """Validate all candidates BEFORE model work; freeze existing rank order."""
    snapshot, snapshot_bytes = _read(run_dir / "search_snapshot.json")
    report, report_bytes = _read(run_dir / "run_report.json")
    if snapshot.get("source_scope") != "search_snippet":
        raise ValueError("Only search_snippet snapshots are supported.")
    for field in ("goal", "research_question", "query"):
        _text(snapshot.get(field), field)
    timestamp = _text(snapshot.get("retrieved_at"), "retrieved_at", 80)
    # Empty input must also have a valid, timezone-aware retrieval timestamp.
    try:
        dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("retrieved_at must be a timezone-aware ISO timestamp.") from None
    if dt.tzinfo is None or dt.utcoffset() is None:
        raise ValueError("retrieved_at must include a timezone.")
    context = snapshot.get("user_context")
    if not isinstance(context, dict) or len(_json(context)) > 8000:
        raise ValueError("user_context must be a JSON object of at most 8000 characters.")
    if report.get("query") != snapshot["query"] or report.get("retrieved_at") != timestamp:
        raise ValueError("Saved rank report and snapshot query/time disagree.")
    raw_items = snapshot.get("raw_results")
    ranks = report.get("ranked_candidates")
    if not isinstance(raw_items, list) or not isinstance(ranks, list):
        raise ValueError("Need raw_results and ranked_candidates lists from an original live run.")

    by_id, sources = {}, {}
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ValueError("raw_results must contain objects.")
        result = normalizer.normalize_result(raw)
        # Existing provenance validation is local; it makes no model request.
        source = ec._source_record(result, timestamp)
        sid = source["id"]
        if sid in sources and sources[sid] != source:
            raise ValueError("Duplicate source identity has conflicting provenance or snippet.")
        if sid not in sources:
            sources[sid], by_id[sid] = source, raw

    if any(not isinstance(row, dict) or type(row.get("rank")) is not int for row in ranks):
        raise ValueError("Saved ranks must be integer positions, not booleans.")
    ordered = sorted(ranks, key=lambda row: row["rank"])
    if [row["rank"] for row in ordered] != list(range(1, len(ordered) + 1)):
        raise ValueError("Saved ranks must be unique consecutive positions starting at 1.")
    candidates, seen = [], set()
    for row in ordered:
        sid = row.get("source_id")
        if not isinstance(sid, str) or sid not in sources:
            raise ValueError("Saved rank source is missing from the snapshot.")
        source = sources[sid]
        if row.get("title") != source["title"] or row.get("url") != source["url"]:
            raise ValueError("Saved rank title/URL does not match its snapshot source.")
        score = row.get("score")
        if type(score) not in (int, float) or not math.isfinite(score) or not 0 <= score <= 1:
            raise ValueError("Saved rank score must be finite and between 0 and 1.")
        if sid not in seen:
            seen.add(sid)
            candidates.append({
                "source_id": sid, "saved_rank": row["rank"], "saved_score": score,
                "source": source, "selected": len(candidates) < limit,
            })
    if seen != set(sources):
        raise ValueError("Saved ranking must cover every unique snapshot source.")

    frozen = {
        "query": snapshot["query"], "goal": snapshot["goal"], "user_context": context,
        "original_research_question": snapshot["research_question"],
        "research_question": question, "retrieved_at": timestamp,
        "selection_policy": "first_unique_in_saved_rank_order_no_author_cap",
        "selection_query": snapshot["query"], "max_candidates": limit,
        "duplicates_removed": len(raw_items) - len(sources), "candidates": candidates,
    }
    return frozen, by_id, snapshot_bytes, report_bytes


def _refresh(manifest: dict, cards: list) -> None:
    manifest["counts"] = {
        state: sum(row["status"] == state for row in manifest["outcomes"])
        for state in STATUSES
    }
    manifest["card_count"] = len(cards)
    # Compiler can fail before/after sending a request. Never claim billing counts.
    manifest["model_calls_upper_bound"] = manifest["compiler_calls_attempted"]


def _checkpoint(folder: Path, manifest: dict, frozen: dict, cards: list) -> None:
    _refresh(manifest, cards)
    aggregate = {
        "batch_version": BATCH_VERSION, "compiler_version": ec.COMPILER_VERSION,
        "status": manifest["status"], "question_id": manifest["question_id"],
        "goal": frozen["goal"], "user_context": frozen["user_context"],
        "research_question": frozen["research_question"],
        "original_research_question": frozen["original_research_question"],
        "interpretation_scope": "single_question_cached_candidates",
        "source_scope": "search_snippet", "semantic_support_checked": False,
        "independent_corroboration_checked": False,
        "sources": [c["source"] for c in frozen["candidates"]],
        "evidence_cards": cards, "outcomes": manifest["outcomes"],
    }
    _write(folder / "batch_evidence.json", aggregate)
    _write(folder / "manifest.json", manifest)


def run_batch(
    run_dir: Path | str,
    *,
    research_question: str,
    max_candidates: int = 3,
    call_model: bool = False,
    output_root: Path | str = "artifacts",
) -> dict[str, Any]:
    """Preview/process 1..3 fixed candidates, without new retrieval or retries.

    Each selected source is tried once even when a previous source declines or
    fails. A failure never recruits a fourth source. Source errors are recorded;
    unexpected code/storage failures and interruption stop the remaining batch.
    A completed batch does not imply comprehensive evidence or verified claims.
    """
    _text(research_question, "research_question")
    if type(max_candidates) is not int or not 1 <= max_candidates <= 3:
        raise ValueError("max_candidates must be an integer from 1 to 3.")
    if type(call_model) is not bool:
        raise ValueError("call_model must be a boolean.")
    frozen, raw_by_id, snapshot_bytes, rank_bytes = _prepare(Path(run_dir), research_question, max_candidates)
    question_identity = {k: frozen[k] for k in ("goal", "user_context", "research_question")}
    manifest = {
        "batch_version": BATCH_VERSION, "compiler_version": ec.COMPILER_VERSION,
        "model": llm_client.MODEL, "status": "dry_run",
        "run_kind": "cached_multi_source_single_question",
        "previous_run": str(Path(run_dir).resolve()),
        "new_zhihu_search": False, "reranked": False, "automatic_retries": False,
        "semantic_support_checked": False, "independent_corroboration_checked": False,
        "interpretation_scope": "single_question_cached_candidates",
        "original_research_question": frozen["original_research_question"],
        "research_question": research_question,
        "question_id": "rq_" + _hash(_json(question_identity))[:16],
        "retrieved_at": frozen["retrieved_at"], "selection_query": frozen["query"],
        "selection_policy": frozen["selection_policy"], "max_candidates": max_candidates,
        "candidate_count": len(frozen["candidates"]),
        "selected_count": sum(c["selected"] for c in frozen["candidates"]),
        "duplicates_removed": frozen["duplicates_removed"], "compiler_calls_attempted": 0,
        "system_prompt_sha256": _hash(ec.SYSTEM_PROMPT),
        "frozen_input_sha256": _hash(_json(frozen)),
        "search_snapshot_sha256": hashlib.sha256(snapshot_bytes).hexdigest(),
        "saved_report_sha256": hashlib.sha256(rank_bytes).hexdigest(),
        "outcomes": [],
    }
    for c in frozen["candidates"]:
        manifest["outcomes"].append({
            "source_id": c["source_id"], "title": c["source"]["title"],
            "author": c["source"]["author"], "saved_rank": c["saved_rank"],
            "saved_score": c["saved_score"], "selected": c["selected"],
            "status": "not_processed", "reason": "",
            "not_processed_reason": "dry_run" if c["selected"] else "candidate_limit",
        })
    cards: list[dict] = []
    _refresh(manifest, cards)
    if not call_model:
        return manifest
    if manifest["selected_count"] and not os.environ.get("DEEPSEEK_API_KEY", "").strip():
        raise ValueError("Set DEEPSEEK_API_KEY in this terminal first; no model call was made.")

    now = datetime.now(timezone.utc)
    folder = Path(output_root) / ("batch_" + now.strftime("%Y%m%dT%H%M%S%fZ_") + uuid4().hex[:8])
    (folder / "results").mkdir(parents=True, exist_ok=False)
    # Save original cache bytes and effective task BEFORE any external call.
    (folder / "search_snapshot.json").write_bytes(snapshot_bytes)
    (folder / "saved_run_report.json").write_bytes(rank_bytes)
    (folder / "system_prompt.txt").write_text(ec.SYSTEM_PROMPT, encoding="utf-8")
    _write(folder / "batch_input.json", frozen)
    manifest.update(status="running", started_at=now.isoformat(), output_dir=str(folder.resolve()))
    for row in manifest["outcomes"]:
        if row["selected"]:
            row["not_processed_reason"] = "pending"
    _checkpoint(folder, manifest, frozen, cards)
    current = None
    stage = "compile"
    try:
        for index, row in enumerate(manifest["outcomes"], 1):
            if not row["selected"]:
                continue
            current = row
            stage = "compile"
            result = normalizer.normalize_result(copy.deepcopy(raw_by_id[row["source_id"]]))
            manifest["current_source_id"] = row["source_id"]
            manifest["compiler_calls_attempted"] += 1
            _checkpoint(folder, manifest, frozen, cards)
            try:
                output = ec.compile_evidence(
                    result, goal=frozen["goal"], user_context=copy.deepcopy(frozen["user_context"]),
                    research_question=research_question, retrieved_at=frozen["retrieved_at"],
                )
            except (llm_client.LLMError, ec.EvidenceValidationError) as error:
                row.update(status="error", error_type=type(error).__name__)
            else:
                stage = "save_source_output"
                relative = f"results/{index:03d}.json"
                _write(folder / relative, output)  # Keep original compiler envelope.
                row.update(status=output["status"], reason=output["reason"], result_file=relative)
                for card in output["evidence_cards"]:
                    # Copy, don't modify/reclassify the compiler result.
                    cards.append({**card, "question_id": manifest["question_id"], "research_question": research_question})
            row.pop("not_processed_reason", None)
            manifest.pop("current_source_id", None)
            stage = "save_progress"
            _checkpoint(folder, manifest, frozen, cards)
            current = None
        manifest.update(
            status="completed_with_errors" if any(r["status"] == "error" for r in manifest["outcomes"]) else "completed",
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
        _checkpoint(folder, manifest, frozen, cards)
        return manifest
    except (Exception, KeyboardInterrupt) as error:
        if current is not None and current["status"] == "not_processed":
            current.update(status="error", error_type=type(error).__name__)
            current.pop("not_processed_reason", None)
        for row in manifest["outcomes"]:
            if row["selected"] and row["status"] == "not_processed":
                row["not_processed_reason"] = "batch_aborted"
        manifest.update(
            status="interrupted" if isinstance(error, KeyboardInterrupt) else "failed",
            error_type=type(error).__name__, stage=stage,
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
        try:
            _checkpoint(folder, manifest, frozen, cards)
        except Exception:
            pass  # Existing checkpoints may survive a failing filesystem.
        raise BatchRunError(type(error).__name__, folder) from None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--research-question", required=True)
    parser.add_argument("--max-candidates", type=int, choices=(1, 2, 3), default=3)
    parser.add_argument("--call-model", action="store_true", help="Authorize up to three model calls; default is offline.")
    parser.add_argument("--output-root", type=Path, default=Path("artifacts"))
    args = parser.parse_args()
    try:
        manifest = run_batch(args.run_dir, research_question=args.research_question,
                             max_candidates=args.max_candidates, call_model=args.call_model,
                             output_root=args.output_root)
    except (ValueError, BatchRunError) as error:
        raise SystemExit(f"ERROR: {error}") from None
    except OSError:
        raise SystemExit("ERROR: cannot create/write the local output folder; inspect local checkpoints.") from None
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    if not args.call_model:
        print("DRY RUN: no search, no model call. Add --call-model only after reviewing selection.")
    else:
        print(f"Saved evidence and source outcomes: {Path(manifest['output_dir']) / 'batch_evidence.json'}")
        if manifest["status"] == "completed_with_errors":
            raise SystemExit(1)


if __name__ == "__main__":
    main()
