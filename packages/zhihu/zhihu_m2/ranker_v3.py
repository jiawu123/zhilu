"""Deterministic snippet priorities, not semantic support or factual verification."""
import math
from dataclasses import dataclass
from typing import Mapping, Sequence
from zhihu_m2.models import ZhihuResult
from zhihu_m2.question_signals import detect_intents, surface_scores
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


def intent_surface_score(result: ZhihuResult, intents: tuple[str, ...]) -> float:
    """Use the same domain-neutral scoring view as the local ranker."""
    scores = surface_scores(_paragraphs(clean_content(result)))
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
