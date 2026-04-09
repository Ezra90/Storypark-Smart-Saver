"""
main.py – Orchestrator for the Storypark Photo Pipeline.

Quick start
-----------
1. Run setup once:   python setup.py
2. Then run anytime: python main.py

What happens on each run
------------------------
First run (full historical backfill)
    • Logs in to Storypark and scrolls all the way to the very first post.
    • Downloads every photo that has not been processed before.
    • Filters for photos containing the configured children (face recognition).
    • Stamps EXIF with the original Storypark upload date and daycare GPS.
    • Uploads matches to Google Photos and removes local copies.
    • Records every processed image URL in a local SQLite database.

Subsequent runs (incremental catch-up)
    • Same pipeline, but the scraper stops scrolling automatically once it
      reaches posts already in the state database – making daily runs fast.

Pipeline steps
--------------
1. Verify setup has been completed (face_encodings.pkl exists).
2. Initialise the SQLite state database.
3. Scrape Storypark and download new photos to TEMP_DIR.
4. Filter photos using facial recognition (delete non-matches).
5. Rewrite EXIF: DateTimeOriginal = Storypark upload date; GPS = daycare.
6. Upload to Google Photos; delete local copies on success.
7. Clean up any leftover temporary files.
"""

import logging
import os
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Logging – configure before importing project modules
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
from config import TEMP_DIR, REFERENCE_ENCODINGS_FILE, CHILDREN


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _check_setup() -> None:
    """
    Abort with a clear message if setup.py has not been run yet.

    We check for:
      • face_encodings.pkl  – built by setup.py from Google Photos samples
      • At least one child configured in config.CHILDREN
    """
    if not os.path.exists(REFERENCE_ENCODINGS_FILE):
        logger.error(
            "Face encodings file not found: %s\n"
            "Run  python setup.py  first to configure the pipeline.",
            REFERENCE_ENCODINGS_FILE,
        )
        sys.exit(1)

    if not CHILDREN:
        logger.error(
            "No children configured in config.py.\n"
            "Run  python setup.py  to set up the pipeline interactively."
        )
        sys.exit(1)


def _cleanup_temp_dir() -> None:
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
        logger.info(
            "Cleaned up %d leftover file(s) from %s.", removed, TEMP_DIR
        )


def _summarise(uploaded: list[dict]) -> None:
    """Log a per-child upload summary."""
    if not uploaded:
        return
    tally: dict[str, int] = {}
    for post in uploaded:
        for name in post.get("matched_children", ["unknown"]):
            tally[name] = tally.get(name, 0) + 1
    logger.info("Upload summary by child:")
    for name, count in sorted(tally.items()):
        logger.info("  %-20s %d photo(s)", name, count)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    logger.info("=" * 60)
    logger.info("Storypark Photo Pipeline – starting")
    logger.info("Children: %s", ", ".join(CHILDREN) if CHILDREN else "(none)")
    logger.info("=" * 60)

    # ------------------------------------------------------------------
    # Pre-flight check
    # ------------------------------------------------------------------
    _check_setup()

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
        logger.info("No new photos found. Nothing to do.")
        conn.close()
        return

    logger.info("Downloaded %d new image(s).", len(posts))

    # ------------------------------------------------------------------
    # Step 3 – Facial recognition filter
    # ------------------------------------------------------------------
    logger.info("STEP 2/4 – Filtering photos by face recognition…")
    posts = face_filter.filter_photos(posts)

    if not posts:
        logger.info("No photos matched any of the configured children.")
        conn.close()
        _cleanup_temp_dir()
        return

    logger.info("%d photo(s) matched.", len(posts))

    # ------------------------------------------------------------------
    # Step 4 – EXIF metadata
    # Stamps each photo with the Storypark upload date and daycare GPS.
    # ------------------------------------------------------------------
    logger.info("STEP 3/4 – Writing EXIF metadata (date + GPS)…")
    posts = exif_modifier.apply_exif(posts)

    # ------------------------------------------------------------------
    # Step 5 – Google Photos upload
    # ------------------------------------------------------------------
    logger.info("STEP 4/4 – Uploading to Google Photos…")
    uploaded = uploader.upload_photos(posts, conn)

    logger.info(
        "Pipeline complete: %d photo(s) uploaded to Google Photos.",
        len(uploaded),
    )
    _summarise(uploaded)

    # ------------------------------------------------------------------
    # Cleanup
    # ------------------------------------------------------------------
    _cleanup_temp_dir()
    conn.close()

    logger.info("=" * 60)
    logger.info("All done!")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
