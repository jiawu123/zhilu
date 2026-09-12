import pytest

from zhihu_m2.retrieval_options import RetrievalOptions, options_from_env
from zhihu_m2.research_runner import ResearchError


def test_default_is_legacy_and_explicit_v3():
    assert options_from_env({}) == RetrievalOptions('legacy')
    assert options_from_env({'ZHIHU_RETRIEVAL_PROFILE': 'v3'}) == RetrievalOptions('v3')
    assert options_from_env({'UNRELATED': 'private'}) == RetrievalOptions()


@pytest.mark.parametrize('value', ['V3', '', ' v3 ', 'future', True, None, 3])
def test_invalid_profiles_have_safe_error(value):
    with pytest.raises(ResearchError, match='^configuration_error$'):
        options_from_env({'ZHIHU_RETRIEVAL_PROFILE': value})
    with pytest.raises(ResearchError, match='^configuration_error$'):
        RetrievalOptions(value)


def test_options_import_does_not_load_dotenv(monkeypatch):
    import importlib
    import zhihu_m2.config as config
    import zhihu_m2.retrieval_options as module
    monkeypatch.setattr(config, 'load_local_env', lambda: pytest.fail('dotenv during import'))
    importlib.reload(module)

