"""Deterministic snippet priorities, not semantic support or factual verification."""
import math
import re
from dataclasses import dataclass
from typing import Mapping, Sequence
from zhihu_m2.models import ZhihuResult
from zhihu_m2.candidate_pool import SourceCandidate, variant_key
from zhihu_m2.ranker import (clean_content, relevance_score, promotion_score,
                             recency_score, engagement_score, _tokenize, _paragraphs)


@dataclass(frozen=True)
class RankingContext:
    question: str
    queries: tuple[str, ...]
    freshness_requested: bool
    now_ts: float


@dataclass(frozen=True)
class RankedSource:
    source_id: str
    representative_index: int
    priority: float
    components: Mapping[str, float]


# Patterns operate on temporary lowercase views. These are observable surface
# clues only; no author/tool blacklist or domain-specific terminology bonus.
INTENT_PATTERNS = {
    'method': r'怎样|如何|怎么|方法|步骤|how\b',
    'verification': r'检验|验证|检查|判断|正确|符合|达标|verify|verification',
    'risk': r'风险|限制|局限|条件|失败|踩坑|risk|limitation',
    'resource': r'资源|资料|教程|书籍|推荐.*(?:工具|框架)|resource|tutorial',
    'concept': r'什么是|是什么|定义|概念|区别|组成|what is|definition',
    'experience': r'经历|经验|实践|亲身|experience',
}
ACTION_TERMS = ('记录', '比较', '对比', '替换', '检查', '测量', '拆分', '列出',
                '收集', '访谈', '复盘', '核对', '保存', '传入', '断言')
VERIFY_ACTIONS = ('比较', '对比', '检查', '核对', '断言', '测量')
VERIFY_OBJECTS = ('期望', '预期', '标准', '样例', '误差', '失败', '结果', '差异', '不一致')
CONDITIONS = ('如果', '当', '除非', '取决于')
CONSEQUENCES = ('限制', '失败', '漏掉', '无法', '不能', '不适用', '风险', '误差', '不要', '延期')
RESOURCE_TYPES = ('教程', '资料', '资源', '书', '框架', '工具', '课程', '文档')
RESOURCE_USES = ('适用', '用于', '支持', '帮助', '面向', '入门', '供', '用来')


def detect_intents(question: str) -> tuple[str, ...]:
    text = question.lower()
    return tuple(name for name, pattern in INTENT_PATTERNS.items() if re.search(pattern, text)) or ('unknown',)


def _has(text, terms):
    return any(term in text for term in terms)


def _actions(unit: str) -> set[str]:
    """Require a nonempty adjacent object, including Chinese object-before-verb.

    Commas delimit action clauses; sentence/semicolon units govern co-occurrence.
    Capability lists ('supports assertions') are not instructions. A bare verb
    or trailing grammatical filler does not count as a concrete action.
    """
    hits = set()
    for clause in re.split(r'[，,、]', unit):
        if re.search(r'支持|号称|首选|功能|能力', clause):
            continue
        for verb in ACTION_TERMS:
            if verb not in clause:
                continue
            before, _, after = clause.partition(verb)
            after = re.sub(r'^[了过着下]', '', after).strip(' 。！？!?；;:：')
            before = re.sub(r'^(?:再|先|然后|逐项|把|与|将|我|我们|并|后)+', '', before).strip()
            after = re.sub(r'^(?:一下|一番|一下子)$', '', after)
            if re.search(r'[\w\u4e00-\u9fff]', after) or len(before) >= 2:
                hits.add(verb)
    return hits


def intent_surface_score(result: ZhihuResult, intents: tuple[str, ...]) -> float:
    units = [u.lower() for u in _paragraphs(clean_content(result))]
    actions = set().union(*(_actions(u) for u in units)) if units else set()
    scores = {'unknown': .5, 'method': min(.5 * len(actions), 1.0)}
    scores['verification'] = float(any(_actions(u) & set(VERIFY_ACTIONS) and _has(u, VERIFY_OBJECTS) for u in units))
    scores['risk'] = float(any(_has(u, CONDITIONS) and _has(u, CONSEQUENCES) for u in units))
    scores['resource'] = float(any(_has(u, RESOURCE_TYPES) and _has(u, RESOURCE_USES) for u in units))
    scores['concept'] = float(any(re.search(r'.+(?:是指|指的是|定义为|由.+组成|区别在于|是).+', u) for u in units))
    scores['experience'] = float(any(re.search(r'我(?:们)?', u) and _actions(u) and _has(u, ('结果','发现','误差','失败','限制','完成','无法','最后')) for u in units))
    selected = intents or ('unknown',)
    return sum(scores.get(intent, .5) for intent in selected) / len(selected)


def rrf_scores(candidates: Sequence[SourceCandidate], successful_query_indexes: set[int], *, k: int = 60) -> dict[str, float]:
    if type(k) is not int or k <= 0:
        raise ValueError('k must be a positive integer')
    scores = {}
    for candidate in candidates:
        best = {}
        for occurrence in candidate.occurrences:
            if type(occurrence.result_rank) is not int or occurrence.result_rank <= 0:
                raise ValueError('result rank must be a positive integer')
            q = occurrence.query_index
            if q in successful_query_indexes:
                best[q] = min(best.get(q, occurrence.result_rank), occurrence.result_rank)
        # Floating-point summation can overshoot 1 for perfect five-query hits.
        normalized = (math.fsum(1 / (k + rank) for rank in best.values()) /
                      (len(successful_query_indexes) / (k + 1))) if successful_query_indexes else 0.0
        scores[candidate.source_id] = max(0.0, min(normalized, 1.0))
    return scores


def _finite(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError('ranking values must be finite numbers')
    return value


def rank_candidates(candidates: Sequence[SourceCandidate], context: RankingContext,
                    successful_query_indexes: set[int]) -> list[RankedSource]:
    _finite(context.now_ts)
    fused = rrf_scores(candidates, successful_query_indexes)
    intents = detect_intents(context.question)
    ranked = []
    for candidate in candidates:
        variants = []
        for index, occurrence in enumerate(candidate.occurrences):
            result = occurrence.result
            for value in (result.vote_up_count, result.comment_count, result.edit_time, result.ranking_score):
                _finite(value)
            components = {
                'lexical': .8 * relevance_score(result, context.question) + .2 * max((relevance_score(result, q) for q in context.queries), default=0.),
                'rrf': fused[candidate.source_id],
                'intent': intent_surface_score(result, intents),
                'recency': recency_score(result, now_ts=context.now_ts) if context.freshness_requested else .5,
                'engagement': engagement_score(result),
                'promotion': promotion_score(result),
            }
            for value in components.values():
                if not 0 <= _finite(value) <= 1:
                    raise ValueError('ranking components must be in [0, 1]')
            priority = sum(weight * components[key] for weight, key in ((.45,'lexical'),(.2,'rrf'),(.25,'intent'),(.05,'recency'),(.05,'engagement'))) * (1 - .5 * components['promotion'])
            priority = max(0., min(_finite(priority), 1.))
            variants.append(((-priority, occurrence.query_index, occurrence.result_rank, variant_key(occurrence)), RankedSource(candidate.source_id, index, priority, components)))
        if not variants:
            raise ValueError('source must have an occurrence')
        ranked.append(min(variants, key=lambda item: item[0])[1])
    return sorted(ranked, key=lambda item: (-item.priority, item.source_id))


def select_next_source(ranked: Sequence[RankedSource], pool: Mapping[str, SourceCandidate],
                       attempted_ids: set[str], accepted_ids: set[str], *,
                       diversity_weight: float = .15, score_band: float = .10) -> RankedSource | None:
    if not 0 <= _finite(diversity_weight) <= 1 or not 0 <= _finite(score_band) <= 1:
        raise ValueError('diversity parameters must be in [0, 1]')
    remaining = [r for r in ranked if r.source_id not in attempted_ids]
    if not remaining:
        return None
    best = max(r.priority for r in remaining)
    eligible = [r for r in remaining if best - r.priority <= score_band + 1e-12]
    def tokens(r):
        result = pool[r.source_id].occurrences[r.representative_index].result
        return _tokenize(clean_content(result))
    accepted_tokens = [tokens(r) for r in ranked if r.source_id in accepted_ids]
    def selection_key(r):
        current = tokens(r)
        similarity = max((len(current & other) / len(current | other) if current | other else 0.
                          for other in accepted_tokens), default=0.)
        adjusted = (1 - diversity_weight) * r.priority - diversity_weight * similarity
        return (-adjusted, -r.priority, r.source_id)
    return min(eligible, key=selection_key)
