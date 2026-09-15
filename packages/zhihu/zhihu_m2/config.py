"""Load package-local configuration without import-time side effects."""

import os
from pathlib import Path

from dotenv import load_dotenv


# config.py 位于 packages/zhihu/zhihu_m2/
# parents[1] 指向 packages/zhihu/
PACKAGE_ROOT = Path(__file__).resolve().parents[1]

# 固定读取 packages/zhihu/.env，不向上搜索其他 .env。
ENV_FILE = PACKAGE_ROOT / ".env"


def load_local_env() -> bool:
    """Load local .env without overwriting existing environment variables.

    Importing this module does not load credentials or call any service.
    Set PYTHON_DOTENV_DISABLED=1 to skip file loading during offline tests.
    """
    disabled = os.environ.get(
        "PYTHON_DOTENV_DISABLED", ""
    ).strip().lower()

    if disabled in {"1", "true", "yes", "on"}:
        return False

    return load_dotenv(
        dotenv_path=ENV_FILE,
        override=False,
        encoding="utf-8-sig",
        interpolate=False,
    )