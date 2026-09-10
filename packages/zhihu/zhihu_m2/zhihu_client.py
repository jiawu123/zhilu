import os
import json
import subprocess

from pathlib import Path


def validate_count(count):
    """
    Validate the number of Zhihu search results requested.

    Args:
        count: Number of search results.

    Returns:
        The validated count.

    Raises:
        ValueError: If count is outside the range 1-10.
    """

    if count < 1 or count > 10:
        raise ValueError("count must be between 1 and 10")

    return count


def extract_items(response):
    """
    Extract search items from a Zhihu API response.

    Args:
        response: Dictionary returned by Zhihu CLI.

    Returns:
        A list of Zhihu search result dictionaries.
    """

    if response.get("Code") != 0:
        raise RuntimeError(
            response.get("Message", "Zhihu search failed")
        )

    data = response.get("Data", {})

    return data.get("Items", [])


def get_cli_path():
    """
    Find the locally installed Zhihu CLI executable.

    Returns:
        Path to zhihu-cli.exe.

    Raises:
        RuntimeError: If LOCALAPPDATA cannot be found.
        FileNotFoundError: If Zhihu CLI is not installed.
    """

    local_app_data = os.environ.get("LOCALAPPDATA")

    if local_app_data is None:
        raise RuntimeError(
            "LOCALAPPDATA environment variable was not found"
        )

    cli_path = (
        Path(local_app_data)
        / "ZhihuCLI"
        / "current"
        / "zhihu-cli.exe"
    )

    if not cli_path.exists():
        raise FileNotFoundError(
            f"Zhihu CLI not found at {cli_path}"
        )

    return cli_path

def search_zhihu(query, count=5):
    """
    Search Zhihu using the official Zhihu CLI.

    Args:
        query: The search query.
        count: Number of results to request.

    Returns:
        A list of Zhihu search result dictionaries.
    """

    if not query.strip():
        raise ValueError("query cannot be empty")

    count = validate_count(count)

    cli_path = get_cli_path()

    command = [
        str(cli_path),
        "search",
        "zhihu",
        "--query",
        query,
        "--count",
        str(count),
    ]

    result = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )

    if result.returncode != 0:
        raise RuntimeError(
            f"Zhihu CLI failed: {result.stderr}"
        )

    response = json.loads(result.stdout)

    return extract_items(response)