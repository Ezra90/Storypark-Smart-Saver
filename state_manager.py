"""
state_manager.py – SQLite-based state tracking for the Storypark scraper.

Keeps a record of every image URL that has been successfully processed so
that the pipeline can be safely interrupted and restarted without
re-downloading or re-uploading the same photos.
"""

import sqlite3
import logging
from config import STATE_DB_PATH

logger = logging.getLogger(__name__)


def init_db() -> sqlite3.Connection:
    """Open (or create) the SQLite database and ensure the schema exists."""
    conn = sqlite3.connect(STATE_DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS processed_images (
            image_url  TEXT PRIMARY KEY,
            post_url   TEXT,
            processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.commit()
    logger.info("State database ready: %s", STATE_DB_PATH)
    return conn


def is_processed(conn: sqlite3.Connection, image_url: str) -> bool:
    """Return True if *image_url* has already been processed."""
    row = conn.execute(
        "SELECT 1 FROM processed_images WHERE image_url = ?", (image_url,)
    ).fetchone()
    return row is not None


def mark_processed(conn: sqlite3.Connection, image_url: str, post_url: str = "") -> None:
    """Record *image_url* as processed so it is skipped on future runs."""
    conn.execute(
        "INSERT OR IGNORE INTO processed_images (image_url, post_url) VALUES (?, ?)",
        (image_url, post_url),
    )
    conn.commit()
    logger.debug("Marked as processed: %s", image_url)
