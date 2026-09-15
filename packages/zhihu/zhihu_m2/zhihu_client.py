import os
import json
import shutil
import subprocess

from pathlib import Path

from zhihu_m2.config import PACKAGE_ROOT, load_local_env


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
            "Zhihu search failed. Check CLI authorization and service status."
        )

    data = response.get("Data", {})

    return data.get("Items", [])


def get_cli_path():
    """Find a local CLI without depending on a particular Windows username.

    Order: explicit ZHIHU_CLI_PATH, the existing Windows install location,
    then PATH. Relative overrides are relative to packages/zhihu, not cwd.
    This locates the binary only; it does not verify authentication.
    """
    load_local_env()
    configured = os.environ.get("ZHIHU_CLI_PATH", "").strip()
    if configured:
        cli_path = Path(configured).expanduser()
        if not cli_path.is_absolute():
            cli_path = PACKAGE_ROOT / cli_path
        if not cli_path.is_file():
            raise FileNotFoundError(
                "ZHIHU_CLI_PATH does not point to an existing CLI executable."
            )
        return cli_path

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        cli_path = Path(local_app_data) / "ZhihuCLI" / "current" / "zhihu-cli.exe"
        if cli_path.is_file():
            return cli_path

    discovered = shutil.which("zhihu-cli")
    if discovered:
        return Path(discovered)

    raise FileNotFoundError(
        "Zhihu CLI was not found. Install the official CLI, or set "
        "ZHIHU_CLI_PATH in packages/zhihu/.env to its executable path."
    )


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

    # No secret in command-line arguments, no shell, no automatic auth write.
    # The CLI inherits the current process environment by default.
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError("Zhihu CLI timed out; no automatic retry was performed.") from None
    except OSError:
        raise RuntimeError("Unable to start Zhihu CLI. Check its installation and permissions.") from None

    if result.returncode != 0:
        # Do not copy raw CLI output into exceptions: it can contain secrets.
        raise RuntimeError(
            f"Zhihu CLI failed (exit code {result.returncode}). "
            "Check CLI authorization, configuration, and connectivity."
        )

    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise RuntimeError("Zhihu CLI returned invalid JSON.") from None

    return extract_items(response)