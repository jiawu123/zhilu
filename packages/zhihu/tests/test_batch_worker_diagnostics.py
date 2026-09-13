"""Real spawn IPC must preserve bounded diagnostics without forwarding raw logs."""
import json
import io
import sys

import pytest

from zhihu_m2 import research_runner as rr


def diagnostic_compiler(mode, *, diagnostics=None):
    print('private-model-canary', file=sys.stderr)
    print('private-model-canary')
    diagnostics.extend([
        {'batch_debug': 'model_returned', 'item_count': 3, 'private': 'private-model-canary'},
        {'batch_debug': 'item_invalid', 'candidate_index': 2, 'labels': {'relevance': 'private-model-canary'}},
        {'batch_debug': 'private-model-canary', 'item_count': 100},
    ])
    if mode == 'failed':
        raise rr.ResearchError('compilation_failed')
    return {'retained': True}


@pytest.mark.parametrize('mode', ['ok', 'failed'])
def test_real_worker_transfers_only_safe_diagnostics_even_when_compilation_fails(mode, capfd):
    diagnostics = []
    if mode == 'failed':
        with pytest.raises(rr.ResearchError, match='^compilation_failed$'):
            rr._compile_with_deadline(mode, timeout=10, compiler=diagnostic_compiler, diagnostics=diagnostics)
    else:
        assert rr._compile_with_deadline(mode, timeout=10, compiler=diagnostic_compiler,
                                        diagnostics=diagnostics) == {'retained': True}
    assert diagnostics == [
        {'batch_debug': 'model_returned', 'item_count': 3},
        {'batch_debug': 'item_invalid', 'candidate_index': 2},
    ]
    captured = capfd.readouterr()
    assert 'private-model-canary' not in captured.out + captured.err + json.dumps(diagnostics)


@pytest.mark.parametrize('enabled', [False, True])
def test_batch_parent_reports_safe_diagnostics_without_changing_failure_category(monkeypatch, capfd, enabled):
    from test_research_runner import payload, raw, response
    from zhihu_m2.retrieval_options import RetrievalOptions

    if enabled:
        monkeypatch.setenv('ZHIHU_BATCH_DEBUG', '1')
    else:
        monkeypatch.delenv('ZHIHU_BATCH_DEBUG', raising=False)

    def isolated(candidates, *, diagnostics=None, **kwargs):
        if diagnostics is not None:
            diagnostics.extend([
                {'batch_debug': 'model_returned', 'item_count': 1},
                {'batch_debug': 'item_invalid', 'candidate_index': 0, 'labels': 'private-model-canary'},
                {'batch_debug': 'all_items_invalid', 'input_candidate_count': 1, 'issue_count': 1},
            ])
        raise rr.ResearchError('compilation_failed')

    monkeypatch.setattr(rr, '_compile_with_deadline', isolated)
    request = payload()
    request['request']['searchQueries'] = ['指定原始查询']
    metrics = {}
    with pytest.raises(rr.ResearchError, match='^compilation_failed$'):
        rr.run_research(request, dependencies=rr.ResearchDependencies(search=lambda *a, **k: response(raw())),
                        options=RetrievalOptions('batch-v1'), metrics=metrics)
    assert metrics['batch_invalid_item_count'] == 1
    assert metrics['batch_valid_output_count'] == 0
    captured = capfd.readouterr()
    assert not captured.out
    assert 'private-model-canary' not in captured.err
    assert ('"batch_debug"' in captured.err) is enabled


def test_pipeline_failure_line_preserves_bounded_batch_counters(monkeypatch, capsys):
    from zhihu_m2 import pipeline
    from test_research_runner import payload

    def failed(request, *, metrics):
        metrics.update(search_calls_attempted=1, candidate_count=3, batch_model_calls_attempted=1,
                       batch_invalid_item_count=3, batch_valid_output_count=0, batch_invalid_group_count=0)
        raise pipeline.EntryError('compilation_failed')

    monkeypatch.setattr(pipeline, 'research', failed)
    monkeypatch.setattr(sys, 'stdin', io.StringIO(json.dumps(payload())))
    assert pipeline.main(['--action', 'research']) == 1
    output = capsys.readouterr()
    line = json.loads(output.err.strip().splitlines()[-1])
    assert line['error_code'] == 'compilation_failed'
    assert line['batch_invalid_item_count'] == 3
    assert line['batch_valid_output_count'] == 0
    assert line['candidate_count'] == 3
    assert json.loads(output.out)['metrics']['batch_invalid_item_count'] == 3
