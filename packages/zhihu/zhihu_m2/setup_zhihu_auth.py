"""Optional, explicit .env -> local Zhihu CLI credential setup.

Not imported or invoked by search_zhihu. Run this module yourself only when
configuring/changing local authorization. This may replace the CLI's saved
Access Secret. Local CLI help must advertise --secret-stdin before any write.
No claim is made that all CLI versions support environment-based auth.
"""
import os
import subprocess

from zhihu_m2.config import load_local_env
from zhihu_m2.zhihu_client import get_cli_path


def configure_auth_from_env() -> None:
    """Pass Access Secret via stdin if the installed CLI supports that option.

    Never print the secret, put it in argv, or expose raw CLI stdout/stderr.
    A zero exit code is not an independent verification of API access.
    """
    load_local_env()
    secret = os.environ.get("ZHIHU_ACCESS_SECRET", "").strip()
    if not secret:
        raise RuntimeError(
            "Set ZHIHU_ACCESS_SECRET in the environment or packages/zhihu/.env. "
            "Use Access Secret, not an OAuth App Key or an entire Bearer header."
        )
    if "\n" in secret or "\r" in secret:
        raise RuntimeError("ZHIHU_ACCESS_SECRET must be a single line.")

    cli = str(get_cli_path())
    options = {"capture_output": True, "text": True, "encoding": "utf-8", "timeout": 60}
    try:
        help_result = subprocess.run([cli, "auth", "set", "--help"], **options)
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError("Could not check the installed Zhihu CLI auth options.") from None
    help_text = (help_result.stdout or "") + (help_result.stderr or "")
    if help_result.returncode != 0 or "--secret-stdin" not in help_text:
        raise RuntimeError(
            "This CLI did not advertise --secret-stdin; no credential was written. "
            "Use your installed official Skill's supported authorization procedure."
        )

    try:
        result = subprocess.run(
            [cli, "auth", "set", "--secret-stdin"],
            input=secret + "\n",
            **options,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise RuntimeError(
            "CLI credential setup did not finish normally. Check auth status "
            "before retrying; the credential might already have changed."
        ) from None
    if result.returncode != 0:
        raise RuntimeError(
            "CLI credential setup returned an error. Check auth status "
            "and the installed official Skill; raw output was withheld."
        )


def main() -> None:
    """Explicit manual operation; may change locally stored CLI authorization."""
    try:
        configure_auth_from_env()
    except RuntimeError as error:
        raise SystemExit(f"ERROR: {error}") from None
    print("The CLI accepted the setup command. Run auth status to check authorization.")


if __name__ == "__main__":
    main()
