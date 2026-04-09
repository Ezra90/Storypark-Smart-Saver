"""
main.py – Orchestrator for the Storypark photo pipeline.

Run with:
    python main.py

Pipeline steps
--------------
1. Initialise the SQLite state database.
2. Scrape Storypark and download new photos to TEMP_DIR.
3. Filter photos using facial recognition (delete non-matches).
4. Rewrite EXIF metadata (date + GPS) on matching photos.
5. Upload matching photos to Google Photos.
6. Clean up any remaining temporary files.
"""

import logging
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging configuration – set up before importing project modules
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s – %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("pipeline.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Project modules
# ---------------------------------------------------------------------------
import state_manager
import scraper
import face_filter
import exif_modifier
import uploader
from config import TEMP_DIR


def cleanup_temp_dir() -> None:
    """Remove any leftover files in the temporary directory."""
    tmp = Path(TEMP_DIR)
    if not tmp.exists():
        return
    removed = 0
    for f in tmp.iterdir():
        if f.is_file():
            f.unlink()
            removed += 1
    if removed:
        logger.info("Cleaned up %d leftover file(s) from %s.", removed, TEMP_DIR)


def main() -> None:
    logger.info("=" * 60)
    logger.info("Storypark Photo Pipeline – starting")
    logger.info("=" * 60)

    # ------------------------------------------------------------------
    # Step 1 – State database
    # ------------------------------------------------------------------
    conn = state_manager.init_db()

    # ------------------------------------------------------------------
    # Step 2 – Scrape & download
    # ------------------------------------------------------------------
    logger.info("STEP 1/4 – Scraping Storypark…")
    posts = scraper.scrape(conn)

    if not posts:
        logger.info("No new photos found. Exiting.")
        conn.close()
        return

    logger.info("Downloaded %d new image(s).", len(posts))

    # ------------------------------------------------------------------
    # Step 3 – Facial recognition filter
    # ------------------------------------------------------------------
    logger.info("STEP 2/4 – Filtering photos by face recognition…")
    posts = face_filter.filter_photos(posts)

    if not posts:
        logger.info("No photos matched the reference face. Exiting.")
        conn.close()
        return

    logger.info("%d photo(s) matched.", len(posts))

    # ------------------------------------------------------------------
    # Step 4 – EXIF metadata
    # ------------------------------------------------------------------
    logger.info("STEP 3/4 – Writing EXIF metadata…")
    posts = exif_modifier.apply_exif(posts)

    # ------------------------------------------------------------------
    # Step 5 – Google Photos upload
    # ------------------------------------------------------------------
    logger.info("STEP 4/4 – Uploading to Google Photos…")
    uploaded = uploader.upload_photos(posts, conn)

    logger.info(
        "Pipeline complete: %d photo(s) uploaded to Google Photos.", len(uploaded)
    )

    # ------------------------------------------------------------------
    # Step 6 – Cleanup
    # ------------------------------------------------------------------
    cleanup_temp_dir()
    conn.close()

    logger.info("=" * 60)
    logger.info("All done!")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
