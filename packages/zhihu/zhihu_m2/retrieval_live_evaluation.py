"""Explicit, budgeted live experiments. Imported offline without any I/O.

Snapshots contain only authorized search excerpts, never fetched full text.
The persistent ledger reserves every attempt before I/O; reopening it never
resets the budget. Human labels are always left pending.
"""
from __future__ import annotations

import copy
from dataclasses import asdict
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import time

from zhihu_m2.research_runner import ResearchError, validate_research_input


def utc_now():
    return datetime.now(timezone.utc).isoformat()


def write_json(path, value):
    path = Path(path)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2), encoding='utf-8')
    temporary.replace(path)


class LiveLedger:
    LIMITS = {'search': 24, 'compiler': 24, 'planner': 8}

    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'ledger.json'
        self.state = json.loads(self.path.read_text(encoding='utf-8')) if self.path.exists() else {
            'created_at': utc_now(), 'attempts': [], 'quality_status': 'needs_human_review'}

    def reserve(self, kind, metadata):
        if kind not in self.LIMITS or sum(a['kind'] == kind for a in self.state['attempts']) >= self.LIMITS[kind]:
            raise ResearchError('configuration_error')
        record = {'kind': kind, 'started_at': utc_now(), 'status': 'reserved', **metadata}
        self.state['attempts'].append(record)
        write_json(self.path, self.state)
        return record

    def finish(self, record, **metadata):
        record.update(completed_at=utc_now(), **metadata)
        write_json(self.path, self.state)


def collect_cases(taskfile, ledger, *, search=None):
    from zhihu_m2.plan_retrieval import search_once, SearchError, BLOCKING_ERRORS
    from zhihu_m2.normalizer import normalize_result
    from zhihu_m2.evidence_compiler import _source_record
    from zhihu_m2.candidate_pool import SearchOccurrence, variant_key
    search = search or search_once
    cases = copy.deepcopy(taskfile.get('cases', taskfile.get('questions')))
    ids = [c['case_id'] for c in cases]
    if len(ids) != len(set(ids)) or not 1 <= len(cases) <= 12:
        raise ResearchError('invalid_request')
    for case in cases:
        validate_research_input({key: case[key] for key in ('goal', 'user_context', 'request')})
        if len(case['request']['searchQueries']) > 2:
            raise ResearchError('invalid_request')
        case.update(synthetic=False, observations=[], successful_query_indexes=[], query_outcomes=[], grades=None,
                    human_label_status='needs_human_review', capture_status='not_collected',
                    engineering_metrics={'search_calls_attempted': 0, 'errors': []}, now_ts=time.time())
    result = {'evaluation_scope': 'real_frozen_candidates', 'batch_status': 'complete', 'cases': cases}
    stopped = False
    for case in cases:
        if stopped: break
        case['candidate_capture_time'] = utc_now()
        case['candidate_capture_id'] = case['case_id'] + '@' + case['candidate_capture_time']
        for index, query in enumerate(case['request']['searchQueries']):
            attempt = ledger.reserve('search', {'case_id': case['case_id'], 'query_index': index})
            started = time.monotonic()
            case['engineering_metrics']['search_calls_attempted'] += 1
            outcome = {'query_index': index, 'status': 'reserved', 'raw_item_count': None}
            case['query_outcomes'].append(outcome)
            try:
                response = search(query, count=5, timeout=90)
                if (type(response) is not dict or type(response.get('Code')) is not int or response['Code'] != 0 or
                    type(response.get('Data')) is not dict or type(response['Data'].get('Items')) is not list):
                    raise SearchError('invalid_response')
                timestamp = utc_now()
                outcome.update(status='ok', raw_item_count=len(response['Data']['Items']), retrieved_at=timestamp)
                case['successful_query_indexes'].append(index)
                for rank, raw in enumerate(response['Data']['Items'], 1):
                    try:
                        item = normalize_result(copy.deepcopy(raw))
                        source = _source_record(item, timestamp)
                        for field in ('ranking_score', 'vote_up_count', 'comment_count', 'edit_time'):
                            value = getattr(item, field)
                            if type(value) not in (int, float) or not math.isfinite(value):
                                raise ValueError('invalid numeric metadata')
                        occurrence = SearchOccurrence(index, rank, timestamp, item)
                        observation = {'query_index': index, 'result_rank': rank, 'retrieved_at': timestamp,
                            'result': asdict(item), 'source_id': source['id'],
                            'variant_key': variant_key(occurrence),
                            'snippet_sha256': hashlib.sha256(item.content_text.encode('utf-8')).hexdigest()}
                    except (ValueError, TypeError, AttributeError, UnicodeError):
                        case['engineering_metrics']['errors'].append({'code': 'source_invalid', 'query_index': index})
                        continue
                    case['observations'].append(observation)
                ledger.finish(attempt, status='ok', duration_seconds=time.monotonic()-started,
                              captured_at=timestamp, result_count=len(response['Data']['Items']))
            except SearchError as error:
                code = {'authentication': 'authentication_failed', 'rate_or_quota_limit': 'rate_or_quota_limit',
                        'cli_unavailable': 'dependency_unavailable', 'cli_arguments': 'configuration_error'}.get(error.kind, 'search_' + error.kind)
                case['engineering_metrics']['errors'].append({'code': code, 'query_index': index})
                outcome.update(status=code, search_error_kind=error.kind)
                ledger.finish(attempt, status=code, duration_seconds=time.monotonic()-started)
                if error.kind in BLOCKING_ERRORS:
                    result['batch_status'] = code; stopped = True; break
            except Exception:
                outcome.update(status='execution_error')
                ledger.finish(attempt, status='execution_error', duration_seconds=time.monotonic()-started)
                case['engineering_metrics']['errors'].append({'code': 'execution_error', 'query_index': index})
                result['batch_status'] = 'execution_error'; stopped = True; break
        case['capture_status'] = ('failed' if not case['successful_query_indexes'] else
            'partial' if case['engineering_metrics']['errors'] else 'complete')
        write_json(ledger.directory / 'candidates.json', result)
    if result['batch_status'] == 'complete' and any(c['capture_status'] != 'complete' for c in cases):
        result['batch_status'] = 'partial' if any(c['successful_query_indexes'] for c in cases) else 'failed'
    write_json(ledger.directory / 'candidates.json', result)
    return result


def replay_case(case, query_index):
    """Reconstruct positions including invalid gaps, without joining excerpts."""
    from zhihu_m2.plan_retrieval import SearchError
    outcome = next((item for item in case.get('query_outcomes', []) if item['query_index'] == query_index), {})
    if query_index not in case['successful_query_indexes']:
        kind = outcome.get('search_error_kind')
        if kind is None:
            codes = {item['code'] for item in case.get('engineering_metrics', {}).get('errors', []) if item.get('query_index') == query_index}
            mapping = {'authentication_failed': 'authentication', 'rate_or_quota_limit': 'rate_or_quota_limit',
                       'dependency_unavailable': 'cli_unavailable', 'configuration_error': 'cli_arguments'}
            kind = next((mapping.get(code, code.removeprefix('search_')) for code in sorted(codes) if code in mapping or code.startswith('search_')), 'invalid_response')
        raise SearchError(kind)
    observations = [o for o in case['observations'] if o['query_index'] == query_index]
    last_rank = max((o['result_rank'] for o in observations), default=0)
    raw_count = outcome.get('raw_item_count', last_rank)
    if type(raw_count) is not int or raw_count < last_rank:
        raise ResearchError('invalid_request')
    items = [None] * raw_count
    for item in observations:
        items[item['result_rank']-1] = {'result': copy.deepcopy(item['result'])}
    return {'Code': 0, 'Data': {'Items': items}}


def audited_model_call(value, *, operation, profile, arguments):
    """Top-level spawn target. Audit actual HTTP JSON messages, never headers.

    This wrapper lives only in the explicit experiment, not production calls.
    The caller runs it through the existing terminable compiler worker.
    """
    import httpx
    from zhihu_m2 import llm_client, query_planner, evidence_compiler
    from zhihu_m2.research_runner import _llm_fatal
    previous = httpx.Client.post
    audit = {'model': llm_client.MODEL, 'http_calls_attempted': 0, 'prompt_sha256': None}
    def post(client, url, **kwargs):
        body = kwargs['json']
        audit.update(http_calls_attempted=audit['http_calls_attempted'] + 1, model=body['model'],
            prompt_sha256=hashlib.sha256(json.dumps(body['messages'], ensure_ascii=False,
                sort_keys=True, separators=(',', ':')).encode('utf-8')).hexdigest())
        return previous(client, url, **kwargs)
    httpx.Client.post = post
    started = time.monotonic()
    try:
        if operation == 'compiler':
            result = evidence_compiler.compile_evidence(value, retrieval_profile=profile, **arguments)
        elif operation == 'planner':
            os.environ['ZHIHU_RETRIEVAL_PROFILE'] = profile
            result = query_planner.plan_research(**arguments)
        else:
            raise ResearchError('configuration_error')
        packet = {'ok': True, 'result': result}
    except llm_client.LLMError as error:
        packet = {'ok': False, 'code': _llm_fatal(error) or 'llm_error'}
    except (evidence_compiler.EvidenceValidationError, query_planner.PlannerValidationError):
        packet = {'ok': False, 'code': 'validation_error'}
    except Exception:
        packet = {'ok': False, 'code': 'execution_error'}
    finally:
        httpx.Client.post = previous
    audit['duration_seconds'] = time.monotonic() - started
    return {**packet, 'audit': audit}
