"""Offline tests: the HTTP boundary is replaced; no real keys or API calls."""
import importlib
import json

import httpx
import pytest

from zhihu_m2 import llm_client


def api_response(content='{"status":"ok"}', finish_reason="stop"):
    return {
        "model": "deepseek-v4-pro",
        "choices": [{
            "index": 0,
            "finish_reason": finish_reason,
            "message": {"role": "assistant", "content": content},
        }],
    }


@pytest.fixture(autouse=True)
def fake_http(monkeypatch):
    """Capture real HTTPX Request objects, but never send them to the network."""
    state = {"requests": [], "status": 200, "body": api_response(), "error": None}
    monkeypatch.setenv("DEEPSEEK_API_KEY", "unit-test-placeholder")

    def send(client, request, **kwargs):
        state["requests"].append(request)
        if state["error"] is not None:
            raise state["error"]
        return httpx.Response(state["status"], json=state["body"], request=request)

    monkeypatch.setattr(httpx.Client, "send", send)
    return state


def test_request_uses_official_endpoint_and_selected_model(fake_http):
    result = llm_client.generate_json("Return JSON.", "仅返回一个状态对象。")
    assert result == {"status": "ok"}
    assert len(fake_http["requests"]) == 1
    request = fake_http["requests"][0]
    assert str(request.url) == "https://api.deepseek.com/chat/completions"
    assert request.method == "POST"
    assert request.headers["authorization"] == "Bearer unit-test-placeholder"
    body = json.loads(request.content)
    assert body["model"] == "deepseek-v4-pro"
    assert body["response_format"] == {"type": "json_object"}
    assert body["thinking"] == {"type": "disabled"}
    assert body["stream"] is False
    assert body["max_tokens"] == 1024
    assert "json" in body["messages"][0]["content"].lower()
    assert body["messages"][1] == {"role": "user", "content": "仅返回一个状态对象。"}
    assert "tools" not in body
    assert request.extensions["timeout"]["read"] == 60.0


def test_custom_token_limit_is_sent(fake_http):
    llm_client.generate_json("JSON.", "Return an object.", max_tokens=128)
    body = json.loads(fake_http["requests"][0].content)
    assert body["max_tokens"] == 128


def test_missing_key_fails_without_sending_request(monkeypatch, fake_http):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(RuntimeError, match="DEEPSEEK_API_KEY"):
        llm_client.generate_json("JSON.", "Test.")
    assert fake_http["requests"] == []


@pytest.mark.parametrize("system,user", [("", "test"), ("test", " "), (None, "test"), ("test", 123)])
def test_invalid_prompts_are_rejected_locally(system, user, fake_http):
    with pytest.raises(ValueError):
        llm_client.generate_json(system, user)
    assert fake_http["requests"] == []


@pytest.mark.parametrize("value", [0, -1, True, 1.5])
def test_invalid_token_limit_is_rejected_locally(value, fake_http):
    with pytest.raises(ValueError):
        llm_client.generate_json("JSON.", "Test.", max_tokens=value)
    assert fake_http["requests"] == []


@pytest.mark.parametrize("status", [401, 402, 429, 500])
def test_http_errors_are_not_empty_evidence_or_automatic_retries(status, fake_http):
    fake_http["status"] = status
    fake_http["body"] = {"error": {"message": "unit-test-placeholder"}}
    with pytest.raises(RuntimeError, match=str(status)) as error:
        llm_client.generate_json("JSON.", "Test.")
    assert "unit-test-placeholder" not in str(error.value)
    assert len(fake_http["requests"]) == 1


def test_diagnostic_records_usage_and_model_content_without_authentication(fake_http):
    fake_http["body"].update(id="completion-test", usage={"prompt_tokens": 8, "completion_tokens": 4, "total_tokens": 12})
    diagnostic = {}
    llm_client.generate_json("Return JSON.", "Test.", diagnostic=diagnostic)
    assert diagnostic["http_status"] == 200
    assert diagnostic["raw_content"] == '{"status":"ok"}'
    assert diagnostic["finish_reason"] == "stop"
    assert diagnostic["usage"]["total_tokens"] == 12
    assert diagnostic["request"]["messages"] == json.loads(fake_http["requests"][0].content)["messages"]
    assert "unit-test-placeholder" not in json.dumps(diagnostic)
    assert "authorization" not in json.dumps(diagnostic).lower()


def test_diagnostic_does_not_capture_http_error_body(fake_http):
    fake_http["status"] = 401
    fake_http["body"] = {"error": {"message": "unit-test-placeholder"}}
    diagnostic = {}
    with pytest.raises(llm_client.LLMError):
        llm_client.generate_json("Return JSON.", "Test.", diagnostic=diagnostic)
    assert diagnostic["http_status"] == 401
    assert "unit-test-placeholder" not in json.dumps(diagnostic)


def test_timeout_is_explicit(fake_http):
    fake_http["error"] = httpx.ReadTimeout("Do not print raw transport details.")
    with pytest.raises(RuntimeError, match="timed out"):
        llm_client.generate_json("JSON.", "Test.")
    assert len(fake_http["requests"]) == 1


def test_network_error_is_explicit(fake_http):
    fake_http["error"] = httpx.ConnectError("Sensitive transport details.")
    with pytest.raises(RuntimeError, match="connection"):
        llm_client.generate_json("JSON.", "Test.")


@pytest.mark.parametrize("body", [{}, {"choices": []}, {"choices": [{}]}, [], None])
def test_malformed_api_envelope_is_rejected(body):
    with pytest.raises(RuntimeError):
        llm_client.parse_json_response(body)


@pytest.mark.parametrize("reason", ["length", "content_filter", "tool_calls", None])
def test_non_stop_completion_is_rejected(reason):
    with pytest.raises(RuntimeError, match="finish_reason"):
        llm_client.parse_json_response(api_response(finish_reason=reason))


@pytest.mark.parametrize("content", ["", "   ", None])
def test_empty_model_output_is_rejected(content):
    with pytest.raises(RuntimeError, match="empty"):
        llm_client.parse_json_response(api_response(content))


@pytest.mark.parametrize("content", ["not json", '```json\n{"a":1}\n```', '{"value": NaN}'])
def test_invalid_json_is_rejected(content):
    with pytest.raises(RuntimeError, match="valid JSON"):
        llm_client.parse_json_response(api_response(content))


@pytest.mark.parametrize("content", ["[]", "null", '"hello"', "123"])
def test_json_must_have_an_object_at_top_level(content):
    with pytest.raises(RuntimeError, match="JSON object"):
        llm_client.parse_json_response(api_response(content))


def test_model_refusal_is_rejected():
    body = api_response()
    body["choices"][0]["message"]["refusal"] = "Cannot comply."
    with pytest.raises(RuntimeError, match="refused"):
        llm_client.parse_json_response(body)


def test_unicode_json_and_nested_values_are_preserved():
    expected = {"主张": "先写测试", "items": [], "valid": True}
    body = api_response(json.dumps(expected, ensure_ascii=False))
    assert llm_client.parse_json_response(body) == expected


def test_import_does_not_require_key_or_send_request(monkeypatch, fake_http):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    importlib.reload(llm_client)
    assert fake_http["requests"] == []
