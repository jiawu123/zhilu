from zhihu_m2.models import ZhihuResult


def normalize_result(raw_result):
    """
    Convert one raw Zhihu API result into a ZhihuResult.

    Args:
        raw_result: Dictionary returned by Zhihu search.

    Returns:
        A normalized ZhihuResult.
    """

    return ZhihuResult(
        title=raw_result.get("Title", ""),
        content_type=raw_result.get("ContentType", ""),
        content_id=raw_result.get("ContentID", ""),

        author_name=raw_result.get("AuthorName", ""),
        author_signature=raw_result.get("AuthorSignature", ""),
        author_badge_text=raw_result.get("AuthorBadgeText", ""),

        content_text=raw_result.get("ContentText", ""),
        url=raw_result.get("Url", ""),

        vote_up_count=raw_result.get("VoteUpCount", 0),
        comment_count=raw_result.get("CommentCount", 0),

        authority_level=raw_result.get("AuthorityLevel", ""),
        ranking_score=raw_result.get("RankingScore", 0.0),
        edit_time=raw_result.get("EditTime", 0),
    )

def normalize_results(raw_results):
    """
    Normalize multiple Zhihu search results.

    Args:
        raw_results: List of dictionaries returned by Zhihu search.

    Returns:
        List of ZhihuResult objects.
    """

    results = []

    for raw_result in raw_results:
        normalized_result = normalize_result(raw_result)
        results.append(normalized_result)

    return results