"""Offline checks for the dotenv patch; never use personal credentials."""
import importlib
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from zhihu_m2 import llm_client, zhihu_client


@pytest.fixture(autouse=True)
def isolated_environment(monkeypatch):
    for name in (
        "DEEPSEEK_API_KEY", "ZHIHU_ACCESS_SECRET", "ZHIHU_CLI_PATH",
        "LOCALAPPDATA", "PYTHON_DOTENV_DISABLED", "DOTENV_TEST_SENTINEL",
    ):
        # Register even initially absent names so dotenv changes are undone.
        monkeypatch.setenv(name, "")
        monkeypatch.delenv(name, raising=False)
    # No personal .env or live transport in this test module.
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")

    def forbidden(*args, **kwargs):
        pytest.fail("A real network request or process was attempted")

    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(subprocess, "run", forbidden)
    # Do not rely on an actual Zhihu binary being installed on this machine.
    monkeypatch.setenv("PATH", "")


def temporary_env(monkeypatch, tmp_path, contents):
    from zhihu_m2 import config
    env_file = tmp_path / ".env"
    env_file.write_text(contents, encoding="utf-8-sig")
    monkeypatch.setattr(config, "ENV_FILE", env_file)
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    return config


def fake_llm_transport(monkeypatch):
    recorded = {}

    def post(self, url, *, headers, json):
        recorded.update(url=url, headers=headers, payload=json)
        return httpx.Response(
            200,
            request=httpx.Request("POST", url),
            json={"choices": [{"finish_reason": "stop", "message": {
                "content": '{"status":"ok"}'
            }}]},
        )

    monkeypatch.setattr(httpx.Client, "post", post)
    return recorded


def test_cli_path_override_is_respected(monkeypatch, tmp_path):
    binary = tmp_path / "zhihu-cli.exe"
    binary.touch()
    monkeypatch.setenv("ZHIHU_CLI_PATH", str(binary))
    assert zhihu_client.get_cli_path() == binary


def test_cli_stderr_is_not_exposed(monkeypatch, tmp_path):
    monkeypatch.setattr(zhihu_client, "get_cli_path", lambda: tmp_path / "cli")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=1, stdout="", stderr="FAKE_SECRET_MUST_NOT_APPEAR"
    ))
    with pytest.raises(RuntimeError) as error:
        zhihu_client.search_zhihu("Agent", count=1)
    assert "FAKE_SECRET_MUST_NOT_APPEAR" not in str(error.value)


def test_api_error_message_is_not_exposed():
    with pytest.raises(RuntimeError) as error:
        zhihu_client.extract_items({"Code": 401, "Message": "FAKE_SECRET_MUST_NOT_APPEAR"})
    assert "FAKE_SECRET_MUST_NOT_APPEAR" not in str(error.value)


def test_dotenv_is_explicit_and_handles_bom(monkeypatch, tmp_path):
    import os
    config = temporary_env(monkeypatch, tmp_path, "DEEPSEEK_API_KEY=offline-fake-key\n")
    elsewhere = tmp_path / "another-directory"
    elsewhere.mkdir()
    (elsewhere / ".env").write_text("DEEPSEEK_API_KEY=wrong-file\n")
    monkeypatch.chdir(elsewhere)
    assert config.load_local_env() is True
    assert os.environ["DEEPSEEK_API_KEY"] == "offline-fake-key"


def test_existing_environment_has_priority(monkeypatch, tmp_path):
    import os
    config = temporary_env(monkeypatch, tmp_path, "DEEPSEEK_API_KEY=file-fake-key\n")
    monkeypatch.setenv("DEEPSEEK_API_KEY", "environment-fake-key")
    config.load_local_env()
    assert os.environ["DEEPSEEK_API_KEY"] == "environment-fake-key"


@pytest.mark.parametrize("disabled", ["1", "true", "YES", "on"])
def test_loading_can_be_disabled(monkeypatch, tmp_path, disabled):
    import os
    config = temporary_env(monkeypatch, tmp_path, "DEEPSEEK_API_KEY=unused\n")
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", disabled)
    assert config.load_local_env() is False
    assert "DEEPSEEK_API_KEY" not in os.environ


def test_missing_env_does_not_break_import_or_mock(monkeypatch, tmp_path):
    from zhihu_m2 import config
    monkeypatch.setattr(config, "ENV_FILE", tmp_path / "not-present.env")
    monkeypatch.delenv("PYTHON_DOTENV_DISABLED", raising=False)
    assert config.load_local_env() is False


def test_interpolation_does_not_change_secret(monkeypatch, tmp_path):
    import os
    config = temporary_env(monkeypatch, tmp_path, "DEEPSEEK_API_KEY='literal-${HOME}'\n")
    config.load_local_env()
    assert os.environ["DEEPSEEK_API_KEY"] == "literal-${HOME}"


def test_import_does_not_load_dotenv_or_call_services(monkeypatch, tmp_path):
    import os
    temporary_env(monkeypatch, tmp_path, "DOTENV_TEST_SENTINEL=must-not-load\n")
    importlib.reload(llm_client)
    importlib.reload(zhihu_client)
    assert "DOTENV_TEST_SENTINEL" not in os.environ


def test_llm_reads_dotenv_without_changing_request(monkeypatch, tmp_path):
    temporary_env(monkeypatch, tmp_path, "DEEPSEEK_API_KEY=offline-fake-key\n")
    recorded = fake_llm_transport(monkeypatch)
    assert llm_client.generate_json("system", "user", max_tokens=128) == {"status": "ok"}
    assert recorded["headers"] == {"Authorization": "Bearer offline-fake-key"}
    assert recorded["url"] == llm_client.API_URL
    assert recorded["payload"]["model"] == llm_client.MODEL
    assert recorded["payload"]["thinking"] == {"type": "disabled"}
    assert recorded["payload"]["response_format"] == {"type": "json_object"}
    assert recorded["payload"]["stream"] is False
    assert recorded["payload"]["max_tokens"] == 128


def test_llm_missing_key_fails_before_network():
    with pytest.raises(llm_client.LLMError, match="DEEPSEEK_API_KEY"):
        llm_client.generate_json("system", "user")


@pytest.mark.parametrize("text", ["[]", "true", "null", "{bad}", '{"x":NaN}'])
def test_existing_json_validation_is_preserved(text):
    body = {"choices": [{"finish_reason": "stop", "message": {"content": text}}]}
    with pytest.raises(llm_client.LLMError):
        llm_client.parse_json_response(body)


def test_windows_install_location_is_still_supported(monkeypatch, tmp_path):
    cli = tmp_path / "ZhihuCLI" / "current" / "zhihu-cli.exe"
    cli.parent.mkdir(parents=True)
    cli.touch()
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert zhihu_client.get_cli_path() == cli


def test_cli_path_is_loaded_from_dotenv(monkeypatch, tmp_path):
    cli = tmp_path / "custom-cli"
    cli.touch()
    temporary_env(monkeypatch, tmp_path, f'ZHIHU_CLI_PATH="{cli.as_posix()}"\n')
    assert zhihu_client.get_cli_path() == cli


def test_missing_override_does_not_silently_fallback(monkeypatch, tmp_path):
    monkeypatch.setenv("ZHIHU_CLI_PATH", str(tmp_path / "not-installed"))
    with pytest.raises(FileNotFoundError, match="ZHIHU_CLI_PATH"):
        zhihu_client.get_cli_path()


def test_search_leaves_credentials_out_of_arguments(monkeypatch, tmp_path):
    import os
    cli = tmp_path / "custom-cli"
    cli.touch()
    temporary_env(monkeypatch, tmp_path,
        f'ZHIHU_CLI_PATH="{cli.as_posix()}"\nZHIHU_ACCESS_SECRET=offline-zhihu-fake\n')
    commands = []

    def run(command, **kwargs):
        commands.append(command)
        assert "offline-zhihu-fake" not in command
        # subprocess default inheritance is used; this is not a CLI auth test.
        assert os.environ["ZHIHU_ACCESS_SECRET"] == "offline-zhihu-fake"
        return SimpleNamespace(returncode=0, stderr="", stdout=json.dumps({
            "Code": 0, "Data": {"Items": [{"Title": "offline fixture"}]}
        }))

    monkeypatch.setattr(subprocess, "run", run)
    assert zhihu_client.search_zhihu("Agent", 1) == [{"Title": "offline fixture"}]
    assert len(commands) == 1
    assert commands[0][1:3] == ["search", "zhihu"]


def test_search_timeout_is_sanitized(monkeypatch, tmp_path):
    monkeypatch.setattr(zhihu_client, "get_cli_path", lambda: tmp_path / "cli")

    def run(*args, **kwargs):
        raise subprocess.TimeoutExpired("cli", 60, stderr="FAKE_SECRET_MUST_NOT_APPEAR")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError, match="timed out") as error:
        zhihu_client.search_zhihu("Agent", 1)
    assert "FAKE_SECRET_MUST_NOT_APPEAR" not in str(error.value)


def test_invalid_cli_json_is_sanitized(monkeypatch, tmp_path):
    monkeypatch.setattr(zhihu_client, "get_cli_path", lambda: tmp_path / "cli")
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: SimpleNamespace(
        returncode=0, stderr="", stdout="FAKE_SECRET_MUST_NOT_APPEAR"
    ))
    with pytest.raises(RuntimeError, match="JSON") as error:
        zhihu_client.search_zhihu("Agent", 1)
    assert "FAKE_SECRET_MUST_NOT_APPEAR" not in str(error.value)


def test_existing_search_helpers_are_preserved():
    assert zhihu_client.validate_count(5) == 5
    for count in [0, 11]:
        with pytest.raises(ValueError):
            zhihu_client.validate_count(count)
    assert zhihu_client.extract_items({"Code": 0, "Data": {"Items": [1, 2]}}) == [1, 2]
    assert zhihu_client.extract_items({"Code": 0, "Data": {}}) == []


def test_auth_setup_checks_help_then_uses_stdin(monkeypatch, tmp_path):
    from zhihu_m2 import setup_zhihu_auth
    temporary_env(monkeypatch, tmp_path, "ZHIHU_ACCESS_SECRET=offline-auth-fake\n")
    monkeypatch.setattr(setup_zhihu_auth, "get_cli_path", lambda: tmp_path / "cli")
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert all("offline-auth-fake" not in item for item in command)
        if command[-1] == "--help":
            return SimpleNamespace(returncode=0, stdout="Options: --secret-stdin", stderr="")
        assert kwargs["input"] == "offline-auth-fake\n"
        return SimpleNamespace(returncode=0, stdout="not printed", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    setup_zhihu_auth.configure_auth_from_env()
    assert len(calls) == 2
    assert calls[1][0][1:] == ["auth", "set", "--secret-stdin"]


def test_auth_setup_refuses_unsupported_cli(monkeypatch, tmp_path):
    from zhihu_m2 import setup_zhihu_auth
    monkeypatch.setenv("ZHIHU_ACCESS_SECRET", "offline-auth-fake")
    monkeypatch.setattr(setup_zhihu_auth, "get_cli_path", lambda: tmp_path / "cli")
    calls = []

    def run(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(returncode=0, stdout="No supported flags", stderr="")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError, match="secret-stdin"):
        setup_zhihu_auth.configure_auth_from_env()
    assert len(calls) == 1  # Only help was requested; no credential write.


def test_auth_setup_requires_secret_before_any_process():
    from zhihu_m2 import setup_zhihu_auth
    with pytest.raises(RuntimeError, match="ZHIHU_ACCESS_SECRET"):
        setup_zhihu_auth.configure_auth_from_env()


def test_auth_setup_does_not_echo_cli_failure(monkeypatch, tmp_path):
    from zhihu_m2 import setup_zhihu_auth
    monkeypatch.setenv("ZHIHU_ACCESS_SECRET", "offline-auth-fake")
    monkeypatch.setattr(setup_zhihu_auth, "get_cli_path", lambda: tmp_path / "cli")

    def run(command, **kwargs):
        if command[-1] == "--help":
            return SimpleNamespace(returncode=0, stdout="--secret-stdin", stderr="")
        return SimpleNamespace(returncode=1, stdout="offline-auth-fake", stderr="offline-auth-fake")

    monkeypatch.setattr(subprocess, "run", run)
    with pytest.raises(RuntimeError) as error:
        setup_zhihu_auth.configure_auth_from_env()
    assert "offline-auth-fake" not in str(error.value)


def test_auth_setup_rejects_multiline_secret(monkeypatch):
    from zhihu_m2 import setup_zhihu_auth
    monkeypatch.setenv("ZHIHU_ACCESS_SECRET", "line1\nline2")
    with pytest.raises(RuntimeError, match="single line"):
        setup_zhihu_auth.configure_auth_from_env()