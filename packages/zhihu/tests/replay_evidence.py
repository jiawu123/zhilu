"""Replay one selected source from a saved successful live-demo run.

Default: offline dry run. --call-model permits ONE model call, with no new
Zhihu search, re-ranking, content cleaning, automatic retries or API changes.
Original inputs are checked and kept intact; every paid attempt has a new
local folder. Structural validation is NOT a semantic quality evaluation.
"""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from zhihu_m2 import evidence_compiler as ec
from zhihu_m2 import llm_client
from zhihu_m2.models import ZhihuResult


class ReplayError(RuntimeError):
    """Failure with a local record; never expose model text or credentials."""

    def __init__(self, error_type: str, output_dir: Path):
        self.output_dir = output_dir
        super().__init__(f"error_type={error_type}; see {output_dir / 'manifest.json'}")


def _load_json(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > 4_000_000:
            raise ValueError("Saved input is too large for this replay tool.")
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        raise ValueError(f"Cannot read valid JSON from local file: {path.name}") from None
    if not isinstance(value, dict):
        raise ValueError("Saved input must be a JSON object.")
    return value


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def _hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _load_replay(run_dir: Path) -> tuple[ZhihuResult, dict[str, Any]]:
    snapshot = _load_json(run_dir / "search_snapshot.json")
    previous = _load_json(run_dir / "evidence.json")
    old_source = previous.get("source")
    raw_results = snapshot.get("raw_results")
    if not isinstance(old_source, dict) or not isinstance(raw_results, list):
        raise ValueError("Need a prior evidence source and raw_results list.")
    if snapshot.get("source_scope") != "search_snippet":
        raise ValueError("Only original search_snippet snapshots are supported.")
    matches = []
    for raw in raw_results:
        if not isinstance(raw, dict):
            raise ValueError("raw_results must contain objects.")
        identifier = f"zhihu:{raw.get('ContentType')}:{raw.get('ContentID')}"
        if identifier == old_source.get("id"):
            matches.append(raw)
    if len(matches) != 1:
        raise ValueError("Selected source must match exactly one original search item.")
    raw = matches[0]
    # Same field mapping as the existing normalizer; scores are not used here.
    result = ZhihuResult(
        title=raw.get("Title", ""), content_type=raw.get("ContentType", ""),
        content_id=raw.get("ContentID", ""), author_name=raw.get("AuthorName", ""),
        author_signature=raw.get("AuthorSignature", ""),
        author_badge_text=raw.get("AuthorBadgeText", ""),
        content_text=raw.get("ContentText", ""), url=raw.get("Url", ""),
        vote_up_count=raw.get("VoteUpCount", 0), comment_count=raw.get("CommentCount", 0),
        authority_level=raw.get("AuthorityLevel", ""),
        ranking_score=raw.get("RankingScore", 0.0), edit_time=raw.get("EditTime", 0),
    )
    timestamp = snapshot.get("retrieved_at")
    if not isinstance(timestamp, str) or not timestamp.strip():
        raise ValueError("Replay requires the originally recorded retrieval timestamp.")
    # Reuse the compiler's existing local provenance validator; no model call.
    source = ec._source_record(result, timestamp)
    for field, value in source.items():
        if old_source.get(field) != value:
            raise ValueError(f"Saved snapshot and evidence disagree on source.{field}.")

    for field in ("goal", "research_question"):
        value = snapshot.get(field)
        if not isinstance(value, str) or not value.strip() or len(value) > 2000:
            raise ValueError(f"Snapshot requires a nonempty {field} of at most 2000 characters.")
    context = snapshot.get("user_context")
    if not isinstance(context, dict):
        raise ValueError("Snapshot requires a user_context object.")
    try:
        encoded = json.dumps(context, ensure_ascii=False, allow_nan=False)
    except (ValueError, TypeError, OverflowError):
        raise ValueError("user_context must contain valid JSON values.") from None
    if len(encoded) > 8000:
        raise ValueError("user_context is too long.")
    frozen = {
        "query": snapshot.get("query"), "goal": snapshot["goal"],
        "research_question": snapshot["research_question"], "user_context": context,
        "retrieved_at": timestamp, "source": source,
    }
    return result, frozen


def replay_saved_run(
    run_dir: Path | str,
    *,
    call_model: bool = False,
    output_root: Path | str = "artifacts",
) -> dict[str, Any]:
    """Return a dry-run manifest, or save one checked model response in a new folder."""
    run_dir = Path(run_dir)
    result, frozen = _load_replay(run_dir)
    source = frozen["source"]
    manifest = {
        "status": "dry_run", "compiler_version": ec.COMPILER_VERSION,
        "model": llm_client.MODEL, "previous_run": str(run_dir.resolve()),
        "source_id": source["id"], "retrieved_at": frozen["retrieved_at"],
        "research_question": frozen["research_question"],
        "system_prompt_sha256": _hash(ec.SYSTEM_PROMPT),
        "snippet_sha256": _hash(source["snippet"]),
        "frozen_input_sha256": _hash(json.dumps(frozen, ensure_ascii=False, sort_keys=True)),
        "model_calls_attempted": 0, "new_zhihu_search": False,
        "semantic_support_checked": False,
    }
    if not call_model:
        return manifest

    now = datetime.now(timezone.utc)
    folder = Path(output_root) / ("replay_" + now.strftime("%Y%m%dT%H%M%S%fZ_") + uuid4().hex[:8])
    folder.mkdir(parents=True, exist_ok=False)
    _write_json(folder / "replay_input.json", frozen)
    (folder / "system_prompt.txt").write_text(ec.SYSTEM_PROMPT, encoding="utf-8")
    manifest.update(status="running", compiled_at=now.isoformat(), output_dir=str(folder.resolve()))
    _write_json(folder / "manifest.json", manifest)
    try:
        manifest["model_calls_attempted"] = 1
        _write_json(folder / "manifest.json", manifest)
        output = ec.compile_evidence(
            result, goal=frozen["goal"], user_context=frozen["user_context"],
            research_question=frozen["research_question"], retrieved_at=frozen["retrieved_at"],
        )
        _write_json(folder / "evidence.json", output)
        manifest.update(status=output["status"], card_count=len(output["evidence_cards"]))
        _write_json(folder / "manifest.json", manifest)
    except Exception as error:
        manifest.update(status="error", error_type=type(error).__name__)
        try:
            _write_json(folder / "manifest.json", manifest)
        except OSError:
            pass
        raise ReplayError(type(error).__name__, folder) from None
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--call-model", action="store_true", help="Permit one paid model call; default is offline.")
    parser.add_argument("--output-root", default=Path("artifacts"), type=Path)
    args = parser.parse_args()
    try:
        manifest = replay_saved_run(args.run_dir, call_model=args.call_model, output_root=args.output_root)
    except (ValueError, OSError, ReplayError) as error:
        raise SystemExit(f"ERROR: {error}") from None
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    if args.call_model:
        print((Path(manifest["output_dir"]) / "evidence.json").read_text(encoding="utf-8"))
    else:
        print("DRY RUN ONLY: no search, no model call. Add --call-model to make one request.")


if __name__ == "__main__":
    main()
