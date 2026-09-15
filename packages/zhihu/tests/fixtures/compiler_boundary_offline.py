"""Synthetic cross-language fixture: real compiler, injected offline model only."""
import json
import os
from zhihu_m2 import evidence_compiler
from zhihu_m2.models import ZhihuResult
from zhihu_m2.research_runner import _compile_with_deadline

snippet = "😀开头\r\n给程序输入固定样例，并检查输出结果。"
source = ZhihuResult(title="离线合成来源", content_type="Answer", content_id="1",
    author_name="合成作者", author_signature="", author_badge_text="",
    content_text=snippet, url="https://www.zhihu.com/question/1/answer/2",
    vote_up_count=0, comment_count=0, authority_level="", ranking_score=0, edit_time=0)

def offline_model(**kwargs):
    return {"status": "ok", "reason": "合成离线测试", "evidence_cards": [{
        "source_id": "zhihu:Answer:1", "supporting_quote": snippet[5:],
        "claim": "作者建议检查输出", "claim_type": "advice", "applies_when": "检查程序时",
        "caveats": ["合成离线数据，不是真实研究结果"]}]}

def offline_compile(result, **kwargs):
    # This fixture must actually cross the same spawn boundary as production.
    assert os.getpid() != kwargs['user_context']['fixture_parent_pid']
    evidence_compiler.llm_client.generate_json = offline_model
    return evidence_compiler.compile_evidence(result, **kwargs)


def main():
    output = _compile_with_deadline(source, timeout=10, compiler=offline_compile,
        goal="检查程序", user_context={'fixture_parent_pid': os.getpid()}, research_question="怎样检查程序？")
    print(json.dumps({"protocol_version": "m2-entry-v0.1", "run_id": "offline-python-compiler",
        "action": "research", "ok": True, "error": None,
        "data": {"requestId": "external-rq", "status": "ok", "compilerOutputs": [output],
            "routeCandidates": [], "unresolvedQuestions": [], "issues": []},
        "metrics": {"search_calls_attempted": 0, "compiler_calls_attempted": 1,
            "candidate_count": 1, "evidence_count": 1}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
