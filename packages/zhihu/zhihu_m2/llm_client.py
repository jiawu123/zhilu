"""Call the official DeepSeek API. Importing this module sends no request.

Scope: transport + JSON-object parsing only. This is not an evidence validator.
API keys are read from the current process, never written to source files.
"""
import json
import os
from typing import Any

import httpx


MODEL = "deepseek-v4-pro"
API_URL = "https://api.deepseek.com/chat/completions"


class LLMError(RuntimeError):
    """Configuration, transport, or unusable model-response error."""


def _reject_nonfinite(value: str) -> None:
    """NaN and Infinity are not valid JSON values."""
    raise ValueError("Non-finite JSON number")


def parse_json_response(body: Any) -> dict[str, Any]:
    """Extract the first completed model message as a JSON object.

    Reject incomplete output instead of accepting a truncated evidence card.
    Do not include raw response text in exceptions: it may contain user data.
    This validates syntax and transport structure, not EvidenceCard fields.
    """
    try:
        choice = body["choices"][0]
        finish_reason = choice["finish_reason"]
        message = choice["message"]
        content = message["content"]
    except (KeyError, IndexError, TypeError):
        raise LLMError("DeepSeek returned an unexpected response structure.") from None

    if finish_reason != "stop":
        raise LLMError("DeepSeek finish_reason was not 'stop'; output rejected.")
    if message.get("refusal"):
        raise LLMError("DeepSeek refused this request.")
    if not isinstance(content, str) or not content.strip():
        raise LLMError("DeepSeek returned empty model content.")

    try:
        result = json.loads(content, parse_constant=_reject_nonfinite)
    except ValueError:
        raise LLMError("DeepSeek did not return valid JSON.") from None

    if not isinstance(result, dict):
        raise LLMError("DeepSeek must return a JSON object, not a list or scalar.")
    return result


def generate_json(
    system_prompt: str,
    user_prompt: str,
    *,
    max_tokens: int = 1024,
) -> dict[str, Any]:
    """Request one JSON object from deepseek-v4-pro (non-thinking mode).

    No tools, streaming, redirects, or automatic retries are enabled.
    Timeout is an HTTPX network timeout, not a total wall-clock deadline.
    Callers must validate domain-specific fields and evidence separately.
    """
    for name, value in [("system_prompt", system_prompt), ("user_prompt", user_prompt)]:
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{name} must be a non-empty string.")
    if type(max_tokens) is not int or max_tokens < 1:
        raise ValueError("max_tokens must be a positive integer.")

    api_key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not api_key:
        raise LLMError("Set DEEPSEEK_API_KEY in this terminal before calling the model.")

    payload = {
        "model": MODEL,
        "messages": [
            {
                "role": "system",
                "content": system_prompt + "\nReturn only a valid JSON object. No Markdown.",
            },
            {"role": "user", "content": user_prompt},
        ],
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "stream": False,
        "max_tokens": max_tokens,
    }

    try:
        with httpx.Client(timeout=60.0, follow_redirects=False) as client:
            response = client.post(
                API_URL,
                headers={"Authorization": f"Bearer {api_key}"},
                json=payload,
            )
            response.raise_for_status()
    except httpx.TimeoutException:
        raise LLMError("DeepSeek request timed out. No automatic retry was performed.") from None
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        raise LLMError(f"DeepSeek HTTP {status}. Check key, account balance, or service status.") from None
    except httpx.RequestError:
        raise LLMError("DeepSeek network connection failed. Check network/proxy settings.") from None

    try:
        body = response.json()
    except ValueError:
        raise LLMError("DeepSeek HTTP response was not valid JSON.") from None
    return parse_json_response(body)


def main() -> None:
    """Manual smoke check: running this module makes ONE live API request."""
    print(f"Calling {MODEL} on the official DeepSeek API...")
    try:
        result = generate_json(
            system_prompt="You are testing API connectivity. Output a JSON object only.",
            user_prompt='Return exactly this JSON object: {"status":"ok"}',
            max_tokens=128,
        )
        if result != {"status": "ok"}:
            raise LLMError("A JSON response arrived, but it did not match the smoke-check schema.")
    except (LLMError, ValueError) as error:
        raise SystemExit(f"ERROR: {error}") from None
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()