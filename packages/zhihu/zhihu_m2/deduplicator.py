from zhihu_m2.models import ZhihuResult


def deduplicate_results(results: list[ZhihuResult]) -> list[ZhihuResult]:
    """Remove repeated (content_type, content_id) pairs, keeping the first.

    Preserve input order. Keep items with missing identifiers because
    we cannot reliably determine whether they refer to the same content.
    Return a new list without changing the input list.
    """
    seen = set()
    unique_results = []

    for result in results:
        # 缺少标识时保留，不把所有空 ID 合并成一篇。
        if not result.content_id or not result.content_type:
            unique_results.append(result)
            continue

        key = (result.content_type, result.content_id)

        if key in seen:
            continue

        seen.add(key)
        unique_results.append(result)

    return unique_results


def limit_per_author(
    results: list[ZhihuResult],
    max_per_author: int = 1,
) -> list[ZhihuResult]:
    """Limit candidates per known author, preserving input order.

    Use author_signature to group authors. Do not group unknown authors.
    This is a candidate-selection rule, not a content-duplication judgment.
    """
    if type(max_per_author) is not int or max_per_author < 1:
        raise ValueError("max_per_author must be a positive integer")

    author_counts = {}
    selected_results = []

    for result in results:
        author = result.author_signature

        # 作者标识缺失时，不把所有未知作者当成同一个人。
        if not author:
            selected_results.append(result)
            continue

        count = author_counts.get(author, 0)

        if count >= max_per_author:
            continue

        selected_results.append(result)
        author_counts[author] = count + 1

    return selected_results