import pytest
from zhihu_m2 import pipeline, query_planner, llm_client


def test_new_profile_entry_is_explicit():
    args = pipeline._arguments(['--action', 'plan', '--planning-profile', 'm2-initial'])
    assert args.planning_profile == 'm2-initial'


def test_planner_missing_configuration_has_safe_category(monkeypatch):
    def missing(*args, **kwargs):
        raise llm_client.LLMError('Set DEEPSEEK_API_KEY in the environment or packages/zhihu/.env before calling the model.')
    monkeypatch.setattr(query_planner, 'plan_research', missing)
    with pytest.raises(pipeline.EntryError) as result:
        pipeline.plan({'goal': '写完一本书', 'user_context': {}}, planning_profile='m2-initial')
    assert result.value.code == 'configuration_error'


def test_supplement_entry_stops_without_model(monkeypatch):
    monkeypatch.setattr(llm_client, 'generate_json', lambda *a, **k: pytest.fail('model'))
    assert pipeline._arguments(['--action', 'supplement']).action == 'supplement'
    result = pipeline.supplement({'goal': '完成一本书', 'user_context': {}, 'gaps': [],
                                  'executed_queries': ['写作方法'], 'remaining_query_budget': 3})
    assert result['status'] == 'stop' and result['planner_calls_attempted'] == 0
