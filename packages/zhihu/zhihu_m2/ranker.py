"""M2 ranker V2.1: conservative promotion handling for search snippets.

Compatible with the ZhihuResult schema from this project. No API calls,
third-party libraries, or credentials are used here.

Only promotion detection/cleaning changes from V2. Weights, query-token
matching, technical-specificity rules, recency and engagement stay the same.
Scores are heuristic priorities, NOT calibrated probabilities or verification.
ContentText is a search snippet, not guaranteed full article text. Preserve
result.content_text and the source URL for later LLM review and attribution.
"""
import math
import re
import time

from zhihu_m2.models import ZhihuResult

# “微信” by itself is a product name, not a request to contact a seller.
CONTACT_TERMS = [
    "加微信", "加老师", "加助教", "联系老师", "私信", "扫码", "扫描二维码",
]
ACQUISITION_TERMS = [
    "领取", "领资料", "领一份", "限时", "名额", "报名", "送你",
    "获取资料", "免费入口", "购买", "下单", "优惠券",
]
COMMERCIAL_TERMS = [
    "公开课", "课程", "资料包", "资源包", "训练营", "内部资料", "咨询",
]
RECOMMENDATION_TERMS = [
    "推荐", "建议参加", "建议先听", "可以先听", "先听一下", "听一下",
    "我去听", "可以听", "可以参加",
]

# Uncertain recommendations are retained. Only strong CTAs are excluded
# from the temporary scoring view; the original text is never overwritten.
STRONG_PROMOTION_THRESHOLD = 0.80

# Narrow safeguards, not general negation or intent understanding.
# In particular, “不要错过” and “不要把它当成广告” are NOT exemptions.
_WARNING_PATTERN = re.compile(
    r"(?:不要|别|无需|不需要|不必|避免)(?:再|去|轻易|随便)?\s*"
    r"(?:加\s*v|加\s*微信|加老师|加助教|扫码|私信|报名|购买|付费|领取)"
    r"|(?:不推荐|不建议)(?:参加|报名|购买)?(?:这门|这些|这个)?"
    r"(?:公开课|课程|训练营)",
    flags=re.IGNORECASE,
)

SEQUENCE_TERMS = ["第一步", "第二步", "第三步", "首先", "然后", "接着", "最后", "step 1", "step1", "step 2", "step2", "step 3", "step3"]
ACTION_TERMS = ["调用", "实现", "搭建", "配置", "测试", "调试", "debug", "部署", "评估", "evaluation", "验证", "编写", "运行", "接入", "处理", "设计"]
DELIVERABLE_TERMS = ["api", "tool calling", "工具调用", "agent loop", "rag", "项目", "代码", "日志", "测试", "评估", "作品集", "协议", "状态"]
SPECIFICITY_TERMS = ["api", "json", "http", "github", "python", "typescript", "javascript", "rag", "react", "llm", "langchain", "tool calling", "工具调用", "agent loop", "eventstream", "sse", "prompt", "embedding", "向量", "协议", "日志", "evaluation", "评估", "测试"]


def _contains_any(text, terms):
    text = text.lower()
    return any(term.lower() in text for term in terms)


def _count_unique_terms(text, terms):
    text = text.lower()
    return sum(1 for term in terms if term.lower() in text)


def _paragraphs(text: str) -> list[str]:
    """Split into local scoring units, keeping sentence punctuation.

    The historical helper name is retained, but units can now be sentences.
    Chinese sentence endings and semicolons separate mixed ad/technical text.
    English periods are not split, avoiding fragmentation of URLs and versions.
    """
    if not text:
        return []
    parts = re.split(r"\n+|(?<=[。！？!?；;])", text)
    return [part.strip() for part in parts if part.strip()]


def _promotion_paragraph_score(paragraph: str) -> float:
    """Score a local unit: absent=0, uncertain recommendation=.35, CTA>=.85.

    A course recommendation is a weak signal, not proof of advertising.
    A plain mention of a course or WeChat is not enough to produce a signal.
    """
    text = paragraph.lower()

    if _WARNING_PATTERN.search(text):
        return 0.0

    has_contact = _contains_any(text, CONTACT_TERMS)
    # Supports 加V / 加 v / 加vx without treating an English word as "v".
    has_contact = has_contact or bool(re.search(r"加\s*v(?:x)?(?![a-z])", text))
    has_acquisition = _contains_any(text, ACQUISITION_TERMS)
    has_commercial = _contains_any(text, COMMERCIAL_TERMS)
    has_recommendation = _contains_any(text, RECOMMENDATION_TERMS)

    if has_contact and (has_acquisition or has_commercial):
        return 1.0
    if has_commercial and has_acquisition:
        return 0.85
    if has_commercial and has_recommendation:
        return 0.35
    return 0.0


def promotion_score(result: ZhihuResult) -> float:
    """Aggregate visible signals in the returned snippet, not in a full article.

    Unlike V2, do not discard every weak signal below .45. Use character-
    weighted signal density, and count only strong CTA units for repetition.
    """
    units = _paragraphs(result.content_text)
    if not units:
        return 0.0

    scores = []
    weighted_signal = 0.0
    total_length = 0
    strong_count = 0

    for unit in units:
        score = _promotion_paragraph_score(unit)
        scores.append(score)
        weighted_signal += len(unit) * score
        total_length += len(unit)
        if score >= STRONG_PROMOTION_THRESHOLD:
            strong_count += 1

    strongest_signal = max(scores)
    density = weighted_signal / total_length
    repetition = min(strong_count / 4, 1.0)
    score = 0.65 * strongest_signal + 0.20 * density + 0.15 * repetition
    return max(0.0, min(score, 1.0))


def clean_content(result: ZhihuResult) -> str:
    """Create a scoring-only view excluding strong CTA units.

    Keep uncertain recommendations for later interpretation. Do not overwrite
    the original snippet: later evidence review needs its context and caveats.
    """
    cleaned = []
    for unit in _paragraphs(result.content_text):
        if _promotion_paragraph_score(unit) < STRONG_PROMOTION_THRESHOLD:
            cleaned.append(unit)
    return "\n".join(cleaned)


def engagement_score(result: ZhihuResult) -> float:
    """Log-scaled popularity signal; not source reliability."""
    votes = max(result.vote_up_count, 0)
    comments = max(result.comment_count, 0)
    vote_score = min(math.log1p(votes) / math.log1p(500), 1.0)
    comment_score = min(math.log1p(comments) / math.log1p(100), 1.0)
    return 0.75 * vote_score + 0.25 * comment_score


def actionability_score(result: ZhihuResult) -> float:
    """V2 keyword heuristic applied to the conservative scoring view."""
    text = clean_content(result)
    if not text:
        return 0.0
    sequence_score = min(_count_unique_terms(text, SEQUENCE_TERMS) / 3, 1.0)
    action_score = min(_count_unique_terms(text, ACTION_TERMS) / 5, 1.0)
    deliverable_score = min(_count_unique_terms(text, DELIVERABLE_TERMS) / 5, 1.0)
    return 0.35 * sequence_score + 0.40 * action_score + 0.25 * deliverable_score


def _tokenize(text: str) -> set[str]:
    """Literal English tokens and Chinese bigrams; no semantic matching."""
    if not text:
        return set()
    text = text.lower()
    tokens = set(re.findall(r"[a-z0-9][a-z0-9_+.#-]*", text))
    for chunk in re.findall(r"[\u4e00-\u9fff]+", text):
        if len(chunk) <= 2:
            tokens.add(chunk)
        else:
            for i in range(len(chunk) - 1):
                tokens.add(chunk[i:i + 2])
    return tokens


def relevance_score(result: ZhihuResult, query: str) -> float:
    """V2 lexical overlap. Engineer/工程师 are NOT recognized as synonyms."""
    query_tokens = _tokenize(query)
    if not query_tokens:
        return 0.0
    title_tokens = _tokenize(result.title)
    content_tokens = _tokenize(clean_content(result))
    title_overlap = len(query_tokens & title_tokens) / len(query_tokens)
    content_overlap = len(query_tokens & content_tokens) / len(query_tokens)
    query_normalized = re.sub(r"\s+", "", query.lower())
    title_normalized = re.sub(r"\s+", "", result.title.lower())
    content_normalized = re.sub(r"\s+", "", clean_content(result).lower())
    phrase_bonus = 0.0
    if query_normalized and query_normalized in title_normalized:
        phrase_bonus += 0.20
    elif query_normalized and query_normalized in content_normalized:
        phrase_bonus += 0.10
    return min(0.55 * title_overlap + 0.45 * content_overlap + phrase_bonus, 1.0)


def specificity_score(result: ZhihuResult) -> float:
    """Coding-domain surface detail; terminology saturation is not expertise."""
    text = clean_content(result)
    if not text:
        return 0.0
    technical_score = min(_count_unique_terms(text, SPECIFICITY_TERMS) / 6, 1.0)
    number_hits = len(re.findall(r"\b\d+(?:\.\d+)?\b", text))
    structure_hits = len(re.findall(r"(?:第[一二三四五六七八九十\d]+[步章节]|part\s*\d+|step\s*\d+)", text, flags=re.IGNORECASE))
    detail_score = min((number_hits + structure_hits) / 6, 1.0)
    return 0.75 * technical_score + 0.25 * detail_score


def recency_score(result: ZhihuResult, now_ts=None) -> float:
    """V2 edit-time heuristic. An edit timestamp does not verify freshness."""
    if not result.edit_time:
        return 0.5
    if now_ts is None:
        now_ts = int(time.time())
    age_seconds = max(now_ts - result.edit_time, 0)
    age_days = age_seconds / 86400
    if age_days <= 180:
        return 1.0
    if age_days <= 365:
        return 0.85
    if age_days <= 730:
        return 0.70
    if age_days <= 1095:
        return 0.55
    return 0.40


def evidence_score(result: ZhihuResult, query: str, now_ts=None) -> float:
    """V2 weighted priority with a promotion penalty, not a truth score."""
    base_score = (
        0.30 * relevance_score(result, query)
        + 0.25 * actionability_score(result)
        + 0.20 * specificity_score(result)
        + 0.15 * recency_score(result, now_ts=now_ts)
        + 0.10 * engagement_score(result)
    )
    final_score = base_score * (1 - 0.50 * promotion_score(result))
    return max(0.0, min(final_score, 1.0))


def rank_results(results: list[ZhihuResult], query: str, now_ts=None) -> list[ZhihuResult]:
    """Return a new list, descending by score; ties preserve input order."""
    return sorted(results, key=lambda result: evidence_score(result, query, now_ts=now_ts), reverse=True)