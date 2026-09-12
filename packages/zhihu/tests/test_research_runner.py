import copy
import json
import multiprocessing
import os
import time

import pytest

from zhihu_m2 import research_runner as rr
from zhihu_m2 import evidence_compiler as ec
from zhihu_m2.plan_retrieval import SearchError
from zhihu_m2 import llm_client


def payload():
    return {'goal': 'Build a tested agent', 'user_context': {'experience': 'beginner'},
            'request': {'id': '../external-id', 'question': 'How should beginners test agents?',
                        'searchQueries': ['agent tests', 'python tests'],
                        'relevantUserConditions': ['beginner'], 'evidenceLimit': 2}}


def raw(i=1, snippet='First line.\r\n<b>Test each component carefully.</b>'):
    return {'ContentType': 'answer', 'ContentID': str(i), 'Title': 'Testing agents',
            'ContentText': snippet, 'Url': f'https://www.zhihu.com/question/1/answer/{i}'}


def response(*items):
    return {'Code': 0, 'Data': {'Items': list(items)}}


def compile_ok(result, **kwargs):
    return ec.validate_evidence_response({'status': 'ok', 'reason': 'Relevant advice',
        'evidence_cards': [{'source_id': f'zhihu:answer:{result.content_id}',
            'supporting_quote': result.content_text, 'claim': 'The author suggests testing components.',
            'claim_type': 'advice', 'applies_when': 'For beginner projects', 'caveats': []}]},
        result, retrieved_at=kwargs['retrieved_at'])


def dependencies(search=None, compile=None, **kwargs):
    return rr.ResearchDependencies(search=search or (lambda *a, **k: response(raw())),
        compile=compile or compile_ok, rank=lambda results, **k: list(results), **kwargs)


@pytest.mark.parametrize('change', [
    lambda p: p.update(command='secret'),
    lambda p: p['request'].update(evidenceLimit=True),
    lambda p: p['request'].update(evidenceLimit=13),
    lambda p: p['request'].update(searchQueries=[]),
    lambda p: p['request'].update(searchQueries=['--help']),
    lambda p: p['request'].update(searchQueries=['  --help']),
    lambda p: p['request'].update(searchQueries=['https://zhihu.com']),
    lambda p: p['request'].update(searchQueries=['hello\tworld']),
    lambda p: p['request'].update(searchQueries=['Ａgent tests', 'agent tests']),
    lambda p: p['request'].update(freshness=''),
    lambda p: p['request'].update(relevantUserConditions=[1]),
    lambda p: p['user_context'].update(value=float('nan')),
    lambda p: p['user_context'].update(value=(1, 2)),
    lambda p: p['user_context'].update(api_key='secret'),
    lambda p: p['user_context'].update(python_path='secret'),
    lambda p: p['user_context'].update(value='x' * 7990),
])
def test_reject_before_io(change):
    p = payload()
    change(p)
    with pytest.raises(rr.ResearchError) as error:
        rr.run_research(p, dependencies=dependencies(search=lambda *a, **k: pytest.fail('I/O')))
    assert error.value.code == 'invalid_request'


def test_defensive_copy_and_one_query():
    p = payload()
    p['request']['searchQueries'] = ['agent tests']
    frozen = rr.validate_research_input(p)
    frozen['request']['searchQueries'].append('changed')
    assert p['request']['searchQueries'] == ['agent tests']


def test_raw_dedup_trace_context_and_metrics():
    seen = []
    dep = dependencies(search=lambda query, **k: response(raw(snippet='First line.\r\nExact original quote.' if query == 'agent tests' else 'Other variant text.')),
        compile=lambda result, **kw: (seen.append((copy.deepcopy(result), kw)) or compile_ok(result, **kw)),
        now=lambda: '2026-09-11T12:00:00+00:00')
    metrics = {}
    p = payload()
    p['request']['freshness'] = 'past month'
    data = rr.run_research(p, dependencies=dep, metrics=metrics)
    assert data['requestId'] == '../external-id'
    assert data['routeCandidates'] == []
    assert seen[0][0].content_text == 'First line.\r\nExact original quote.'
    assert seen[0][1]['retrieved_at'] == '2026-09-11T12:00:00+00:00'
    context = seen[0][1]['user_context']
    assert context['confirmed_user_context'] == p['user_context']
    assert context['research_request_constraints']['freshness'] == 'past month'
    assert len(dep.trace) == 2
    assert dep.trace[0]['snippet_sha256'] != dep.trace[1]['snippet_sha256']
    assert metrics == dict(search_calls_attempted=2, compiler_calls_attempted=1, candidate_count=1, evidence_count=1)
    assert data['status'] == 'partial'
    assert any(i['code'] == 'freshness_not_enforced' for i in data['issues'])


def test_no_evidence_continues_until_card_limit():
    def compiler(result, **kw):
        if result.content_id == '1':
            return ec.validate_evidence_response({'status': 'no_evidence', 'reason': 'No applicable advice', 'evidence_cards': []}, result, retrieved_at=kw['retrieved_at'])
        return compile_ok(result, **kw)
    p = payload()
    p['request']['evidenceLimit'] = 1
    metrics = {}
    data = rr.run_research(p, dependencies=dependencies(search=lambda *a, **k: response(raw(1), raw(2), raw(3)), compile=compiler), metrics=metrics)
    assert data['status'] == 'ok'
    assert len(data['compilerOutputs']) == 2
    assert data['compilerOutputs'][0]['reason'] == 'No applicable advice'
    assert metrics['compiler_calls_attempted'] == 2


def fail(error):
    def call(*args, **kwargs):
        raise error
    return call


@pytest.mark.parametrize('dep,code', [
    (lambda: dependencies(search=fail(SearchError('network_error'))), 'research_failed'),
    (lambda: dependencies(search=fail(SearchError('authentication'))), 'authentication_failed'),
    (lambda: dependencies(compile=fail(llm_client.LLMError('DeepSeek network connection failed.'))), 'compilation_failed'),
    (lambda: dependencies(compile=fail(llm_client.LLMError('DeepSeek HTTP 401. secret'))), 'authentication_failed'),
    (lambda: dependencies(search=fail(RuntimeError('credential-canary'))), 'execution_error'),
])
def test_fatal_errors_are_safe(dep, code):
    with pytest.raises(rr.ResearchError) as error:
        rr.run_research(payload(), dependencies=dep())
    assert error.value.code == code
    assert 'secret' not in str(error.value) and 'canary' not in str(error.value)


def test_partial_search_and_budget():
    def search(query, **kw):
        if query == 'agent tests':
            raise SearchError('timeout')
        return response(raw(1), raw(2))
    data = rr.run_research(payload(), dependencies=dependencies(search=search), limits=rr.ResearchLimits(max_compiler_calls=1))
    assert data['status'] == 'partial'
    assert {i['code'] for i in data['issues']} == {'search_timeout', 'compiler_budget_exhausted'}


def test_empty_search_is_normal_no_evidence():
    data = rr.run_research(payload(), dependencies=dependencies(search=lambda *a, **k: response()))
    assert data['status'] == 'no_evidence'
    assert data['unresolvedQuestions']


def test_deadline_after_call_is_fatal():
    ticks = iter([0, 0, 601])
    with pytest.raises(rr.ResearchError, match='research_timeout'):
        rr.run_research(payload(), dependencies=dependencies(monotonic=lambda: next(ticks)))


def test_rank_cleaning_never_changes_compiler_original():
    dep = dependencies()
    def rank(results, **kwargs):
        results[0].content_text = 'cleaned copy'
        return results
    dep.rank = rank
    data = rr.run_research(payload(), dependencies=dep)
    assert data['compilerOutputs'][0]['source']['snippet'] == raw()['ContentText']


def test_card_id_conflict_is_fatal():
    def compiler(result, **kwargs):
        out = compile_ok(result, **kwargs)
        out['evidence_cards'][0]['id'] = 'same-id'
        return out
    with pytest.raises(rr.ResearchError, match='evidence_id_conflict'):
        rr.run_research(payload(), dependencies=dependencies(search=lambda *a, **k: response(raw(1), raw(2)), compile=compiler))


def test_actual_search_sets_pipeline_metric():
    metrics = {'new_zhihu_search': False}
    rr.run_research(payload(), dependencies=dependencies(), metrics=metrics)
    assert metrics['new_zhihu_search'] is True


def test_preexisting_attempt_budget_is_respected():
    metrics = {'compiler_calls_attempted': 8}
    data = rr.run_research(payload(), dependencies=dependencies(compile=lambda *a, **k: pytest.fail('budget exceeded')), metrics=metrics)
    assert data['status'] == 'partial'
    assert metrics['compiler_calls_attempted'] == 8


def test_invalid_response_and_source_are_not_empty_success():
    p = payload()
    p['request']['searchQueries'] = ['agent tests']
    with pytest.raises(rr.ResearchError, match='research_failed'):
        rr.run_research(p, dependencies=dependencies(search=lambda *a, **k: {'Data': {'Items': []}}))
    data = rr.run_research(p, dependencies=dependencies(search=lambda *a, **k: response({'ContentText': 'no identity'})))
    assert data['status'] == 'partial'
    assert data['issues'][0]['code'] == 'source_invalid'


def test_partial_compiler_failure_retains_normal_no_evidence():
    def compiler(result, **kw):
        if result.content_id == '1':
            raise ec.EvidenceValidationError('private error')
        return ec.validate_evidence_response({'status': 'no_evidence', 'reason': 'No advice', 'evidence_cards': []}, result, retrieved_at=kw['retrieved_at'])
    data = rr.run_research(payload(), dependencies=dependencies(search=lambda *a, **k: response(raw(1), raw(2)), compile=compiler))
    assert data['status'] == 'partial'
    assert len(data['compilerOutputs']) == 1
    assert 'private error' not in json.dumps(data)


def test_environment_limits(monkeypatch):
    monkeypatch.setenv('ZHIHU_COMPILER_MAX_CALLS', '1')
    monkeypatch.setenv('ZHIHU_SEARCH_LIMIT_PER_QUERY', '2')
    counts = []
    data = rr.run_research(payload(), dependencies=dependencies(search=lambda *a, **k: (counts.append(k['count']) or response(raw(1), raw(2)))))
    assert data['status'] == 'partial'
    assert counts == [2, 2]


def _spawn_compiler(result, **kwargs):
    """Picklable offline boundary; never reads credentials or calls a service."""
    mode = kwargs['research_question']
    if mode == 'hang':
        time.sleep(30)
    if mode == 'crash':
        os._exit(7)
    if mode == 'network':
        raise llm_client.LLMError('DeepSeek network connection failed. private-canary')
    if mode == 'authentication':
        raise llm_client.LLMError('DeepSeek HTTP 401. private-canary')
    if mode == 'invalid-evidence':
        raise ec.EvidenceValidationError('private-canary')
    if mode == 'unexpected':
        raise RuntimeError('private-canary')
    if mode == 'interrupt':
        raise KeyboardInterrupt('private-canary')
    if mode == 'missing-dependency':
        raise ImportError('private-canary')
    if mode == 'no-evidence':
        return ec.validate_evidence_response({'status': 'no_evidence', 'reason': 'No advice', 'evidence_cards': []}, result, retrieved_at=kwargs['retrieved_at'])
    return compile_ok(result, **kwargs)


def _worker_kwargs(mode):
    return dict(goal='Offline goal', user_context={}, research_question=mode,
                retrieved_at='2026-09-11T12:00:00+00:00')


def test_spawn_compiler_deadline_reaps_actual_process(monkeypatch):
    real_context = multiprocessing.get_context('spawn')
    closed = []

    class TrackedContext:
        Pipe = staticmethod(real_context.Pipe)

        @staticmethod
        def Process(*args, **kwargs):
            process = real_context.Process(*args, **kwargs)

            class TrackedProcess:
                def __getattr__(self, name):
                    return getattr(process, name)

                def close(self):
                    closed.append((process.pid, process.exitcode, process.is_alive()))
                    process.close()

            return TrackedProcess()

    monkeypatch.setattr(rr, '_spawn_context', lambda: TrackedContext())
    started = time.monotonic()
    with pytest.raises(rr.ResearchError, match='research_timeout'):
        rr._compile_with_deadline(rr._normalize(raw()), timeout=1,
            compiler=_spawn_compiler, **_worker_kwargs('hang'))
    assert time.monotonic() - started < 5
    assert len(closed) == 1
    pid, exitcode, alive = closed[0]
    assert pid != os.getpid() and pid > 0
    assert exitcode is not None and alive is False
    assert pid not in {child.pid for child in multiprocessing.active_children()}


@pytest.mark.parametrize('mode,error_type,code', [
    ('network', llm_client.LLMError, None),
    ('authentication', rr.ResearchError, 'authentication_failed'),
    ('invalid-evidence', ec.EvidenceValidationError, None),
    ('unexpected', rr.ResearchError, 'execution_error'),
    ('crash', rr.ResearchError, 'execution_error'),
    ('interrupt', KeyboardInterrupt, None),
    ('missing-dependency', rr.ResearchError, 'dependency_unavailable'),
])
def test_spawn_compiler_sanitizes_failure(mode, error_type, code, capfd):
    # Resolve reloadable LLM class at execution, as dotenv tests reload it.
    if mode == 'network':
        error_type = llm_client.LLMError
    elif mode == 'invalid-evidence':
        error_type = ec.EvidenceValidationError
    with pytest.raises(error_type) as error:
        rr._compile_with_deadline(rr._normalize(raw()), timeout=5,
            compiler=_spawn_compiler, **_worker_kwargs(mode))
    if code:
        assert error.value.code == code
    assert 'private-canary' not in str(error.value)
    captured = capfd.readouterr()
    assert 'private-canary' not in captured.out + captured.err


@pytest.mark.parametrize('mode', ['ok', 'no-evidence'])
def test_spawn_compiler_preserves_complete_output(mode):
    result = rr._normalize(raw())
    output = rr._compile_with_deadline(result, timeout=5,
        compiler=_spawn_compiler, **_worker_kwargs(mode))
    assert output == _spawn_compiler(result, **_worker_kwargs(mode))


def test_default_compiler_uses_remaining_deadline_and_stops_request(monkeypatch):
    calls = []
    metrics = {}

    def isolated(result, *, timeout, **kwargs):
        calls.append(timeout)
        assert metrics['compiler_calls_attempted'] == 1
        raise rr.ResearchError('research_timeout')

    monkeypatch.setattr(rr, '_compile_with_deadline', isolated)
    ticks = iter([0, 0, 1, 1, 2, 2, 3, 3, 4])
    dep = rr.ResearchDependencies(search=lambda *a, **k: response(raw(1), raw(2)),
        rank=lambda results, **k: results, monotonic=lambda: next(ticks))
    with pytest.raises(rr.ResearchError, match='research_timeout'):
        rr.run_research(payload(), dependencies=dep, metrics=metrics,
            limits=rr.ResearchLimits(deadline_seconds=10))
    assert calls == [6]
    assert metrics['compiler_calls_attempted'] == 1
