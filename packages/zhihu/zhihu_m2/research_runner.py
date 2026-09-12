"""One shared ResearchRequest; no replanning, retries, cache or filesystem writes.

Compiler output stays in its original schema. ``dependencies.trace`` retains
query/source occurrences and variant hashes locally and is never put on stdout.
"""
from __future__ import annotations

import copy
from contextlib import redirect_stderr, redirect_stdout
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import json
import math
import multiprocessing
import os
import re
import time
import unicodedata
from typing import Callable


ERROR_CODES = frozenset({
    'invalid_request', 'input_too_large', 'dependency_unavailable',
    'authentication_failed', 'configuration_error', 'rate_or_quota_limit',
    'research_failed', 'compilation_failed', 'research_timeout',
    'execution_error', 'evidence_id_conflict',
})
ISSUE_CODES = frozenset({
    'search_timeout', 'search_network_error', 'search_upstream_error',
    'search_invalid_response', 'source_invalid', 'rank_failed',
    'compiler_failed', 'compiler_invalid_output', 'compiler_budget_exhausted',
    'freshness_not_enforced',
})


class ResearchError(ValueError):
    """Safe category only: do not retain upstream exception text or payload."""

    def __init__(self, code: str):
        self.code = code if code in ERROR_CODES else 'execution_error'
        self.exit_code = 2 if self.code in {'invalid_request', 'input_too_large'} else 1
        super().__init__(self.code)


def _json(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def _text(value, limit):
    if type(value) is not str or not value.strip() or len(value) > limit:
        raise ResearchError('invalid_request')


def _plain(value, depth=0):
    if depth > 12:
        raise ResearchError('invalid_request')
    if type(value) is dict:
        for key, item in value.items():
            if type(key) is not str:
                raise ResearchError('invalid_request')
            normalized = re.sub(r'[_\-\s]', '', key).casefold()
            if normalized in {'apikey', 'deepseekapikey', 'accesssecret', 'secret',
                              'password', 'authorization', 'token', 'pythonpath',
                              'pythonexecutable', 'command', 'executable', 'env'}:
                raise ResearchError('invalid_request')
            _plain(item, depth + 1)
    elif type(value) is list:
        for item in value:
            _plain(item, depth + 1)
    elif value is None or type(value) in (str, int, bool):
        pass
    elif type(value) is float and math.isfinite(value):
        pass
    else:
        raise ResearchError('invalid_request')


def _context(payload):
    request = payload['request']
    constraints = {'relevantUserConditions': request['relevantUserConditions']}
    if 'freshness' in request:
        constraints['freshness'] = request['freshness']
    return {'confirmed_user_context': payload['user_context'],
            'research_request_constraints': constraints}


def validate_research_input(payload: dict) -> dict:
    """Validate and return a defensive copy. No I/O or model calls."""
    try:
        _plain(payload)
        if type(payload) is not dict or set(payload) != {'goal', 'user_context', 'request'}:
            raise ResearchError('invalid_request')
        if len(_json(payload).encode('utf-8')) > 64000:
            raise ResearchError('input_too_large')
        _text(payload['goal'], 2000)
        if type(payload['user_context']) is not dict:
            raise ResearchError('invalid_request')
        request = payload['request']
        required = {'id', 'question', 'searchQueries', 'relevantUserConditions', 'evidenceLimit'}
        if type(request) is not dict or not required <= set(request) or set(request) - required - {'freshness'}:
            raise ResearchError('invalid_request')
        _text(request['id'], 200)
        _text(request['question'], 2000)
        if type(request['evidenceLimit']) is not int or not 1 <= request['evidenceLimit'] <= 12:
            raise ResearchError('invalid_request')
        queries = request['searchQueries']
        if type(queries) is not list or not 1 <= len(queries) <= 10:
            raise ResearchError('invalid_request')
        seen = set()
        for query in queries:
            _text(query, 120)
            normalized = unicodedata.normalize('NFKC', query).casefold()
            key = re.sub(r'\s+', '', normalized).rstrip('?!.。')
            if (normalized.lstrip().startswith('-') or
                    any(unicodedata.category(c).startswith('C') or c in '\u2028\u2029' for c in query) or
                    re.search(r'\w+://|www\.', normalized) or not key or key in seen):
                raise ResearchError('invalid_request')
            seen.add(key)
        conditions = request['relevantUserConditions']
        if type(conditions) is not list:
            raise ResearchError('invalid_request')
        for condition in conditions:
            _text(condition, 2000)
        if 'freshness' in request:
            _text(request['freshness'], 2000)
        if len(_json(_context(payload))) > 8000:
            raise ResearchError('invalid_request')
        return copy.deepcopy(payload)
    except ResearchError:
        raise
    except (TypeError, ValueError, UnicodeError, RecursionError, OverflowError):
        raise ResearchError('invalid_request') from None


@dataclass(frozen=True)
class ResearchLimits:
    search_count: int = 5
    max_compiler_calls: int = 8
    deadline_seconds: float = 600
    search_timeout_seconds: float = 90

    def __post_init__(self):
        if (type(self.search_count) is not int or not 1 <= self.search_count <= 10 or
                type(self.max_compiler_calls) is not int or not 1 <= self.max_compiler_calls <= 50):
            raise ResearchError('configuration_error')
        for value in (self.deadline_seconds, self.search_timeout_seconds):
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 < value <= 600:
                raise ResearchError('configuration_error')


def _environment_limits():
    from zhihu_m2.config import load_local_env
    load_local_env()
    try:
        return ResearchLimits(
            search_count=int(os.environ.get('ZHIHU_SEARCH_LIMIT_PER_QUERY', '5')),
            max_compiler_calls=int(os.environ.get('ZHIHU_COMPILER_MAX_CALLS', '8')),
            deadline_seconds=float(os.environ.get('ZHIHU_RESEARCH_DEADLINE_SECONDS', '600')),
        )
    except (ValueError, TypeError):
        raise ResearchError('configuration_error') from None


def _search(*args, **kwargs):
    from zhihu_m2.plan_retrieval import search_once
    return search_once(*args, **kwargs)


def _normalize(raw):
    from zhihu_m2.normalizer import normalize_result
    return normalize_result(raw)


def _rank(*args, **kwargs):
    from zhihu_m2.ranker import rank_results
    return rank_results(*args, **kwargs)


def _compile(*args, **kwargs):
    from zhihu_m2.evidence_compiler import compile_evidence
    return compile_evidence(*args, **kwargs)


def _rank_v3(*args, **kwargs):
    from zhihu_m2.ranker_v3 import rank_candidates
    return rank_candidates(*args, **kwargs)


def _select_v3(*args, **kwargs):
    from zhihu_m2.ranker_v3 import select_next_source
    return select_next_source(*args, **kwargs)


@dataclass
class ResearchDependencies:
    search: Callable = _search
    normalize: Callable = _normalize
    rank: Callable = _rank
    compile: Callable = _compile
    now: Callable = lambda: datetime.now(timezone.utc).isoformat()
    monotonic: Callable = time.monotonic
    trace: list = field(default_factory=list)
    rank_v3: Callable = _rank_v3
    select_v3: Callable = _select_v3
    diagnostics: list = field(default_factory=list)


def _validate_ranked_sources(ranked, pool):
    """Treat injected ranking as untrusted: validate before compiling originals."""
    from zhihu_m2.ranker_v3 import RankedSource
    from collections.abc import Mapping
    if type(ranked) is not list or len(ranked) != len(pool):
        raise ResearchError('execution_error')
    seen = set()
    for item in ranked:
        if (not isinstance(item, RankedSource) or type(item.source_id) is not str or
                item.source_id not in pool or item.source_id in seen or
                type(item.representative_index) is not int or
                not 0 <= item.representative_index < len(pool[item.source_id].occurrences) or
                not isinstance(item.components, Mapping) or
                set(item.components) != {'lexical', 'rrf', 'intent', 'recency', 'engagement', 'promotion'}):
            raise ResearchError('execution_error')
        for value in [item.priority, *item.components.values()]:
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ResearchError('execution_error')
        seen.add(item.source_id)
    return copy.deepcopy(ranked)


def _llm_fatal(error):
    # LLMError currently has no typed category. Match only its own fixed local
    # messages; never emit the message or a substring of it to the protocol.
    message = str(error)
    if message.startswith('Set DEEPSEEK_API_KEY'):
        return 'configuration_error'
    if message.startswith(('DeepSeek HTTP 401.', 'DeepSeek HTTP 403.')):
        return 'authentication_failed'
    if message.startswith(('DeepSeek HTTP 402.', 'DeepSeek HTTP 429.')):
        return 'rate_or_quota_limit'
    return None


def _spawn_context():
    # Always use spawn: matches Windows and does not inherit active HTTP state.
    return multiprocessing.get_context('spawn')


def _compiler_worker(connection, compiler, result, kwargs):
    """Private IPC worker. Never serialize an exception or print its details."""
    try:
        # Discard library output: stdout belongs exclusively to the entry JSON.
        # os.devnull stores no request data or artifacts on disk.
        with open(os.devnull, 'w', encoding='utf-8') as sink, redirect_stdout(sink), redirect_stderr(sink):
            try:
                from zhihu_m2 import evidence_compiler, llm_client
            except ImportError:
                packet = {'kind': 'fatal', 'code': 'dependency_unavailable'}
            else:
                try:
                    packet = {'kind': 'result', 'output': compiler(result, **kwargs)}
                except llm_client.LLMError as error:
                    fatal = _llm_fatal(error)
                    packet = {'kind': 'fatal', 'code': fatal} if fatal else {'kind': 'llm_error'}
                except evidence_compiler.EvidenceValidationError:
                    packet = {'kind': 'invalid_evidence'}
                except ImportError:
                    packet = {'kind': 'fatal', 'code': 'dependency_unavailable'}
                except KeyboardInterrupt:
                    packet = {'kind': 'interrupted'}
                except ResearchError as error:
                    packet = {'kind': 'fatal', 'code': error.code}
                except BaseException:
                    packet = {'kind': 'fatal', 'code': 'execution_error'}
            try:
                encoded = _json(packet).encode('utf-8')
                if len(encoded) > 2 * 1024 * 1024:
                    raise ValueError()
            except (TypeError, ValueError, UnicodeError, RecursionError):
                encoded = b'{"kind":"fatal","code":"execution_error"}'
            connection.send_bytes(encoded)
    except BaseException:
        # Parent detects EOF/abnormal exit. Bootstrap or pipe failures are never
        # converted into successful empty evidence, and no traceback is printed.
        pass
    finally:
        connection.close()


def _compile_with_deadline(result, *, timeout, compiler=None, **kwargs):
    """Run production compiler in a killable process within remaining wall time.

    Inputs travel over multiprocessing's private pipe, never argv or files.
    ``compiler`` is a private seam for picklable offline integration fixtures.
    """
    from zhihu_m2 import evidence_compiler, llm_client

    deadline = time.monotonic() + timeout
    if timeout <= 0:
        raise ResearchError('research_timeout')
    context = _spawn_context()
    receive, send = context.Pipe(duplex=False)
    process = context.Process(target=_compiler_worker,
        args=(send, compiler if compiler is not None else _compile, result, kwargs),
        name='zhihu-evidence-compiler')
    try:
        process.start()
        send.close()
        if not receive.poll(max(0, deadline - time.monotonic())):
            raise ResearchError('research_timeout')
        try:
            packet = json.loads(receive.recv_bytes(2 * 1024 * 1024).decode('utf-8'))
        except (EOFError, OSError, UnicodeError, ValueError):
            raise ResearchError('execution_error') from None
        process.join(max(0, deadline - time.monotonic()))
        if time.monotonic() >= deadline or process.is_alive():
            raise ResearchError('research_timeout')
        if process.exitcode != 0 or type(packet) is not dict:
            raise ResearchError('execution_error')
        kind = packet.get('kind')
        if kind == 'result' and set(packet) == {'kind', 'output'}:
            return packet['output']
        if kind == 'fatal' and packet.get('code') in ERROR_CODES:
            raise ResearchError(packet['code'])
        if kind == 'llm_error':
            raise llm_client.LLMError('Compiler transport or model call failed.')
        if kind == 'invalid_evidence':
            raise evidence_compiler.EvidenceValidationError('Compiler output failed validation.')
        if kind == 'interrupted':
            raise KeyboardInterrupt()
        raise ResearchError('execution_error')
    finally:
        receive.close()
        send.close()
        if process.pid is not None:
            if process.is_alive():
                process.terminate()
            process.join(1)
            if process.is_alive():
                process.kill()
                process.join(1)
            if process.is_alive():
                raise ResearchError('execution_error')
        process.close()


def run_research(payload: dict, *, dependencies=None, limits=None, metrics=None, options=None) -> dict:
    """Execute one request; return M2ResearchData or a safe typed failure.

    Attempts count boundary invocations, never charges or token usage. Overall
    deadline bounds search subprocesses and terminates the production compiler
    worker. The compiler also retains its existing 60s HTTP timeout. Injected
    in-process fakes retain their deterministic testing behavior.
    """
    frozen = validate_research_input(payload)
    try:
        return _run(frozen, dependencies=dependencies, limits=limits, metrics=metrics, options=options)
    except ResearchError:
        raise
    except ImportError:
        raise ResearchError('dependency_unavailable') from None
    except Exception:
        raise ResearchError('execution_error') from None


def _run(frozen, *, dependencies, limits, metrics, options):
    from zhihu_m2.evidence_compiler import _source_record, EvidenceValidationError
    from zhihu_m2.llm_client import LLMError
    from zhihu_m2.plan_retrieval import SearchError, BLOCKING_ERRORS
    from zhihu_m2.retrieval_options import RetrievalOptions, options_from_env

    dep = dependencies if dependencies is not None else ResearchDependencies()
    if options is None:
        from zhihu_m2.config import load_local_env
        load_local_env()
        options = options_from_env(os.environ)
    if not isinstance(options, RetrievalOptions):
        raise ResearchError('configuration_error')
    v3 = options.profile == 'v3'
    limits = limits if limits is not None else _environment_limits()
    if not isinstance(limits, ResearchLimits):
        raise ResearchError('configuration_error')
    counts = metrics if metrics is not None else {}
    metric_names = ['search_calls_attempted', 'compiler_calls_attempted', 'candidate_count', 'evidence_count']
    if v3:
        metric_names += ['raw_item_count', 'valid_occurrence_count', 'variant_count']
    for name in metric_names:
        counts.setdefault(name, 0)
        if type(counts[name]) is not int or counts[name] < 0:
            raise ResearchError('configuration_error')
    request = frozen['request']
    issues, unresolved, outputs, candidates, cards = [], [], [], {}, {}
    occurrences, successful_queries = [], set()
    started = dep.monotonic()

    def remaining():
        value = limits.deadline_seconds - (dep.monotonic() - started)
        if value <= 0:
            raise ResearchError('research_timeout')
        return value

    def issue(code, stage, **location):
        assert code in ISSUE_CODES
        issues.append({'code': code, 'stage': stage, **location})

    searches_ok = 0
    for query_index, query in enumerate(request['searchQueries']):
        timeout = min(limits.search_timeout_seconds, remaining())
        counts['search_calls_attempted'] += 1
        if 'new_zhihu_search' in counts:
            counts['new_zhihu_search'] = True
        try:
            response = dep.search(query, count=limits.search_count, timeout=timeout)
        except SearchError as error:
            remaining()
            if error.kind in BLOCKING_ERRORS:
                raise ResearchError({'authentication': 'authentication_failed',
                    'rate_or_quota_limit': 'rate_or_quota_limit',
                    'cli_unavailable': 'dependency_unavailable',
                    'cli_arguments': 'configuration_error'}[error.kind]) from None
            if error.kind not in {'timeout', 'network_error', 'upstream_error', 'invalid_response'}:
                raise ResearchError('execution_error') from None
            issue('search_' + error.kind, 'search', queryIndex=query_index)
            continue
        remaining()
        if (not isinstance(response, dict) or type(response.get('Code')) is not int or response['Code'] != 0 or
                not isinstance(response.get('Data'), dict) or not isinstance(response['Data'].get('Items'), list)):
            issue('search_invalid_response', 'search', queryIndex=query_index)
            continue
        searches_ok += 1
        successful_queries.add(query_index)
        timestamp = dep.now()
        if v3:
            counts['raw_item_count'] += len(response['Data']['Items'])
        for result_rank, raw in enumerate(response['Data']['Items'], start=1):
            try:
                if not isinstance(raw, dict):
                    raise ValueError()
                result = dep.normalize(copy.deepcopy(raw))
                source = _source_record(result, timestamp)
                # Rank metadata is typed before ranker arithmetic/string methods.
                number_fields = ('vote_up_count', 'comment_count', 'edit_time')
                if v3:
                    number_fields += ('ranking_score',)
                for field_name in number_fields:
                    if type(getattr(result, field_name)) not in (int, float) or not math.isfinite(getattr(result, field_name)):
                        raise ValueError()
                sid = source['id']
                digest = hashlib.sha256(result.content_text.encode('utf-8')).hexdigest()
                if v3:
                    from zhihu_m2.candidate_pool import SearchOccurrence, variant_key
                    occurrence = SearchOccurrence(query_index, result_rank, timestamp, result)
                    # All variant fields must encode before this item joins the
                    # owned pool; malformed optional metadata must not abort peers.
                    variant_key(occurrence)
            except (ValueError, TypeError, AttributeError, UnicodeError):
                issue('source_invalid', 'normalize', queryIndex=query_index)
                continue
            dep.trace.append({'queryIndex': query_index, 'sourceId': sid,
                              'retrieved_at': timestamp, 'snippet_sha256': digest,
                              'snippet': result.content_text})
            # First valid occurrence deterministically owns the original variant.
            candidates.setdefault(sid, (copy.deepcopy(result), timestamp))
            if v3:
                occurrences.append(occurrence)
    if not searches_ok:
        raise ResearchError('research_failed')
    counts['candidate_count'] = len(candidates)
    remaining()
    if v3:
        from zhihu_m2.candidate_pool import build_candidate_pool, variant_key
        from zhihu_m2.ranker_v3 import RankingContext
        pool = {item.source_id: item for item in build_candidate_pool(occurrences)}
        context = RankingContext(request['question'], tuple(request['searchQueries']),
                                 'freshness' in request, time.time())
        counts['valid_occurrence_count'] = len(occurrences)
        counts['variant_count'] = len({(source.source_id, variant_key(o))
                                      for source in pool.values() for o in source.occurrences})
        ranked = _validate_ranked_sources(dep.rank_v3(copy.deepcopy(list(pool.values())), context,
                                          set(successful_queries)), pool)
        for item in ranked:
            occurrence = pool[item.source_id].occurrences[item.representative_index]
            dep.diagnostics.append({'profile': 'v3', 'source_id': item.source_id,
                'representative_index': item.representative_index, 'query_index': occurrence.query_index,
                'result_rank': occurrence.result_rank, 'variant_key': variant_key(occurrence),
                'priority': item.priority, 'components': dict(item.components)})
    else:
        ranked = dep.rank([copy.deepcopy(item[0]) for item in candidates.values()], query=request['question'])
        # Legacy preserves the first valid occurrence and its exact ranking path.
        ordered_ids = [f'zhihu:{item.content_type}:{item.content_id}' for item in ranked]
        if len(ordered_ids) != len(candidates) or set(ordered_ids) != set(candidates):
            raise ResearchError('execution_error')
    remaining()
    compiler_successes = compiler_attempts = 0
    attempted_ids, accepted_ids = set(), set()
    while len(attempted_ids) < len(candidates):
        if len(cards) >= request['evidenceLimit']:
            break
        remaining()
        if counts['compiler_calls_attempted'] >= limits.max_compiler_calls:
            issue('compiler_budget_exhausted', 'coverage')
            break
        if v3:
            selected = dep.select_v3(copy.deepcopy(ranked), copy.deepcopy(pool),
                                     set(attempted_ids), set(accepted_ids))
            if (selected is None or selected not in ranked or selected.source_id in attempted_ids):
                raise ResearchError('execution_error')
            # Equality alone permits True == 1; repeat strict numeric/type checks.
            _validate_ranked_sources([selected], {selected.source_id: pool[selected.source_id]})
            sid = selected.source_id
            occurrence = pool[sid].occurrences[selected.representative_index]
            original, retrieved_at = occurrence.result, occurrence.retrieved_at
        else:
            sid = ordered_ids[len(attempted_ids)]
            original, retrieved_at = candidates[sid]
        if v3:
            remaining()
        attempted_ids.add(sid)
        counts['compiler_calls_attempted'] += 1
        compiler_attempts += 1
        try:
            compiler_input = dict(goal=frozen['goal'], user_context=copy.deepcopy(_context(frozen)),
                research_question=request['question'], retrieved_at=retrieved_at)
            if v3:
                compiler_input['retrieval_profile'] = 'v3'
            if dep.compile is _compile:
                output = _compile_with_deadline(copy.deepcopy(original), timeout=remaining(), **compiler_input)
            else:
                output = dep.compile(copy.deepcopy(original), **compiler_input)
        except LLMError as error:
            remaining()
            code = _llm_fatal(error)
            if code:
                raise ResearchError(code) from None
            issue('compiler_failed', 'compile', sourceId=sid)
            continue
        except EvidenceValidationError:
            remaining()
            issue('compiler_invalid_output', 'compile', sourceId=sid)
            continue
        remaining()
        if (not isinstance(output, dict) or output.get('status') not in {'ok', 'no_evidence'} or
                output.get('source') != _source_record(original, retrieved_at) or
                not isinstance(output.get('evidence_cards'), list) or
                len(output['evidence_cards']) != (1 if output['status'] == 'ok' else 0)):
            issue('compiler_invalid_output', 'compile', sourceId=sid)
            continue
        compiler_successes += 1
        before = len(cards)
        for card in output['evidence_cards']:
            identity = card.get('id')
            if not isinstance(identity, str) or not identity:
                raise ResearchError('execution_error')
            if identity in cards and cards[identity] != card:
                raise ResearchError('evidence_id_conflict')
            cards.setdefault(identity, copy.deepcopy(card))
        if len(cards) > before:
            accepted_ids.add(sid)
        counts['evidence_count'] = len(cards)
        outputs.append(copy.deepcopy(output))
    if compiler_attempts and not compiler_successes:
        raise ResearchError('compilation_failed')
    if 'freshness' in request:
        issue('freshness_not_enforced', 'coverage')
        unresolved.append('The requested freshness constraint could not be enforced by the search provider.')
    if issues:
        unresolved.append('Some research coverage remains incomplete; inspect the safe issue codes.')
    if not cards:
        unresolved.append('No applicable evidence was obtained from the evaluated search results.')
    remaining()
    return {'requestId': request['id'], 'status': 'partial' if issues else 'ok' if cards else 'no_evidence',
            'compilerOutputs': outputs, 'routeCandidates': [],
            'unresolvedQuestions': unresolved, 'issues': issues}
