import pytest

from zhihu_m2 import deduplicator
from zhihu_m2.normalizer import normalize_result


def make_result(content_id, author_signature="author-a", title="Test"):
    """Create test data without calling the Zhihu API."""
    return normalize_result({
        "ContentID": content_id,
        "ContentType": "Answer",
        "AuthorSignature": author_signature,
        "AuthorName": "Test Author",
        "Title": title,
        "ContentText": "Test content",
    })


def test_duplicate_content_keeps_first_copy():
    first = make_result("101", title="First copy")
    duplicate = make_result("101", title="Second copy")
    other = make_result("102")
    original = [first, duplicate, other]

    results = deduplicator.deduplicate_results(original)

    assert results == [first, other]
    assert results[0] is first
    assert len(original) == 3


def test_same_title_does_not_mean_same_answer():
    first = make_result("101", title="如何学习 Agent？")
    second = make_result("102", title="如何学习 Agent？")

    results = deduplicator.deduplicate_results([first, second])

    assert results == [first, second]


def test_same_id_with_different_content_types_is_kept():
    answer = make_result("101")
    article = make_result("101")
    article.content_type = "Article"

    results = deduplicator.deduplicate_results([answer, article])

    assert results == [answer, article]


def test_missing_ids_are_not_merged():
    first = make_result("", title="First")
    second = make_result("", title="Second")

    results = deduplicator.deduplicate_results([first, second])

    assert results == [first, second]


def test_author_limit_preserves_input_order():
    first = make_result("101", author_signature="author-a")
    second = make_result("102", author_signature="author-a")
    third = make_result("103", author_signature="author-b")
    original = [first, second, third]

    results = deduplicator.limit_per_author(original, max_per_author=1)

    assert results == [first, third]
    assert len(original) == 3
    assert deduplicator.limit_per_author(original, max_per_author=2) == original


def test_unknown_authors_are_not_grouped_together():
    first = make_result("101", author_signature="")
    second = make_result("102", author_signature="")

    results = deduplicator.limit_per_author([first, second])

    assert results == [first, second]


def test_empty_input_returns_empty_list():
    assert deduplicator.deduplicate_results([]) == []
    assert deduplicator.limit_per_author([]) == []


def test_author_limit_must_be_a_positive_integer():
    for invalid_limit in [0, -1, True, 1.5, "1", None]:
        with pytest.raises(ValueError):
            deduplicator.limit_per_author([], max_per_author=invalid_limit)