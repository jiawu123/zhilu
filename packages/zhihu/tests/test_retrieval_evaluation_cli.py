import json
from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / 'packages/zhihu/scripts/evaluate_retrieval.py'
FIXTURES = ROOT / 'packages/zhihu/tests/fixtures/retrieval_v3'


def test_offline_cli_root_entrypoint_and_three_honest_ablations(tmp_path):
    output = tmp_path / 'report.json'
    run = subprocess.run([sys.executable, '-B', str(SCRIPT), '--case-file', str(FIXTURES / 'synthetic_cases.json'), '--profiles', 'legacy', 'v3', '--offline', '--output', str(output)], cwd=ROOT, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    report = json.loads(output.read_text(encoding='utf-8'))
    assert report['evaluation_scope'] == 'synthetic_regression'
    assert len(report['cases']) == 12
    assert set(report['cases'][0]['ablations']) == {'legacy', 'v3_no_diversity', 'selection_simulation'}
    assert report['execution']['search_calls_attempted'] == 0
    assert report['execution']['compiler_calls_attempted'] == 0
    assert report['cases'][0]['ablations']['selection_simulation']['accepted_card_precision'] is None


def test_pending_real_questions_have_null_metrics(tmp_path):
    output = tmp_path / 'pending.json'
    run = subprocess.run([sys.executable, '-B', str(SCRIPT), '--case-file', str(FIXTURES / 'evaluation_questions.json'), '--offline', '--output', str(output)], cwd=ROOT, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    report = json.loads(output.read_text(encoding='utf-8'))
    assert report['quality_status'] == 'needs_human_review'
    assert all(case['ablations']['legacy']['precision_at_3'] is None for case in report['cases'])
