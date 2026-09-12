"""Synthetic V3 runner -> compiler validator -> TS fixture. No real model/network."""
import copy
import json
import os
import socket

os.environ["PYTHON_DOTENV_DISABLED"] = "1"

from zhihu_m2 import evidence_compiler as ec, research_runner as rr
from zhihu_m2.retrieval_options import RetrievalOptions

SNIPPET = "😀开头\r\n记录调用的实际参数，再与预先写下的期望参数逐项比较。"
QUOTE = SNIPPET[5:]
REQUEST = {"goal": "检查调用参数", "user_context": {}, "request": {
    "id": "external-v3-🧪", "question": "如何判断调用参数正确？",
    "searchQueries": ["调用参数 检查", "实际参数 预期 比较"],
    "relevantUserConditions": [], "evidenceLimit": 1,
}}


def forbidden(*args, **kwargs):
    raise AssertionError("Synthetic fixture forbids real network")


def fake_compile(result, **kwargs):
    assert kwargs["retrieval_profile"] == "v3"
    assert result.content_text == SNIPPET
    return ec.validate_evidence_response({"status": "ok", "reason": "合成测试中的参数比较方法", "evidence_cards": [{
        "source_id": f"zhihu:{result.content_type}:{result.content_id}",
        "supporting_quote": QUOTE, "claim": "作者建议记录实际参数并与预期逐项比较。",
        "claim_type": "advice", "applies_when": "已有明确的期望参数时", "caveats": ["合成离线数据，不是真实API结果"],
    }]}, result, retrieved_at=kwargs["retrieved_at"])


def main():
    socket.socket.connect = forbidden
    ec.llm_client.generate_json = forbidden
    calls = []
    def search(query, **kwargs):
        calls.append(query)
        text = "一个支持测试的教程，共十二课，包含调用参数介绍。" if len(calls) == 1 else SNIPPET
        return {"Code": 0, "Data": {"Items": [{
            "ContentType": "answer", "ContentID": "synthetic-v3", "Title": "离线合成调用参数示例",
            "ContentText": text, "AuthorName": "合成作者",
            "Url": "https://www.zhihu.com/question/1/answer/synthetic-v3?preserve=1",
        }]}}
    frozen = copy.deepcopy(REQUEST)
    metrics = {}
    data = rr.run_research(REQUEST, dependencies=rr.ResearchDependencies(
        search=search, compile=fake_compile, now=lambda: "2026-09-12T00:00:00+00:00",
    ), options=RetrievalOptions("v3"), metrics=metrics)
    assert REQUEST == frozen
    assert calls == REQUEST["request"]["searchQueries"]
    assert metrics["compiler_calls_attempted"] == 1
    print(json.dumps({"protocol_version": "m2-entry-v0.1", "run_id": "offline-v3-runner",
        "action": "research", "ok": True, "error": None, "data": data, "metrics": metrics}, ensure_ascii=False))


if __name__ == "__main__":
    main()
