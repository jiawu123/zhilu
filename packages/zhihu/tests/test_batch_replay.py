import copy
import json
import os
from pathlib import Path

import pytest

from tests.test_batch_screening import candidate, item
from zhihu_m2 import batch_screening as batch, llm_client
from zhihu_m2.replay_batch import replay


def test_failed_batch_keeps_inputs_raw_response_and_exact_validation_reason(tmp_path, monkeypatch):
    candidates = [candidate()]
    payload = {'items': [item(0, candidates[0])]}
    payload['items'][0]['compilation']['evidence_cards'][0]['supporting_quote'] = '这句话并不存在于原文片段中。'
    monkeypatch.setattr(llm_client, 'generate_json', lambda **_: copy.deepcopy(payload))
    folder = tmp_path / 'batch'
    with pytest.raises(batch.BatchValidationError):
        batch.compile_batch(candidates, goal='提高练习质量', user_context={},
                            research_question='如何检查练习效果？', diagnostic_dir=folder)
    assert json.loads((folder / 'input.json').read_text(encoding='utf-8'))['candidates'] == candidates
    assert json.loads((folder / 'model_response.json').read_text(encoding='utf-8')) == payload
    report = json.loads((folder / 'report.json').read_text(encoding='utf-8'))
    assert report['stage'] == 'items'
    assert report['item_errors'][0]['reason'] == 'supporting_quote is not an exact substring of the provided snippet.'
    assert report['model_calls_attempted'] == 1
    def forbidden(**_):
        raise AssertionError('Offline replay must not call a model')
    monkeypatch.setattr(llm_client, 'generate_json', forbidden)
    replayed = replay(folder)
    assert replayed['status'] == 'failed'
    assert replayed['item_errors'] == report['item_errors']
    assert replayed['model_calls_attempted'] == replayed['search_calls_attempted'] == 0
    assert json.loads((folder / 'model_response.json').read_text(encoding='utf-8')) == payload


def test_live_replay_uses_same_sources_and_calls_only_model_once(tmp_path, monkeypatch):
    candidates = [candidate()]
    calls = []
    def generate(**kwargs):
        calls.append(kwargs)
        return {'items': [item(0, candidates[0])]}
    monkeypatch.setattr(llm_client, 'generate_json', generate)
    folder = tmp_path / 'batch'
    batch.compile_batch(candidates, goal='提高练习质量', user_context={},
                        research_question='如何检查练习效果？', diagnostic_dir=folder)
    result = replay(folder, call_model=True)
    assert result['status'] == 'passed'
    assert result['model_calls_attempted'] == 1
    assert result['search_calls_attempted'] == 0
    assert len(calls) == 2  # original capture plus exactly one explicit replay
    assert calls[0] == calls[1]
    assert json.loads((Path(result['output_dir']) / 'input.json').read_text(encoding='utf-8'))['candidates'] == candidates


def test_incomplete_model_output_is_recorded_without_raw_exception(tmp_path, monkeypatch):
    folder = tmp_path / 'batch'
    def incomplete(**_):
        raise llm_client.LLMError("DeepSeek finish_reason was not 'stop'; output rejected.")
    monkeypatch.setattr(llm_client, 'generate_json', incomplete)
    with pytest.raises(llm_client.LLMError):
        batch.compile_batch([candidate()], goal='提高练习质量', user_context={},
                            research_question='如何检查练习效果？', diagnostic_dir=folder)
    report = json.loads((folder / 'report.json').read_text(encoding='utf-8'))
    assert report['error_code'] == 'model_output_incomplete'
    assert report['model_calls_attempted'] == 1
    assert not (folder / 'model_response.json').exists()


def test_environment_enables_worker_diagnostics(tmp_path, monkeypatch):
    monkeypatch.setenv('ZHIHU_BATCH_DIAGNOSTIC_DIR', str(tmp_path))
    value = candidate()
    monkeypatch.setattr(llm_client, 'generate_json', lambda **_: {'items': [item(0, value)]})
    batch.compile_batch([value], goal='提高练习质量', user_context={}, research_question='如何检查练习效果？')
    folders = list(tmp_path.iterdir())
    assert len(folders) == 1
    assert json.loads((folders[0] / 'report.json').read_text(encoding='utf-8'))['status'] == 'passed'


@pytest.mark.skipif(os.name == 'nt', reason='POSIX mode bits do not verify Windows ACL permissions')
def test_diagnostic_artifacts_have_restricted_posix_permissions(tmp_path, monkeypatch):
    value = candidate()
    monkeypatch.setattr(llm_client, 'generate_json', lambda **_: {'items': [item(0, value)]})
    folder = tmp_path / 'batch'
    batch.compile_batch([value], goal='提高练习质量', user_context={},
                        research_question='如何检查练习效果？', diagnostic_dir=folder)
    assert folder.stat().st_mode & 0o777 == 0o700
    for name in ('input.json', 'model_response.json', 'report.json', 'validated.json'):
        assert (folder / name).stat().st_mode & 0o777 == 0o600
