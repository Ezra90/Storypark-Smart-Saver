"""
config_manager.py – JSON-based configuration for the Storypark Photo Pipeline.

All persistent settings are stored in config.json.  The Storypark password
is the only credential that lives outside this file – it is kept in the
operating-system keychain via the ``keyring`` library.

Other modules should **not** import from this file directly.  Instead,
use the constants exposed by ``config.py``, which reads config.json on
import and provides the same public names the rest of the codebase expects.
"""

import json
import logging
from pathlib import Path

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

APP_DIR = Path(__file__).resolve().parent
CONFIG_PATH = APP_DIR / "config.json"

# ---------------------------------------------------------------------------
# Defaults – used when config.json does not exist or is missing keys
# ---------------------------------------------------------------------------

DEFAULTS: dict = {
    "storypark_email": "",
    "children": [],
    "reference_encodings_file": "face_encodings.pkl",
    "daycare_latitude": 0.0,
    "daycare_longitude": 0.0,
    "temp_dir": "tmp_photos",
    "state_db_path": "processed_posts.db",
    "google_credentials_file": "client_secret.json",
    "google_token_file": "token.json",
    "headless_browser": True,
    "max_posts": 0,
    "incremental_stop_threshold": 5,
}

# The keyring service name is a constant – never stored in JSON.
KEYRING_SERVICE = "storypark-scraper"


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------

def load_config() -> dict:
    """
    Read ``config.json`` and return a dict of settings.

    Missing keys are filled in from :data:`DEFAULTS` so callers always get
    a complete configuration dict even if the file was written by an older
    version of the app.
    """
    cfg = dict(DEFAULTS)
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as fh:
                stored = json.load(fh)
            cfg.update(stored)
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning("Could not read %s: %s – using defaults.", CONFIG_PATH, exc)
    return cfg


def save_config(data: dict) -> None:
    """
    Write *data* to ``config.json``.

    Only JSON-serialisable, non-secret settings should be included.
    The Storypark password must **not** appear here – it belongs in the
    OS keychain.
    """
    with open(CONFIG_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    logger.info("Configuration saved to %s", CONFIG_PATH)
