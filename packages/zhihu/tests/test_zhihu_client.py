from zhihu_m2 import zhihu_client
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace


def test_validate_count():
    """
    Zhihu search only allows count between 1 and 10.
    """

    assert zhihu_client.validate_count(5) == 5


def test_extract_items():
    """
    Extract Zhihu search items from a successful API response.
    """

    response = {
        "Code": 0,
        "Message": "success",
        "Data": {
            "Items": [
                {
                    "Title": "Test Answer",
                    "ContentType": "Answer",
                    "ContentID": "123",
                    "AuthorName": "Test User",
                    "ContentText": "This is a test answer.",
                    "Url": "https://www.zhihu.com/test",
                    "VoteUpCount": 100,
                }
            ]
        },
    }

    items = zhihu_client.extract_items(response)

    assert len(items) == 1
    assert items[0]["Title"] == "Test Answer"


def test_get_cli_path():
    """
    The Zhihu CLI executable should exist on this computer.
    """

    cli_path = zhihu_client.get_cli_path()

    assert cli_path.exists()
    assert cli_path.name == "zhihu-cli.exe"

def test_search_zhihu(monkeypatch):
    """
    search_zhihu should call the Zhihu CLI
    and return the search result items.
    """

    fake_response = {
        "Code": 0,
        "Message": "success",
        "Data": {
            "Items": [
                {
                    "Title": "AI Agent Test",
                    "AuthorName": "Test Author",
                    "ContentText": "Test content",
                    "Url": "https://www.zhihu.com/test",
                    "VoteUpCount": 10,
                }
            ]
        },
    }

    def fake_run(command, **kwargs):
        return SimpleNamespace(
            returncode=0,
            stdout=json.dumps(fake_response),
            stderr="",
        )

    monkeypatch.setattr(
        zhihu_client,
        "get_cli_path",
        lambda: Path("C:/fake/zhihu-cli.exe"),
    )

    monkeypatch.setattr(
        subprocess,
        "run",
        fake_run,
    )

    results = zhihu_client.search_zhihu(
        "Agent Engineer 学习路线",
        count=5,
    )

    assert len(results) == 1
    assert results[0]["Title"] == "AI Agent Test"