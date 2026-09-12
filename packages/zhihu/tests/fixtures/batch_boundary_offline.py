"""Synthetic two-domain batch -> killable worker -> real TS boundary fixture.

Pass programming or writing. No credentials, network, planner or search are used.
The generated classifications are injected test data, not quality evaluation.
"""
import json
import os
import sys
from dataclasses import asdict

from zhihu_m2 import batch_screening
from zhihu_m2.models import ZhihuResult
from zhihu_m2.research_runner import _compile_with_deadline, assess_coverage, validate_research_input


DOMAINS = {
    'programming': {
        'goal': '完成一个有测试的小程序。', 'question': '怎样安排编码和测试的顺序？',
        'quotes': [
            '预期输出明确时，先写失败用例，再实现代码并检查测试是否通过。',
            '需求还在探索时，先做最小实验，明确行为后再补充测试用例。',
        ],
        'titles': ['明确预期后先写测试', '探索需求后补齐测试'],
        'conditions': ['预期输出已经明确时', '需求与行为仍需要探索时'],
    },
    'writing': {
        'goal': '完成一篇结构清晰的短文。', 'question': '怎样安排提纲和初稿的顺序？',
        'quotes': [
            '中心论点已经清楚时，先列出提纲，再逐段检查是否服务于论点。',
            '还没找到中心论点时，先自由写一段，再找出主要想法调整结构。',
        ],
        'titles': ['明确论点后先列提纲', '探索想法后整理结构'],
        'conditions': ['中心论点已经明确时', '主要想法仍需要探索时'],
    },
}


def offline_model(**kwargs):
    prompt = json.loads(kwargs['user_prompt'])
    domain = prompt['user_context']['fixture_domain']
    specification = DOMAINS[domain]
    items = []
    for index, value in enumerate(prompt['candidates']):
        group = 0 if index < 4 else 1
        items.append({
            'candidate_index': value['candidate_index'], 'relevance': 'strongly',
            'applicability': 'conditional', 'support': 'direct', 'freshness': 'uncertain',
            'compilation': {'status': 'ok', 'reason': '合成离线工程回归：引文回答顺序和适用前提。',
                            'evidence_cards': [{
                'source_id': value['source']['source_id'],
                'supporting_quote': value['source']['snippet'][5:],
                'claim': '作者建议：' + specification['quotes'][group],
                'claim_type': 'advice', 'applies_when': specification['conditions'][group],
                'caveats': ['合成离线数据，不能证明真实语义分歧或质量提升。'] if index == 0 else [],
            }]},
        })
    return {'items': items, 'researchCandidates': [{
        'title': specification['titles'][group],
        'summary': '作者建议：' + specification['quotes'][group],
        'applicableWhen': [specification['conditions'][group]],
        'candidateIndices': list(range(group * 4, group * 4 + 4)),
        'risks': ['合成工程回归，真实来源和语义分歧尚需人工标注。'],
    } for group in range(2)]}


def offline_compile_batch(candidates, **kwargs):
    assert os.getpid() != kwargs['user_context']['fixture_parent_pid']
    import httpx
    def forbidden(*args, **kwargs):
        raise AssertionError('Offline fixture must not use the network.')
    httpx.Client.send = forbidden
    batch_screening.llm_client.generate_json = offline_model
    return batch_screening.compile_batch(candidates, **kwargs)


def main():
    domain = sys.argv[1] if len(sys.argv) > 1 else 'programming'
    if domain not in DOMAINS:
        raise SystemExit('Unknown fixture domain.')
    specification = DOMAINS[domain]
    request_id, evidence_limit = 'external-rq', 8
    if sys.argv[2:] == ['--provider']:
        # Exercise the real Provider stdin/end/close contract, including the
        # externally allocated ID, without accepting arbitrary process options.
        incoming = validate_research_input(json.loads(sys.stdin.read(64001)))
        request_id, evidence_limit = incoming['request']['id'], incoming['request']['evidenceLimit']
    elif len(sys.argv) > 2:
        raise SystemExit('Invalid fixture arguments.')
    candidates = []
    for index in range(8):
        group = 0 if index < 4 else 1
        result = ZhihuResult(
            title=f'合成{domain}来源{index}', content_type='Answer', content_id=str(index + 1),
            author_name=f'合成作者{index // 2}', author_signature='', author_badge_text='',
            content_text='😀开头\r\n' + specification['quotes'][group],
            url=f'https://www.zhihu.com/question/1/answer/{index + 1}',
            vote_up_count=0, comment_count=0, authority_level='', ranking_score=0.0, edit_time=0,
        )
        candidates.append({'result': asdict(result), 'retrieved_at': '2026-09-12T10:00:00+00:00'})
    raw = _compile_with_deadline(candidates, timeout=15, compiler=offline_compile_batch,
                                goal=specification['goal'], research_question=specification['question'],
                                user_context={'fixture_parent_pid': os.getpid(), 'fixture_domain': domain})
    selected = batch_screening.select_evidence(raw, evidence_limit=evidence_limit)
    outputs = selected['compilerOutputs']
    groups = selected['researchCandidates']
    print(json.dumps({
        'protocol_version': 'm2-entry-v0.1', 'run_id': f'offline-python-batch-{domain}',
        'action': 'research', 'ok': True, 'error': None,
        'data': {'requestId': request_id, 'status': 'ok', 'compilerOutputs': outputs,
                 'routeCandidates': groups, 'unresolvedQuestions': [], 'issues': [],
                 'coverage': assess_coverage(outputs, groups)},
        'metrics': {'search_calls_attempted': 0, 'compiler_calls_attempted': 0,
                    'batch_model_calls_attempted': 1, 'model_calls_attempted': 1,
                    'candidate_count': len(candidates), 'evidence_count': sum(len(output['evidence_cards']) for output in outputs)},
    }, ensure_ascii=False))


if __name__ == '__main__':
    main()
