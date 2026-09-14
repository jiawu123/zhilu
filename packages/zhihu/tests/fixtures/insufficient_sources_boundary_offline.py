"""Real research validation -> JSON boundary with zero cards and original posts.

The two retrieved snippets and model classifications are synthetic offline test
data. Neither searches nor model HTTP calls are made. --provider reads stdin.
"""
import json
import sys

import httpx

from zhihu_m2 import batch_screening, query_planner
from zhihu_m2.research_runner import ResearchDependencies, run_research, validate_research_input
from zhihu_m2.retrieval_options import RetrievalOptions


def forbidden(*args, **kwargs):
    raise AssertionError('Offline source fixture must not call network or Planner.')


def main():
    httpx.Client.send = forbidden
    query_planner.plan_research = forbidden
    payload = {'goal': '安排一次东京演唱会行程。', 'user_context': {},
        'request': {'id': 'external-insufficient-rq', 'question': '演唱会如何购票？',
            'searchQueries': ['演唱会 官方 购票'], 'relevantUserConditions': [], 'evidenceLimit': 8}}
    if sys.argv[1:] == ['--provider']:
        payload = validate_research_input(json.loads(sys.stdin.read(64001)))
    elif sys.argv[1:]:
        raise SystemExit('Invalid fixture arguments.')
    assert len(payload['request']['searchQueries']) == 1
    queries, batches = [], []
    def search(query, **kwargs):
        queries.append(query)
        return {'Code': 0, 'Data': {'Items': [{
            'ContentType': 'answer', 'ContentID': str(index),
            'Title': f'离线合成帖子{index}', 'AuthorName': f'合成作者{index}',
            'ContentText': snippet, 'Url': f'https://www.zhihu.com/question/1/answer/{index}',
        } for index, snippet in enumerate([
            '😀原始帖子第一行。\r\n这里没有该场演唱会的明确售票信息。',
            '🎵原始帖子另一行。\r\n只介绍了作者过去的一次旅行经历。',
        ], start=1)]}}
    def batch(candidates, **kwargs):
        batches.append(len(candidates))
        return batch_screening.validate_batch_response({'items': [{
            'candidate_index': 0, 'relevance': 'unrelated', 'applicability': 'unknown',
            'support': 'none', 'freshness': 'uncertain', 'compilation': {
                'status': 'no_evidence', 'reason': '片段未给出当前问题所需的信息。', 'evidence_cards': []}}, {
            'candidate_index': 1, 'relevance': 'partially', 'applicability': 'unknown',
            'support': 'indirect', 'freshness': 'uncertain', 'compilation': {
                'status': 'ok', 'reason': '不合法的合成模型提案，必须拒绝。', 'evidence_cards': [{
                    'source_id': 'zhihu:answer:2', 'supporting_quote': '这段虚构引文从未出现于原文。',
                    'claim': '不应展示的被拒绝模型主张。', 'claim_type': 'advice',
                    'applies_when': '未知', 'caveats': [],
                }]}}], 'researchCandidates': []}, candidates, **kwargs)
    metrics = {}
    result = run_research(payload, options=RetrievalOptions('batch-v1'), metrics=metrics,
        dependencies=ResearchDependencies(search=search, batch_compile=batch,
            now=lambda: '2026-09-13T12:00:00+00:00', compile=forbidden))
    assert queries == payload['request']['searchQueries'] and batches == [2]
    assert metrics['search_calls_attempted'] == metrics['batch_model_calls_attempted'] == 1
    assert result['status'] == 'partial' and result['coverage']['evidenceCount'] == 0
    assert len(result['insufficientSources']) == 2
    print(json.dumps({'protocol_version': 'm2-entry-v0.1', 'run_id': 'offline-insufficient-sources',
        'action': 'research', 'ok': True, 'error': None, 'data': result, 'metrics': metrics}, ensure_ascii=False))


if __name__ == '__main__':
    main()
