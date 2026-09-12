"""Opt-in, one-shot bounded live evaluation. Default/--help perform no live I/O."""
from __future__ import annotations

import argparse
import copy
from dataclasses import replace
from contextlib import contextmanager
import hashlib
import json
import math
from pathlib import Path
import sys
import time

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[1]
if str(PACKAGE) not in sys.path:
    sys.path.insert(0, str(PACKAGE))

from zhihu_m2 import research_runner as rr
from zhihu_m2.retrieval_live_evaluation import (
    LiveLedger, audited_model_call, collect_cases, replay_case, utc_now, write_json,
)

TASK_FILE = ROOT / 'docs/zhihu-retrieval-optimization/fixtures/evaluation_questions.json'
SELECTED_IDS = ('learn-01', 'career-01', 'team-01', 'craft-01')
FATAL_CODES = {'authentication_failed', 'rate_or_quota_limit', 'configuration_error', 'dependency_unavailable'}
PHASE_FILES = {'capture': 'candidates.json', 'compiler': 'compiler-results.json', 'planner': 'planner-results.json'}


def validate_output_dir(value):
    """Only the repository's ignored local-artifacts tree is eligible."""
    directory = Path(value).resolve()
    artifacts = (PACKAGE / 'artifacts').resolve()
    if not directory.is_relative_to(artifacts) or directory == artifacts:
        raise rr.ResearchError('configuration_error')
    return directory


@contextmanager
def phase_guard(directory, phase):
    """An exclusive lock prevents overlap; persistent started files prevent retry.

    A crash intentionally leaves the lock. The operator must investigate that
    state; this CLI never silently clears a stale lock or resets an attempt.
    """
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / '.live-evaluation.lock'
    try:
        handle = lock.open('x', encoding='utf-8')
    except FileExistsError:
        raise rr.ResearchError('configuration_error') from None
    try:
        with handle:
            json.dump({'phase': phase, 'started_at': utc_now()}, handle)
        marker = directory / (phase + '.started.json')
        if marker.exists() or (directory / PHASE_FILES[phase]).exists():
            raise rr.ResearchError('configuration_error')
        try:
            with marker.open('x', encoding='utf-8') as target:
                json.dump({'phase': phase, 'started_at': utc_now(), 'retry_allowed': False}, target)
        except FileExistsError:
            raise rr.ResearchError('configuration_error') from None
        yield
    finally:
        lock.unlink()


def model_attempt(value, *, operation, profile, arguments, metadata, ledger, timeout, worker=None):
    """Reserve before entering the killable worker, retaining safe transport audit."""
    from zhihu_m2.llm_client import LLMError
    from zhihu_m2.evidence_compiler import EvidenceValidationError
    if timeout <= 0:
        raise rr.ResearchError('research_timeout')
    for previous in ledger.state['attempts']:
        if (previous.get('kind') in {'compiler', 'planner'} and
                previous.get('status') in {'authentication_failed', 'rate_or_quota_limit'}):
            raise rr.ResearchError(previous['status'])
    record = ledger.reserve(operation, {**metadata, 'profile': profile})
    started = time.monotonic()
    worker = worker or rr._compile_with_deadline
    try:
        packet = worker(value, timeout=timeout, compiler=audited_model_call,
                        operation=operation, profile=profile, arguments=arguments)
    except (rr.ResearchError, LLMError, EvidenceValidationError) as error:
        code = (error.code if isinstance(error, rr.ResearchError) else
                rr._llm_fatal(error) or 'llm_error' if isinstance(error, LLMError) else 'validation_error')
        ledger.finish(record, status=code, duration_seconds=time.monotonic()-started)
        raise
    except Exception:
        ledger.finish(record, status='execution_error', duration_seconds=time.monotonic()-started)
        raise rr.ResearchError('execution_error') from None
    if not isinstance(packet, dict) or type(packet.get('ok')) is not bool:
        ledger.finish(record, status='execution_error', duration_seconds=time.monotonic()-started)
        raise rr.ResearchError('execution_error')
    code = 'ok' if packet['ok'] else packet.get('code', 'execution_error')
    if code not in FATAL_CODES | {'ok', 'llm_error', 'validation_error', 'execution_error', 'research_timeout'}:
        code = 'execution_error'
    # Audit only the fields emitted by the transport wrapper; never headers/env.
    audit = packet.get('audit', {})
    audit = {key: audit[key] for key in ('model', 'http_calls_attempted', 'prompt_sha256', 'duration_seconds') if key in audit}
    ledger.finish(record, status=code, audit=audit, duration_seconds=time.monotonic()-started)
    print(json.dumps({'operation': operation, 'profile': profile, 'status': code,
                      'attempt_number': sum(a['kind'] == operation for a in ledger.state['attempts'])}))
    if code == 'ok':
        return packet['result']
    if code == 'llm_error':
        raise LLMError('Model transport failed.')
    if code == 'validation_error':
        raise EvidenceValidationError('Model output failed validation.')
    raise rr.ResearchError(code)


def selected_cases(cases):
    mapping = {case['case_id']: case for case in cases}
    if len(mapping) != len(cases) or any(cid not in mapping for cid in SELECTED_IDS):
        raise rr.ResearchError('invalid_request')
    selected = [mapping[cid] for cid in SELECTED_IDS]
    if any(case.get('split') != 'development' for case in selected) or len({c['domain'] for c in selected}) != 4:
        raise rr.ResearchError('invalid_request')
    return selected


def update_batch_status(results):
    """Report outcomes separately from merely reaching the end of a loop."""
    statuses = [case['status'] for case in results['cases']]
    results['successful_count'] = sum(status in {'ok', 'no_evidence'} for status in statuses)
    results['failed_count'] = sum(status not in {'ok', 'no_evidence', 'partial', 'capture_not_available'} for status in statuses)
    if results['batch_status'] in FATAL_CODES:
        return
    if all(status in {'ok', 'no_evidence'} for status in statuses):
        results['batch_status'] = 'complete'
    elif any(status in {'ok', 'no_evidence', 'partial', 'capture_not_available'} for status in statuses):
        results['batch_status'] = 'partial'
    else:
        results['batch_status'] = 'failed'


def compile_phase(snapshot, ledger):
    from zhihu_m2.models import ZhihuResult
    from zhihu_m2.candidate_pool import SearchOccurrence, variant_key
    from zhihu_m2.retrieval_options import RetrievalOptions
    from zhihu_m2.ranker import rank_results
    from zhihu_m2.ranker_v3 import rank_candidates
    selected = selected_cases(snapshot['cases'])
    missing = [case['case_id'] for case in selected if not case.get('successful_query_indexes')]
    results = {'evaluation_scope': 'real_frozen_candidates', 'quality_status': 'needs_human_review',
               'batch_status': 'partial' if missing else 'complete',
               'missing_case_ids': missing, 'cases': []}
    for case in selected:
        for profile in ('legacy', 'v3'):
            if case['case_id'] in missing:
                results['cases'].append({'case_id': case['case_id'], 'profile': profile,
                    'quality_status': 'needs_human_review', 'status': 'capture_not_available', 'metrics': None})
                update_batch_status(results)
                write_json(ledger.directory / PHASE_FILES['compiler'], results)
                continue
            ranking_now = case.get('now_ts')
            if type(ranking_now) not in (int, float) or not math.isfinite(ranking_now):
                raise rr.ResearchError('invalid_request')
            deadline = time.monotonic() + 600
            position = -1
            def search(query, **kwargs):
                nonlocal position
                position += 1
                if query != case['request']['searchQueries'][position]:
                    raise rr.ResearchError('execution_error')
                return replay_case(case, position)
            def now():
                observations = [o for o in case['observations'] if o['query_index'] == position]
                return observations[0]['retrieved_at'] if observations else case['candidate_capture_time']
            def rank_legacy(values, query):
                return rank_results(values, query, now_ts=ranking_now)
            def rank_v3(pool, context, successful):
                return rank_candidates(pool, replace(context, now_ts=ranking_now), successful)
            def compile_result(value, **kwargs):
                arguments = dict(kwargs)
                arguments.pop('retrieval_profile', None)
                occurrence = SearchOccurrence(0, 1, arguments['retrieved_at'], value)
                metadata = {'case_id': case['case_id'],
                    'source_id': f'zhihu:{value.content_type}:{value.content_id}',
                    'variant_key': variant_key(occurrence),
                    'snippet_sha256': hashlib.sha256(value.content_text.encode('utf-8')).hexdigest(),
                    'captured_at': arguments['retrieved_at'],
                    'candidate_capture_id': case.get('candidate_capture_id')}
                return model_attempt(value, operation='compiler', profile=profile, arguments=arguments,
                    metadata=metadata, ledger=ledger, timeout=deadline-time.monotonic())
            request = {key: copy.deepcopy(case[key]) for key in ('goal', 'user_context', 'request')}
            request['request']['evidenceLimit'] = min(request['request']['evidenceLimit'], 2)
            metrics, diagnostics = {}, []
            entry = {'case_id': case['case_id'], 'profile': profile,
                     'quality_status': 'needs_human_review', 'candidate_capture_id': case.get('candidate_capture_id')}
            entry.update(ranking_now_ts=ranking_now, metrics_scope='snapshot_replay_not_live_search',
                         replay_metadata_complete='query_outcomes' in case)
            try:
                entry['data'] = rr.run_research(request,
                    dependencies=rr.ResearchDependencies(search=search,
                        normalize=lambda raw: ZhihuResult(**raw['result']), compile=compile_result,
                        now=now, diagnostics=diagnostics, rank=rank_legacy, rank_v3=rank_v3),
                    options=RetrievalOptions(profile),
                    limits=rr.ResearchLimits(search_count=5, max_compiler_calls=2, deadline_seconds=600),
                    metrics=metrics)
                entry['status'] = entry['data']['status']
            except rr.ResearchError as error:
                entry['status'] = error.code
                if error.code in FATAL_CODES:
                    results['batch_status'] = error.code
            entry.update(metrics=metrics, diagnostics=diagnostics)
            results['cases'].append(entry)
            update_batch_status(results)
            write_json(ledger.directory / PHASE_FILES['compiler'], results)
            print(json.dumps({'phase': 'compiler', 'profile': profile, 'status': entry['status'],
                              'completed_case_profiles': len(results['cases'])}))
            if results['batch_status'] in FATAL_CODES:
                return results
    results['synthetic_prompt_review'] = prompt_review_phase(ledger)
    if results['synthetic_prompt_review']['batch_status'] in FATAL_CODES:
        results['batch_status'] = results['synthetic_prompt_review']['batch_status']
    elif results['synthetic_prompt_review']['batch_status'] != 'complete' and results['batch_status'] == 'complete':
        results['batch_status'] = 'partial'
    write_json(ledger.directory / PHASE_FILES['compiler'], results)
    return results


def prompt_review_phase(ledger):
    """Six separately labelled synthetic prompt calls; never fetch fixture URLs."""
    from zhihu_m2.models import ZhihuResult
    from zhihu_m2.candidate_pool import SearchOccurrence, variant_key
    from zhihu_m2.llm_client import LLMError
    from zhihu_m2.evidence_compiler import EvidenceValidationError
    fixture = json.loads((PACKAGE / 'tests/fixtures/retrieval_v3/prompt_review_cases.json').read_text(encoding='utf-8'))
    if len(fixture['cases']) != 3 or fixture['fixture_kind'] != 'synthetic_prompt_review':
        raise rr.ResearchError('configuration_error')
    results = {'evaluation_scope': 'synthetic_prompt_review', 'quality_status': 'needs_human_review',
               'batch_status': 'complete', 'cases': []}
    for case in fixture['cases']:
        source = {'author_signature': '', 'author_badge_text': '', 'vote_up_count': 0,
                  'comment_count': 0, 'authority_level': '', 'ranking_score': 0.0, 'edit_time': 0,
                  **case['source']}
        result = ZhihuResult(**source)
        timestamp = utc_now()
        occurrence = SearchOccurrence(0, 1, timestamp, result)
        for profile in ('legacy', 'v3'):
            entry = {'case_id': case['case_id'], 'pair_id': case['pair_id'], 'profile': profile,
                     'quality_status': 'needs_human_review', 'expected_behavior': case['expected_behavior'],
                     'direct_answer': None, 'support_label': None, 'reviewer': None}
            try:
                entry['output'] = model_attempt(result, operation='compiler', profile=profile,
                    arguments={'goal': case['goal'], 'user_context': copy.deepcopy(case['user_context']),
                        'research_question': case['research_question'], 'retrieved_at': timestamp},
                    metadata={'case_id': case['case_id'], 'evaluation_scope': 'synthetic_prompt_review',
                        'source_id': f'zhihu:{result.content_type}:{result.content_id}',
                        'variant_key': variant_key(occurrence),
                        'snippet_sha256': hashlib.sha256(result.content_text.encode('utf-8')).hexdigest(),
                        'captured_at': timestamp, 'synthetic': True}, ledger=ledger, timeout=600)
                entry['status'] = 'ok'
            except (rr.ResearchError, LLMError, EvidenceValidationError) as error:
                entry['status'] = (error.code if isinstance(error, rr.ResearchError) else
                                   'llm_error' if isinstance(error, LLMError) else 'validation_error')
                if entry['status'] in FATAL_CODES:
                    results['batch_status'] = entry['status']
            results['cases'].append(entry)
            update_batch_status(results)
            write_json(ledger.directory / 'paired-prompts.json', results)
            if results['batch_status'] in FATAL_CODES:
                return results
    return results


def planner_phase(taskfile, ledger):
    from zhihu_m2.llm_client import LLMError
    from zhihu_m2.evidence_compiler import EvidenceValidationError
    results = {'evaluation_scope': 'real_planner_review', 'quality_status': 'needs_human_review',
               'queries_executed': False, 'batch_status': 'complete', 'cases': []}
    for case in selected_cases(taskfile['questions']):
        for profile in ('legacy', 'v3'):
            entry = {'case_id': case['case_id'], 'profile': profile, 'quality_status': 'needs_human_review'}
            try:
                entry['output'] = model_attempt(None, operation='planner', profile=profile,
                    arguments={'goal': case['goal'], 'user_context': copy.deepcopy(case['user_context']),
                               'max_questions': 3, 'queries_per_question': 2},
                    metadata={'case_id': case['case_id']}, ledger=ledger, timeout=600)
                entry['status'] = 'ok'
            except (rr.ResearchError, LLMError, EvidenceValidationError) as error:
                entry['status'] = (error.code if isinstance(error, rr.ResearchError) else
                                   'llm_error' if isinstance(error, LLMError) else 'validation_error')
                if entry['status'] in FATAL_CODES:
                    results['batch_status'] = entry['status']
            results['cases'].append(entry)
            update_batch_status(results)
            write_json(ledger.directory / PHASE_FILES['planner'], results)
            if results['batch_status'] in FATAL_CODES:
                return results
    return results


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true', help='Explicitly authorize the selected live phase.')
    parser.add_argument('--phase', choices=tuple(PHASE_FILES))
    parser.add_argument('--output-dir', default=str(PACKAGE/'artifacts/retrieval-v3-live'))
    args = parser.parse_args(argv)
    if not args.live:
        print(json.dumps({'status': 'offline', 'live_calls_attempted': 0,
                          'message': 'Use --live with --phase to execute a bounded phase.'}))
        return 0
    try:
        if args.phase is None:
            raise rr.ResearchError('configuration_error')
        directory = validate_output_dir(args.output_dir)
        taskfile = json.loads(TASK_FILE.read_text(encoding='utf-8'))
        selected_cases(taskfile['questions'])
        snapshot = None
        if args.phase == 'compiler':
            snapshot = json.loads((directory/'candidates.json').read_text(encoding='utf-8'))
            selected_cases(snapshot['cases'])
        with phase_guard(directory, args.phase):
            ledger = LiveLedger(directory)
            if args.phase == 'capture':
                result = collect_cases({'cases': taskfile['questions']}, ledger)
            elif args.phase == 'compiler':
                result = compile_phase(snapshot, ledger)
            else:
                result = planner_phase(taskfile, ledger)
            print(json.dumps({'phase': args.phase, 'status': result['batch_status'],
                              'quality_status': 'needs_human_review'}))
            return 0 if result['batch_status'] == 'complete' else 1
    except rr.ResearchError as error:
        print(json.dumps({'status': error.code}), file=sys.stderr)
        return error.exit_code
    except (Exception, KeyboardInterrupt):
        print(json.dumps({'status': 'execution_error'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
