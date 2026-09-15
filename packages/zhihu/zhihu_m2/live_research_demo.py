"""Live smoke check: one Zhihu search -> rank -> compile ONE raw snippet.

Not the final multi-source research pipeline. First-ranked selection is solely
an API-budget choice for this check, not a semantic relevance or truth filter.
No requests on import. Reuses the existing clients, ranker and v0.1.1 compiler.
"""
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from zhihu_m2 import evidence_compiler, normalizer, ranker, zhihu_client

QUERY = "Agent Engineer 学习路线"
GOAL = "8周内完成一个可运行、带基本测试的 Agent 小项目。"
RESEARCH_QUESTION = "有 Python 基础的初学者，如何安排 Agent 项目实践并检验入门能力？"
SEARCH_COUNT = 5
DEMO_VERSION = "m2-live-demo-v0.1"


class LiveDemoError(RuntimeError):
    """Safe failure summary: never echo a raw response, key, or CLI stderr."""

    def __init__(self, stage: str, error_type: str, run_dir: Path):
        self.stage = stage
        self.error_type = error_type
        self.run_dir = run_dir
        super().__init__(
            f"stage={stage}, error_type={error_type}. "
            f"See local run folder: {run_dir}"
        )


def _write_json(path: Path, data: Any) -> None:
    """Save readable UTF-8 JSON. Refuse NaN/Infinity; do not coerce objects."""
    text = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8")


def run_live_demo(*, output_root: Path | str = "artifacts") -> Path:
    """Run once and return the directory holding its local records.

    One call to search_zhihu(count=5); zero/one call to compile_evidence.
    The compiler itself validates input before making its one model request.
    No automatic retry, fallback to another candidate, or rewriting of cards.
    Error and no_evidence are distinct. A successful search is saved BEFORE
    any normalization/ranking/model work, including its actual receipt time.
    """
    started = datetime.now(timezone.utc)
    run_name = "live_" + started.strftime("%Y%m%dT%H%M%S%fZ_") + uuid4().hex[:8]
    run_dir = Path(output_root) / run_name
    # Fail before network calls if the output directory cannot be created.
    run_dir.mkdir(parents=True, exist_ok=False)
    report_path = run_dir / "run_report.json"
    context = {"python_level": "beginner", "weekly_hours": 10, "is_demo": True}
    report: dict[str, Any] = {
        "demo_version": DEMO_VERSION,
        "compiler_version": evidence_compiler.COMPILER_VERSION,
        "status": "running", "stage": "search",
        "started_at": started.isoformat(),
        "query": QUERY, "goal": GOAL,
        "research_question": RESEARCH_QUESTION, "user_context": context,
        "requested_count": SEARCH_COUNT,
        "max_compiler_calls": 1,
        "candidate_policy": "first_ranked_for_smoke_test_only",
        "ranked_candidates": [],
    }
    _write_json(report_path, report)
    stage = "search"

    try:
        raw_results = zhihu_client.search_zhihu(QUERY, count=SEARCH_COUNT)
        received = datetime.now(timezone.utc)
        retrieved_at = received.isoformat()
        report["retrieved_at"] = retrieved_at
        stage = "save_snapshot"
        _write_json(run_dir / "search_snapshot.json", {
            "query": QUERY, "goal": GOAL,
            "research_question": RESEARCH_QUESTION, "user_context": context,
            "requested_count": SEARCH_COUNT,
            "retrieved_at": retrieved_at,
            "timestamp_meaning": "client_received_search_result",
            "source_scope": "search_snippet",
            "raw_results": raw_results,
        })

        stage = "normalize"
        results = normalizer.normalize_results(raw_results)
        report["retrieved_count"] = len(results)
        if not results:
            report.update(status="no_results", stage="finished")
            _write_json(report_path, report)
            return run_dir

        stage = "rank"
        score_time = received.timestamp()
        ranked = ranker.rank_results(results, QUERY, now_ts=score_time)
        report["score_now_ts"] = score_time
        for position, item in enumerate(ranked, start=1):
            report["ranked_candidates"].append({
                "rank": position,
                "source_id": f"zhihu:{item.content_type}:{item.content_id}",
                "title": item.title,
                "url": item.url,
                "score": ranker.evidence_score(item, QUERY, now_ts=score_time),
                "selected_for_this_run": position == 1,
            })

        stage = "compile"
        report["stage"] = stage
        _write_json(report_path, report)
        # Pass the RAW normalized snippet, not ranker.clean_content().
        # Do not let the ranker score determine whether an evidence card exists.
        output = evidence_compiler.compile_evidence(
            ranked[0],
            goal=GOAL,
            user_context=context,
            research_question=RESEARCH_QUESTION,
            retrieved_at=retrieved_at,
        )
        stage = "save_output"
        _write_json(run_dir / "evidence.json", output)
        report.update(status=output["status"], stage="finished")
        report["card_count"] = len(output["evidence_cards"])
        _write_json(report_path, report)
        return run_dir

    except Exception as error:
        # Record error classification, not text that might contain user data.
        # Catch only to preserve the diagnostic record, then report failure.
        report.update(status="error", stage=stage, error_type=type(error).__name__)
        try:
            _write_json(report_path, report)
        except OSError:
            pass  # A failing disk may prevent the final report; existing files remain.
        raise LiveDemoError(stage, type(error).__name__, run_dir) from None


def main() -> None:
    print("LIVE: one Zhihu search (up to 5 results), at most one DeepSeek call.")
    print("Demo context. Search snippets only. No retries or independent fact verification.")
    try:
        run_dir = run_live_demo()
    except LiveDemoError as error:
        raise SystemExit(f"ERROR: {error}") from None
    except OSError:
        raise SystemExit("ERROR: cannot create or write the local output folder.") from None

    print(f"Saved run: {run_dir.resolve()}")
    evidence_path = run_dir / "evidence.json"
    if evidence_path.exists():
        print(evidence_path.read_text(encoding="utf-8"))
    else:
        print("status=no_results; no DeepSeek call was made.")


if __name__ == "__main__":
    main()