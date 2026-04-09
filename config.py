"""
config.py – Settings for the Storypark Photo Pipeline.

All user-configurable values are stored in ``config.json`` (written by
setup.py or the GUI wizard).  This module reads that file on import and
exposes the settings as module-level constants so existing ``from config
import X`` statements throughout the codebase continue to work unchanged.

The Storypark password is the only secret: it lives in the operating
system's secure keychain, never in any file.  Retrieve it at runtime
with :func:`get_storypark_password`.
"""

from config_manager import load_config as _load_config, KEYRING_SERVICE

# ---------------------------------------------------------------------------
# Load settings from config.json (falls back to built-in defaults)
# ---------------------------------------------------------------------------
_cfg = _load_config()

# ---------------------------------------------------------------------------
# Storypark credentials
# ---------------------------------------------------------------------------
STORYPARK_EMAIL: str = _cfg["storypark_email"]
STORYPARK_KEYRING_SERVICE: str = KEYRING_SERVICE


def get_storypark_password() -> str:
    """
    Return the Storypark password from the OS secure keychain.

    The password is saved there by setup.py using the ``keyring`` library,
    which delegates to the macOS Keychain, Windows Credential Manager, or
    the Linux Secret Service.  It is never written to a plain-text file.

    Raises RuntimeError if the password has not been stored yet.
    """
    try:
        import keyring  # noqa: PLC0415
        pw = keyring.get_password(STORYPARK_KEYRING_SERVICE, STORYPARK_EMAIL)
        if pw:
            return pw
    except Exception as exc:
        raise RuntimeError(
            f"Could not access the system keychain: {exc}\n"
            "Run  python setup.py  to re-enter your Storypark credentials."
        ) from exc
    raise RuntimeError(
        "Storypark password not found in the system keychain.\n"
        "Run  python setup.py  to save your credentials securely."
    )


# ---------------------------------------------------------------------------
# Children
# ---------------------------------------------------------------------------
CHILDREN: list[str] = _cfg["children"]

# ---------------------------------------------------------------------------
# Face encodings file  (built automatically by setup.py)
# ---------------------------------------------------------------------------
REFERENCE_ENCODINGS_FILE: str = _cfg["reference_encodings_file"]

# ---------------------------------------------------------------------------
# Daycare GPS coordinates
# ---------------------------------------------------------------------------
DAYCARE_LATITUDE: float = _cfg["daycare_latitude"]
DAYCARE_LONGITUDE: float = _cfg["daycare_longitude"]

# ---------------------------------------------------------------------------
# Local directories
# ---------------------------------------------------------------------------
TEMP_DIR: str = _cfg["temp_dir"]

# ---------------------------------------------------------------------------
# State management – SQLite database tracking processed images
# ---------------------------------------------------------------------------
STATE_DB_PATH: str = _cfg["state_db_path"]

# ---------------------------------------------------------------------------
# Google Photos OAuth 2.0
# ---------------------------------------------------------------------------
GOOGLE_CREDENTIALS_FILE: str = _cfg["google_credentials_file"]
GOOGLE_TOKEN_FILE: str = _cfg["google_token_file"]

# ---------------------------------------------------------------------------
# Scraper behaviour
# ---------------------------------------------------------------------------
HEADLESS_BROWSER: bool = _cfg["headless_browser"]
MAX_POSTS: int = _cfg["max_posts"]
INCREMENTAL_STOP_THRESHOLD: int = _cfg["incremental_stop_threshold"]
