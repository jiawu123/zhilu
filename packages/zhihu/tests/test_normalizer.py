from zhihu_m2.models import ZhihuResult
from zhihu_m2.normalizer import normalize_result
from zhihu_m2.normalizer import normalize_result, normalize_results


def test_normalize_result():
    """
    Convert a raw Zhihu search item into a ZhihuResult.
    """

    raw_result = {
        "Title": "如何成为 AI Agent 工程师?",
        "ContentType": "Answer",
        "ContentID": "12345",
        "AuthorName": "Test Author",
        "AuthorSignature": "test-author",
        "AuthorBadgeText": "软件工程师",
        "ContentText": "这是一个测试回答。",
        "Url": "https://www.zhihu.com/test",
        "VoteUpCount": 100,
        "CommentCount": 20,
        "AuthorityLevel": "4",
        "RankingScore": 2.5,
        "EditTime": 1788188812,
    }

    result = normalize_result(raw_result)

    assert isinstance(result, ZhihuResult)
    assert result.title == "如何成为 AI Agent 工程师?"
    assert result.author_name == "Test Author"
    assert result.vote_up_count == 100
    assert result.comment_count == 20
    assert result.ranking_score == 2.5

def test_normalize_results():
    """
    Normalize multiple Zhihu search results.
    """

    raw_results = [
        {
            "Title": "Result 1",
            "ContentType": "Answer",
            "ContentID": "1",
            "AuthorName": "Author 1",
            "ContentText": "Content 1",
            "Url": "https://www.zhihu.com/1",
            "VoteUpCount": 10,
        },
        {
            "Title": "Result 2",
            "ContentType": "Article",
            "ContentID": "2",
            "AuthorName": "Author 2",
            "ContentText": "Content 2",
            "Url": "https://www.zhihu.com/2",
            "VoteUpCount": 20,
        },
    ]

    results = normalize_results(raw_results)

    assert len(results) == 2
    assert results[0].title == "Result 1"
    assert results[1].title == "Result 2"