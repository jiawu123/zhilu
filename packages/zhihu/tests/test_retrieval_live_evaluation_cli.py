"""Offline CLI checks; no real search, compiler, planner or credentials used."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import pytest
from zhihu_m2.research_runner import ResearchError

SCRIPT = Path(__file__).parents[1] / 'scripts/run_retrieval_live_evaluation.py'
ROOT = Path(__file__).parents[3]


def load_cli():
    spec = importlib.util.spec_from_file_location('live_evaluation_cli', SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_help_from_root_is_offline():
    process = subprocess.run([sys.executable, '-B', str(SCRIPT), '--help'], cwd=ROOT,
                             capture_output=True, text=True)
    assert process.returncode == 0
    assert '--live' in process.stdout and '--phase' in process.stdout


def test_default_is_offline_and_does_not_create_output(tmp_path):
    cli = load_cli()
    assert cli.main(['--output-dir', str(tmp_path/'untouched')]) == 0
    assert not (tmp_path/'untouched').exists()


def test_output_must_stay_under_ignored_artifacts(tmp_path):
    cli = load_cli()
    with pytest.raises(ResearchError):
        cli.validate_output_dir(tmp_path)


def test_phase_lock_and_started_marker_prevent_rerun(tmp_path):
    cli = load_cli()
    with cli.phase_guard(tmp_path, 'capture'):
        with pytest.raises(ResearchError):
            with cli.phase_guard(tmp_path, 'planner'):
                pytest.fail('must not enter parallel phase')
    assert not (tmp_path/'.live-evaluation.lock').exists()
    assert (tmp_path/'capture.started.json').exists()
    with pytest.raises(ResearchError):
        with cli.phase_guard(tmp_path, 'capture'):
            pytest.fail('must not repeat started phase')


def test_model_attempt_reserved_before_worker_and_budget_enforced(tmp_path):
    cli = load_cli()
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    ledger = LiveLedger(tmp_path)
    calls = []
    def worker(value, **kwargs):
        saved = json.loads(ledger.path.read_text(encoding='utf-8'))
        assert saved['attempts'][-1]['status'] == 'reserved'
        calls.append(kwargs)
        return {'ok': True, 'result': {}, 'audit': {'prompt_sha256': 'a'*64, 'model': 'fake', 'http_calls_attempted': 1}}
    for _ in range(8):
        cli.model_attempt(None, operation='planner', profile='legacy', arguments={},
                          metadata={'case_id': 'fake'}, ledger=ledger, timeout=1, worker=worker)
    with pytest.raises(ResearchError):
        cli.model_attempt(None, operation='planner', profile='legacy', arguments={},
                          metadata={'case_id': 'fake'}, ledger=ledger, timeout=1, worker=worker)
    assert len(calls) == 8
    assert ledger.state['attempts'][0]['audit']['prompt_sha256'] == 'a'*64


def test_fatal_packet_is_typed_and_safe(tmp_path):
    cli = load_cli()
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    ledger = LiveLedger(tmp_path)
    def worker(value, **kwargs):
        return {'ok': False, 'code': 'authentication_failed', 'audit': {}}
    with pytest.raises(ResearchError, match='authentication_failed'):
        cli.model_attempt(None, operation='compiler', profile='v3', arguments={},
                          metadata={}, ledger=ledger, timeout=1, worker=worker)
    assert ledger.state['attempts'][0]['status'] == 'authentication_failed'


def test_compiler_phase_uses_two_sources_and_six_prompt_reviews(tmp_path, monkeypatch):
    cli = load_cli()
    from dataclasses import asdict
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    from zhihu_m2.evidence_compiler import _source_record
    from test_candidate_pool import make_result
    taskfile = json.loads(cli.TASK_FILE.read_text(encoding='utf-8'))
    cases = cli.selected_cases(taskfile['questions'])
    for case in cases:
        case.update(now_ts=1789171200.0, successful_query_indexes=[0,1], candidate_capture_time='2026-09-12T00:00:00+00:00',
                    observations=[{'query_index':0,'result_rank':i+1,'retrieved_at':'2026-09-12T00:00:00+00:00',
                                   'result':asdict(make_result(str(i)))} for i in range(3)])
    calls = []
    def worker(value, **kwargs):
        calls.append(kwargs)
        return {'ok':True,'result':{'status':'no_evidence','reason':'No applicable evidence.',
                'source':_source_record(value,kwargs['arguments']['retrieved_at']), 'evidence_cards':[]},'audit':{}}
    monkeypatch.setattr(cli.rr, '_compile_with_deadline', worker)
    ledger = LiveLedger(tmp_path)
    result = cli.compile_phase({'cases':cases},ledger)
    assert len(calls) == 22
    assert len(result['cases']) == 8
    assert all(c['metrics']['compiler_calls_attempted'] == 2 for c in result['cases'])
    assert len(result['synthetic_prompt_review']['cases']) == 6
    assert result['synthetic_prompt_review']['quality_status'] == 'needs_human_review'
    assert all(c['data']['compilerOutputs'] for c in result['cases'])
    assert all('retrieval_profile' not in c['arguments'] for c in calls)
    assert {r['kind'] for r in ledger.state['attempts']} == {'compiler'}


def test_auth_failure_prevents_later_model_attempts_across_phases(tmp_path):
    cli = load_cli()
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    ledger = LiveLedger(tmp_path)
    record = ledger.reserve('compiler', {})
    ledger.finish(record, status='rate_or_quota_limit')
    def forbidden(*args, **kwargs):
        pytest.fail('fatal model batch must stay stopped')
    with pytest.raises(ResearchError, match='rate_or_quota_limit'):
        cli.model_attempt(None, operation='planner', profile='v3', arguments={}, metadata={},
                          ledger=ledger, timeout=1, worker=forbidden)
    assert len(ledger.state['attempts']) == 1


def test_planner_phase_has_eight_calls_and_no_search(tmp_path, monkeypatch):
    cli = load_cli()
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    calls = []
    def worker(value, **kwargs):
        assert value is None and kwargs['operation'] == 'planner'
        calls.append(kwargs)
        return {'ok': True, 'result': {'status':'needs_clarification'}, 'audit':{}}
    monkeypatch.setattr(cli.rr, '_compile_with_deadline', worker)
    ledger = LiveLedger(tmp_path)
    result = cli.planner_phase(json.loads(cli.TASK_FILE.read_text(encoding='utf-8')), ledger)
    assert len(calls) == 8 and len(result['cases']) == 8
    assert result['queries_executed'] is False
    assert result['quality_status'] == 'needs_human_review'
    assert {r['kind'] for r in ledger.state['attempts']} == {'planner'}


def test_uncaptured_domains_are_skipped_and_search_quota_does_not_block_models(tmp_path, monkeypatch):
    cli = load_cli()
    from dataclasses import asdict
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    from zhihu_m2.evidence_compiler import _source_record
    from test_candidate_pool import make_result
    cases = cli.selected_cases(json.loads(cli.TASK_FILE.read_text(encoding='utf-8'))['questions'])
    for i, case in enumerate(cases):
        case.update(now_ts=1789171200.0, successful_query_indexes=[0,1] if i == 0 else [],
                    candidate_capture_time='2026-09-12T00:00:00+00:00',
                    observations=[{'query_index':0,'result_rank':r+1,'retrieved_at':'2026-09-12T00:00:00+00:00',
                                   'result':asdict(make_result(str(r)))} for r in range(2)] if i == 0 else [])
    calls = []
    def worker(value, **kwargs):
        calls.append(kwargs)
        return {'ok':True,'result':{'status':'no_evidence','reason':'No applicable evidence.',
                'source':_source_record(value,kwargs['arguments']['retrieved_at']), 'evidence_cards':[]},'audit':{}}
    monkeypatch.setattr(cli.rr, '_compile_with_deadline', worker)
    ledger = LiveLedger(tmp_path)
    attempt = ledger.reserve('search', {})
    ledger.finish(attempt, status='rate_or_quota_limit')
    result = cli.compile_phase({'cases':cases}, ledger)
    assert len(calls) == 10
    assert result['batch_status'] == 'partial'
    assert result['missing_case_ids'] == ['career-01','team-01','craft-01']
    missing = [c for c in result['cases'] if c['case_id'] != 'learn-01']
    assert len(missing) == 6
    assert all(c['status'] == 'capture_not_available' and c['metrics'] is None for c in missing)
    assert len(result['synthetic_prompt_review']['cases']) == 6


def test_planner_failures_make_batch_failed(tmp_path, monkeypatch):
    cli = load_cli()
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    calls = []
    def worker(value, **kwargs):
        calls.append(1)
        return {'ok': False, 'code': 'validation_error', 'audit': {}}
    monkeypatch.setattr(cli.rr, '_compile_with_deadline', worker)
    result = cli.planner_phase(json.loads(cli.TASK_FILE.read_text(encoding='utf-8')), LiveLedger(tmp_path))
    assert len(calls) == 8
    assert result['batch_status'] == 'failed'
    assert result['successful_count'] == 0


def test_compile_freezes_both_ranker_clocks_and_reports_failed_batch(tmp_path, monkeypatch):
    cli = load_cli()
    from dataclasses import asdict
    from zhihu_m2.retrieval_live_evaluation import LiveLedger
    from zhihu_m2 import ranker, ranker_v3
    from test_candidate_pool import make_result
    cases = cli.selected_cases(json.loads(cli.TASK_FILE.read_text(encoding='utf-8'))['questions'])
    for case in cases:
        case.update(now_ts=123456.0, successful_query_indexes=[0,1], candidate_capture_time='2026-09-12T00:00:00+00:00',
            observations=[{'query_index':0, 'result_rank':1, 'retrieved_at':'2026-09-12T00:00:00+00:00', 'result':asdict(make_result('1'))}])
    legacy, v3 = ranker.rank_results, ranker_v3.rank_candidates
    clocks = []
    def rank_legacy(results, query, now_ts=None):
        clocks.append(now_ts)
        return legacy(results, query, now_ts=now_ts)
    def rank_v3(pool, context, successful):
        clocks.append(context.now_ts)
        return v3(pool, context, successful)
    monkeypatch.setattr(ranker, 'rank_results', rank_legacy)
    monkeypatch.setattr(ranker_v3, 'rank_candidates', rank_v3)
    monkeypatch.setattr(cli.rr, '_compile_with_deadline', lambda *a, **k: {'ok':False,'code':'validation_error','audit':{}})
    result = cli.compile_phase({'cases':cases}, LiveLedger(tmp_path))
    assert clocks == [123456.0] * 8
    assert result['batch_status'] == 'failed'
    assert result['synthetic_prompt_review']['batch_status'] == 'failed'


@pytest.mark.parametrize('statuses,expected', [(['ok', 'validation_error'], 'partial'),
    (['no_evidence', 'ok'], 'complete'), (['compilation_failed', 'execution_error'], 'failed'),
    (['partial'], 'partial'), (['capture_not_available'], 'partial')])
def test_batch_outcomes_distinguish_mixed_success_failure_and_missing(statuses, expected):
    cli = load_cli()
    result = {'batch_status': 'complete', 'cases': [{'status': status} for status in statuses]}
    cli.update_batch_status(result)
    assert result['batch_status'] == expected


def test_batch_fatal_status_never_downgraded():
    cli = load_cli()
    result = {'batch_status': 'authentication_failed', 'cases': [{'status': 'authentication_failed'}]}
    cli.update_batch_status(result)
    assert result['batch_status'] == 'authentication_failed'
    assert result['failed_count'] == 1
