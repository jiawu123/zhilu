"""JSON entry point for M2 planning and single-request evidence research.

Protocol draft: m2-entry-v0.1 (not a shared contracts schema).
plan: exactly {"goal": str, "user_context": object}; one model call by default.
research: exactly {goal, user_context, request}; never replans the goal.
stdin/stdout: one UTF-8 JSON document per process. Diagnostic output uses stderr.
--input/--output are optional local file conveniences, not request fields.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from typing import Any
from uuid import uuid4

PROTOCOL_VERSION = "m2-entry-v0.1"
MAX_INPUT_BYTES = 64_000
ERROR_MESSAGES = {
    "invalid_arguments": "Invalid arguments; use --help. Input and output must be different files.",
    "invalid_json": "Provide one UTF-8 JSON object, without duplicate keys or non-finite numbers.",
    "input_too_large": "Input must not exceed 64000 UTF-8 bytes.",
    "input_io_error": "Cannot read input; check the file or send JSON to stdin and close it.",
    "invalid_request": "Request fields must satisfy the selected action's input contract and bounds.",
    "dependency_unavailable": "Cannot load an execution dependency; check the active Python environment.",
    "invalid_plan_output": "The model output failed the existing planner validation.",
    "llm_error": "The model call failed. Check local credentials, endpoint and connectivity. No retry was made.",
    "authentication_failed": "Upstream authentication failed; check local authorization before retrying.",
    "configuration_error": "Research configuration is invalid or unavailable.",
    "rate_or_quota_limit": "An upstream rate or quota limit stopped research; no automatic retry was made.",
    "research_failed": "All attempted searches failed; this is not a no-evidence result.",
    "compilation_failed": "All attempted evidence compilations failed; this is not a no-evidence result.",
    "research_timeout": "The research deadline expired; completed work may already have incurred calls.",
    "evidence_id_conflict": "Different evidence content used the same ID; the result was rejected.",
    "execution_error": "Execution failed. Raw exception details were omitted to protect private data.",
    "output_io_error": "Cannot create or write the output file. Upstream calls may have occurred; do not retry blindly or use an old output as this run's result.",
    "interrupted": "Execution was interrupted; upstream receipt or billing may be unknown.",
}


class EntryError(Exception):
    """Allowlisted error category safe to return over the JSON protocol."""

    def __init__(self, code: str, exit_code: int = 1):
        self.code = code
        self.exit_code = exit_code
        super().__init__(ERROR_MESSAGES[code])


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # Do not echo arbitrary argument values, which may contain credentials.
        raise EntryError("invalid_arguments", 2)


def _load_planner():
    # Import lazily: --help needs no LLM dependencies.
    from zhihu_m2 import query_planner
    return query_planner


def _load_research_runner():
    from zhihu_m2 import research_runner
    return research_runner


def _unique_object(pairs: list[tuple[str, Any]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    return value


def _reject_constant(text: str) -> None:
    raise ValueError("non-finite number")


def _read_request(input_file: Path | None) -> dict:
    """Read bounded bytes, accept an optional BOM, never normalize source text."""
    try:
        if input_file is not None:
            with input_file.open("rb") as stream:
                raw = stream.read(MAX_INPUT_BYTES + 1)
        elif hasattr(sys.stdin, "buffer"):
            if sys.stdin.isatty():
                raise EntryError("input_io_error", 2)
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        else:
            # StringIO is useful in tests; ordinary CLI input uses bytes above.
            raw = sys.stdin.read(MAX_INPUT_BYTES + 1).encode("utf-8")
    except OSError:
        raise EntryError("input_io_error", 2) from None
    except UnicodeError:
        raise EntryError("invalid_json", 2) from None
    if len(raw) > MAX_INPUT_BYTES:
        raise EntryError("input_too_large", 2)
    try:
        value = json.loads(raw.decode("utf-8-sig"), object_pairs_hook=_unique_object,
                           parse_constant=_reject_constant, parse_float=_finite_float)
        if not isinstance(value, dict):
            raise ValueError("expected object")
        # Reject escaped lone surrogates before any model call or output write.
        json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
    except (ValueError, UnicodeError, RecursionError):
        raise EntryError("invalid_json", 2) from None
    return value


def plan(request: dict, *, dry_run: bool = False, max_questions: int = 3,
         queries_per_question: int = 2, planning_profile: str | None = None,
         metrics: dict | None = None) -> dict:
    """Reuse current planner. Never search, approve questions, or emit evidence.

    Returned question_id values remain the existing planner's internal IDs.
    Controller ID mapping and Goal Contract mapping are separate future work.
    """
    if not isinstance(request, dict) or set(request) != {"goal", "user_context"}:
        raise EntryError("invalid_request", 2)
    try:
        planner = _load_planner()
    except ImportError:
        raise EntryError("dependency_unavailable") from None
    try:
        frozen = planner.build_planner_input(
            request["goal"], request["user_context"],
            max_questions=max_questions, queries_per_question=queries_per_question,
            planning_profile=planning_profile,
        )
    except (ValueError, TypeError, RecursionError):
        raise EntryError("invalid_request", 2) from None
    if dry_run:
        return {"status": "dry_run", "input": frozen, "new_zhihu_search": False,
                "evidence_compilation_performed": False}
    if metrics is not None:
        # Attempts to invoke plan_research, not completed HTTP calls or charges.
        metrics["planner_calls_attempted"] += 1
    try:
        result = planner.plan_research(**frozen)
    except planner.PlannerValidationError:
        raise EntryError("invalid_plan_output") from None
    except planner.llm_client.LLMError:
        raise EntryError("llm_error") from None
    except ValueError as error:
        # RetrievalOptions uses the existing typed configuration error. Do not
        # promote arbitrary model/validation exceptions into configuration errors.
        from zhihu_m2.research_runner import ResearchError
        if isinstance(error, ResearchError) and error.code == "configuration_error":
            raise EntryError("configuration_error") from None
        raise
    if not isinstance(result, dict) or result.get("status") not in {
        "ready_for_review", "needs_clarification"
    }:
        raise EntryError("invalid_plan_output")
    return result


def research(request: dict, *, metrics: dict | None = None) -> dict:
    """Execute one request through the runner, preserving raw compiler outputs."""
    try:
        runner = _load_research_runner()
    except ImportError:
        raise EntryError("dependency_unavailable") from None
    try:
        return runner.run_research(request, metrics=metrics)
    except runner.ResearchError as error:
        code = error.code if error.code in ERROR_MESSAGES else "execution_error"
        raise EntryError(code, 2 if code in {"invalid_request", "input_too_large"} else 1) from None


def _arguments(argv: list[str] | None) -> argparse.Namespace:
    parser = _Parser(description=__doc__, allow_abbrev=False)
    parser.add_argument("--action", required=True, choices=("plan", "research"))
    parser.add_argument("--input", type=Path, help="UTF-8 JSON file; otherwise read stdin to EOF")
    parser.add_argument("--output", type=Path, help="Also save the final response as UTF-8 JSON")
    parser.add_argument("--dry-run", action="store_true", help="plan input preview only; no model call")
    parser.add_argument("--max-questions", type=int, choices=(1, 2, 3))
    parser.add_argument("--queries-per-question", type=int, choices=(1, 2))
    parser.add_argument("--planning-profile", choices=("jia-p0-baseline",))
    args = parser.parse_args(argv)
    if args.action == "research" and (args.dry_run or args.max_questions is not None
            or args.queries_per_question is not None or args.planning_profile is not None):
        raise EntryError("invalid_arguments", 2)
    args.max_questions = args.max_questions if args.max_questions is not None else 3
    args.queries_per_question = args.queries_per_question if args.queries_per_question is not None else 2
    if args.planning_profile and (args.max_questions, args.queries_per_question) != (3, 2):
        raise EntryError("invalid_arguments", 2)
    return args


def _prepare_output(args: argparse.Namespace) -> Path | None:
    """Test output writability before spending tokens; use a unique temp file."""
    if args.output is None:
        return None
    if args.input is not None and args.input.resolve() == args.output.resolve():
        raise EntryError("invalid_arguments", 2)
    try:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        if args.output.exists() and not args.output.is_file():
            raise OSError("output is not a regular file")
        descriptor, name = tempfile.mkstemp(prefix=".pipeline-", suffix=".tmp", dir=args.output.parent)
        os.close(descriptor)
        return Path(name)
    except OSError:
        raise EntryError("output_io_error") from None


def _fail(response: dict, error: EntryError) -> None:
    response.update(ok=False, data=None,
                    error={"code": error.code, "message": ERROR_MESSAGES[error.code]})


def main(argv: list[str] | None = None) -> int:
    """One request per process; output exactly one JSON response except --help.

    Success (including a request for clarification) exits 0. Exit 1 is a runtime
    error, 2 invalid input/arguments, 130 interruption.
    No network retries or authentication setup are performed here.
    """
    response = {
        "protocol_version": PROTOCOL_VERSION, "run_id": "entry_" + uuid4().hex,
        "action": None, "ok": False, "data": None, "error": None,
        "metrics": {"planner_calls_attempted": 0, "new_zhihu_search": False,
                    "search_calls_attempted": 0, "compiler_calls_attempted": 0,
                    "candidate_count": 0, "evidence_count": 0,
                    "automatic_retries": False},
    }
    args, temporary, exit_code = None, None, 0
    try:
        try:
            args = _arguments(argv)
        except SystemExit as error:
            # Only explicit --help may exit without a JSON document.
            return int(error.code or 0)
        response["action"] = args.action
        temporary = _prepare_output(args)
        # This CLI uses a separate process per request. redirect_stdout is
        # process-global and must NOT wrap concurrent in-process requests.
        with redirect_stdout(sys.stderr):
            request = _read_request(args.input)
            if args.action == "plan":
                data = plan(request, dry_run=args.dry_run, max_questions=args.max_questions,
                            queries_per_question=args.queries_per_question,
                            planning_profile=args.planning_profile, metrics=response["metrics"])
            else:
                data = research(request, metrics=response["metrics"])
            # Check serialization before declaring success.
            json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        response.update(ok=True, data=data)
    except EntryError as error:
        _fail(response, error)
        exit_code = error.exit_code
    except KeyboardInterrupt:
        _fail(response, EntryError("interrupted", 130))
        exit_code = 130
    except SystemExit:
        # A library calling sys.exit() is a failed operation, even with code 0.
        _fail(response, EntryError("execution_error"))
        exit_code = 1
    except Exception:
        _fail(response, EntryError("execution_error"))
        exit_code = 1

    text = json.dumps(response, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    if temporary is not None:
        try:
            temporary.write_text(text, encoding="utf-8")
            temporary.replace(args.output)
        except OSError:
            _fail(response, EntryError("output_io_error"))
            exit_code = 1
            text = json.dumps(response, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
        finally:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                print("pipeline: temporary file cleanup failed", file=sys.stderr)
    # Diagnostic metadata only: never log the request, raw exception or keys.
    print(json.dumps({"event": "pipeline_finished", "run_id": response["run_id"],
                      "action": response["action"], "ok": response["ok"],
                      "error_code": response["error"]["code"] if response["error"] else None,
                      "planner_calls_attempted": response["metrics"]["planner_calls_attempted"]}),
          file=sys.stderr, flush=True)
    try:
        sys.stdout.write(text)
        sys.stdout.flush()
    except BrokenPipeError:
        return 1
    return exit_code


if __name__ == "__main__":
    # File output is independently UTF-8; this also handles redirected Windows
    # standard streams. Input uses binary reads to avoid locale decoding.
    for _stream in (sys.stdout, sys.stderr):
        if hasattr(_stream, "reconfigure"):
            _stream.reconfigure(encoding="utf-8", errors="backslashreplace")
    raise SystemExit(main())
