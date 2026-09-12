"""Offline command-line evaluation of synthetic, unreviewed ranker pairs."""
import copy
import json
from pathlib import Path
import runpy
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'packages/zhihu/scripts/evaluate_ranker.py'
FIXTURE = ROOT / 'packages/zhihu/tests/fixtures/ranker_cross_domain.json'


def run_cli(*arguments):
    return subprocess.run([sys.executable, '-B', str(SCRIPT), *map(str, arguments)],
                          cwd=ROOT, capture_output=True, text=True, encoding='utf-8')


def dataset():
    return {
        'dataset_kind': 'synthetic_engineering_regression',
        'review_status': 'needs_human_review',
        'cases': [{'id': 'writing-test', 'domain': 'writing',
                   'question': '怎样练习写作？',
                   'preferred': {'title': '写作练习', 'content_text': '记录观察，再修改描写。'},
                   'distractor': {'title': '写作练习', 'content_text': '记录观察，再修改描写。'}}],
    }


def test_help_works_from_repository_root():
    run = run_cli('--help')
    assert run.returncode == 0
    assert '--case-file' in run.stdout and '--now-ts' in run.stdout


def test_default_fixture_is_reproducible_and_does_not_claim_real_quality(tmp_path):
    first, second = tmp_path / 'first.json', tmp_path / 'second.json'
    for output in (first, second):
        run = run_cli('--output', output)
        assert run.returncode == 0, run.stderr
    assert first.read_bytes() == second.read_bytes()
    report = json.loads(first.read_text(encoding='utf-8'))
    cases = json.loads(FIXTURE.read_text(encoding='utf-8'))['cases']
    assert report['ranker_version'].startswith('m2-ranker-')
    assert report['score_kind'] == 'heuristic_priority_not_fact_confidence'
    assert report['review_status'] == 'needs_human_review'
    assert report['scope'] == 'synthetic_engineering_regression_only'
    assert report['now_ts'] == 1_800_000_000
    assert report['case_count'] == len(cases)
    assert sum(d['case_count'] for d in report['domains'].values()) == len(cases)
    assert report['execution'] == {'search_calls_attempted': 0, 'model_calls_attempted': 0}
    assert {'preferred', 'distractor', 'outcome'} <= report['cases'][0].keys()
    assert not {'precision', 'accuracy', 'quality_improved', 'fact_confidence'} & report.keys()


def test_equal_scores_are_ties_not_preference_wins_and_do_not_fail_execution(tmp_path):
    case_file, output = tmp_path / 'case.json', tmp_path / 'output.json'
    case_file.write_text(json.dumps(dataset()), encoding='utf-8')
    run = run_cli('--case-file', case_file, '--output', output)
    assert run.returncode == 0, run.stderr
    report = json.loads(output.read_text(encoding='utf-8'))
    assert report['preferred_first_count'] == 0
    assert report['tied_count'] == 1
    assert report['domains']['writing']['tied_count'] == 1
    assert report['cases'][0]['outcome'] == 'tied'
    assert 'synthetic_preferences_not_all_met' in report['warnings']


def test_evaluation_uses_real_ranker_equal_metadata_and_never_loads_credentials(monkeypatch):
    api = runpy.run_path(str(SCRIPT))
    from zhihu_m2 import config, ranker
    def forbidden(*args, **kwargs):
        pytest.fail('Offline ranker evaluation must not load credentials or use a network')
    monkeypatch.setattr(config, 'load_local_env', forbidden)
    import socket
    monkeypatch.setattr(socket, 'create_connection', forbidden)
    recorded = []
    original = ranker.rank_results
    def checked(results, query, now_ts=None):
        recorded.append((copy.deepcopy(results), query, now_ts))
        return original(results, query, now_ts=now_ts)
    monkeypatch.setattr(ranker, 'rank_results', checked)
    report = api['evaluate_dataset'](dataset(), now_ts=123.5)
    assert len(recorded) == 1
    first, second = recorded[0][0]
    assert vars(first) == vars(second)
    assert recorded[0][1:] == ('怎样练习写作？', 123.5)
    assert report['cases'][0]['preferred'] == ranker.ranking_breakdown(first, '怎样练习写作？', now_ts=123.5)


@pytest.mark.parametrize('case_change', [
    lambda data: data.update(dataset_kind='real_world'),
    lambda data: data.update(review_status='human_approved'),
    lambda data: data.update(cases=[]),
    lambda data: data['cases'].append(copy.deepcopy(data['cases'][0])),
    lambda data: data['cases'][0].update(question=True),
    lambda data: data['cases'][0]['preferred'].update(vote_up_count=1000),
    lambda data: data['cases'][0]['preferred'].update(content_text=''),
])
def test_invalid_fixture_is_rejected_with_safe_error(tmp_path, case_change):
    data = dataset()
    data['cases'][0]['preferred']['title'] = 'DO_NOT_PRINT_SECRET_VALUE'
    case_change(data)
    case_file, output = tmp_path / 'bad.json', tmp_path / 'output.json'
    case_file.write_text(json.dumps(data), encoding='utf-8')
    run = run_cli('--case-file', case_file, '--output', output)
    assert run.returncode == 2
    assert 'DO_NOT_PRINT_SECRET_VALUE' not in run.stdout + run.stderr
    assert 'Traceback' not in run.stderr
    assert 'Evaluation failed' in run.stderr
    assert not output.exists()


@pytest.mark.parametrize('contents', [b'{SECRET_IN_BROKEN_JSON', b' ' * (2 * 1024 * 1024 + 1), b'\xff', b'[]'],
                         ids=['malformed', 'oversize', 'invalid-utf8', 'nonobject'])
def test_unreadable_or_oversize_json_fails_without_echoing_input(tmp_path, contents):
    case_file = tmp_path / 'bad.json'
    case_file.write_bytes(contents)
    run = run_cli('--case-file', case_file, '--output', tmp_path / 'report.json')
    assert run.returncode == 2
    assert 'Evaluation failed' in run.stderr
    assert 'SECRET_IN_BROKEN_JSON' not in run.stdout + run.stderr
    assert 'Traceback' not in run.stderr


@pytest.mark.parametrize('clock', ['NaN', 'Infinity', '-Infinity', 'not-a-number'])
def test_nonfinite_or_invalid_clock_fails_safely(tmp_path, clock):
    run = run_cli('--now-ts=' + clock, '--output', tmp_path / 'report.json')
    assert run.returncode == 2
    assert 'Traceback' not in run.stderr


def test_missing_case_file_and_unwritable_output_fail_safely(tmp_path):
    missing = run_cli('--case-file', tmp_path / 'missing.json', '--output', tmp_path / 'report.json')
    directory = run_cli('--output', tmp_path)
    assert missing.returncode == directory.returncode == 2
    assert all('Evaluation failed' in run.stderr and 'Traceback' not in run.stderr for run in (missing, directory))


def test_unexpected_ranking_exception_is_not_printed(tmp_path, monkeypatch, capsys):
    api = runpy.run_path(str(SCRIPT))
    from zhihu_m2 import ranker
    def fail(*args, **kwargs):
        raise RuntimeError('PRIVATE_EXCEPTION_OR_KEY')
    monkeypatch.setattr(ranker, 'ranking_breakdown', fail)
    monkeypatch.setattr(sys, 'argv', [str(SCRIPT), '--output', str(tmp_path / 'report.json')])
    with pytest.raises(SystemExit) as error:
        api['main']()
    assert error.value.code == 2
    output = capsys.readouterr()
    assert 'PRIVATE_EXCEPTION_OR_KEY' not in output.out + output.err
    assert 'Evaluation failed' in output.err
