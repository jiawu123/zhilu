"""Offline defaults: ordinary pytest must never load personal credentials."""
import os

# Set before test collection, also inherited by test-only Python children.
# Dotenv tests explicitly replace ENV_FILE with their own temporary fixtures.
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
# Override inherited user settings before collection and test-only child spawns.
# Explicit profile tests may still monkeypatch this per test.
os.environ["ZHIHU_RETRIEVAL_PROFILE"] = "legacy"
for _credential in ("DEEPSEEK_API_KEY", "ZHIHU_ACCESS_SECRET"):
    os.environ.pop(_credential, None)
