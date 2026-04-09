"""
scraper.py – Playwright-based Storypark scraper.

Logs in to Storypark, loads the activity feed, and returns a list of
post dicts for every unprocessed photo.

Run modes
---------
First run (empty state DB)
    Scrolls all the way to the very first historical post so that the entire
    photo archive is captured.

Incremental run (state DB already has entries)
    Scrolls from the top (newest posts) and stops automatically once
    INCREMENTAL_STOP_THRESHOLD consecutive posts are all already in the
    state database.  This makes daily catch-up runs fast regardless of how
    many historical posts exist.

Each returned dict contains:
    image_url  – remote URL of the photo
    post_date  – datetime of the Storypark post (None if extraction failed)
    post_url   – URL of the individual post page
    local_path – path to the downloaded image on disk
"""

import os
import re
import logging
import urllib.parse
from pathlib import Path
from datetime import datetime

import requests
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

from config import (
    STORYPARK_EMAIL,
    STORYPARK_PASSWORD,
    TEMP_DIR,
    HEADLESS_BROWSER,
    MAX_POSTS,
    INCREMENTAL_STOP_THRESHOLD,
)

logger = logging.getLogger(__name__)

STORYPARK_URL = "https://app.storypark.com"
LOGIN_URL = f"{STORYPARK_URL}/users/sign_in"
FEED_URL = f"{STORYPARK_URL}/stories"

# Safety valve: stop scrolling after this many consecutive unchanged page
# heights even if the end-of-feed heuristic has not triggered.  500 rounds
# at ~1.5 s each ≈ 12 minutes maximum scroll time per run.
MAX_STALLED_SCROLLS = 500

# CSS selectors – adjust here if Storypark changes its HTML structure
SELECTORS = {
    "email_input": (
        'input[type="email"], input[name="user[email]"], input[id="user_email"]'
    ),
    "password_input": (
        'input[type="password"], input[name="user[password]"], '
        'input[id="user_password"]'
    ),
    "submit_button": 'button[type="submit"], input[type="submit"]',
    "post_container": (
        "article, [class*='story'], [class*='post'], [class*='activity']"
    ),
    "post_image": (
        "img[src*='storypark'], img[src*='amazonaws'], img[src*='cloudfront']"
    ),
    "post_date": "time[datetime], [class*='date'], [class*='time']",
    "load_more": (
        "[class*='load-more'], button:has-text('Load more'), "
        "button:has-text('Show more')"
    ),
}

# JavaScript snippet used during incremental scroll to check known posts.
# Returns a flat list of image src values from the last N post elements.
_JS_BOTTOM_IMAGE_URLS = """
(n) => {
    const containers = document.querySelectorAll(
        "article, [class*='story'], [class*='post'], [class*='activity']"
    );
    const last = Array.from(containers).slice(-n);
    return last.flatMap(el =>
        Array.from(el.querySelectorAll("img"))
            .map(img => img.src)
            .filter(src => src.includes('storypark') ||
                           src.includes('amazonaws') ||
                           src.includes('cloudfront'))
    );
}
"""


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe_filename(url: str) -> str:
    """Derive a filesystem-safe filename from an image URL."""
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    name = re.sub(r"[?&=].*$", "", name)
    if not name.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
        name += ".jpg"
    return name


def _download_image(image_url: str, dest_dir: str) -> str | None:
    """Download *image_url* into *dest_dir* and return the local file path."""
    filename = _safe_filename(image_url)
    local_path = os.path.join(dest_dir, filename)
    if os.path.exists(local_path):
        return local_path
    try:
        response = requests.get(image_url, timeout=30)
        response.raise_for_status()
        with open(local_path, "wb") as fh:
            fh.write(response.content)
        logger.debug("Downloaded: %s → %s", image_url, local_path)
        return local_path
    except requests.RequestException as exc:
        logger.warning("Failed to download %s: %s", image_url, exc)
        return None


def _parse_date(raw: str) -> datetime | None:
    """
    Parse a date string from the Storypark page into a datetime object.

    Storypark uses ISO-8601 in <time datetime="…"> attributes.
    Returns None if the string cannot be parsed (rather than falling back
    to the current time, which would produce incorrect EXIF timestamps).
    """
    formats = [
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ]
    clean = raw.strip()
    for fmt in formats:
        try:
            dt = datetime.strptime(clean, fmt)
            # Strip timezone info so piexif can format it cleanly
            return dt.replace(tzinfo=None)
        except ValueError:
            continue
    logger.warning("Could not parse date string: %r", raw)
    return None


def _is_incremental_run(state_conn) -> bool:
    """Return True if the state DB already contains processed images."""
    count = state_conn.execute(
        "SELECT COUNT(*) FROM processed_images"
    ).fetchone()[0]
    return count > 0


def _all_images_known(state_conn, image_urls: list[str]) -> bool:
    """Return True if every URL in *image_urls* is already in the state DB."""
    if not image_urls:
        return False
    return all(
        state_conn.execute(
            "SELECT 1 FROM processed_images WHERE image_url = ?", (url,)
        ).fetchone() is not None
        for url in image_urls
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def scrape(state_conn) -> list[dict]:
    """
    Scrape the Storypark feed and return new unprocessed post dicts.

    Performs a full historical scroll on first run, or a fast incremental
    scroll that stops at already-processed posts on subsequent runs.
    """
    from state_manager import is_processed

    Path(TEMP_DIR).mkdir(parents=True, exist_ok=True)
    results: list[dict] = []
    incremental = _is_incremental_run(state_conn)

    if incremental:
        logger.info(
            "Incremental run – will stop after %d consecutive known posts.",
            INCREMENTAL_STOP_THRESHOLD,
        )
    else:
        logger.info("First run – scrolling to the very first historical post…")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=HEADLESS_BROWSER)
        context = browser.new_context()
        page = context.new_page()

        # ------------------------------------------------------------------
        # 1. Log in
        # ------------------------------------------------------------------
        logger.info("Navigating to Storypark login page…")
        page.goto(LOGIN_URL, wait_until="networkidle")

        page.fill(SELECTORS["email_input"], STORYPARK_EMAIL)
        page.fill(SELECTORS["password_input"], STORYPARK_PASSWORD)
        page.click(SELECTORS["submit_button"])

        try:
            page.wait_for_url(
                re.compile(r"/stories|/dashboard|/home"), timeout=15_000
            )
            logger.info("Login successful.")
        except PlaywrightTimeout:
            logger.error(
                "Login did not redirect as expected.  "
                "Check your Storypark credentials in config.py."
            )
            browser.close()
            return results

        # ------------------------------------------------------------------
        # 2. Scroll the feed
        # ------------------------------------------------------------------
        page.goto(FEED_URL, wait_until="domcontentloaded")

        previous_height = -1
        stalled_scrolls = 0           # unchanged page height counter
        consecutive_known_batches = 0  # incremental early-stop counter

        while stalled_scrolls < MAX_STALLED_SCROLLS:
            # Try clicking a "Load more" button first
            try:
                load_more = page.locator(SELECTORS["load_more"]).first
                if load_more.is_visible(timeout=2_000):
                    load_more.click()
                    page.wait_for_load_state("networkidle", timeout=10_000)
                    stalled_scrolls = 0
                    continue
            except PlaywrightTimeout:
                pass

            # Scroll down
            current_height = page.evaluate("document.body.scrollHeight")
            if current_height == previous_height:
                stalled_scrolls += 1
            else:
                stalled_scrolls = 0
            previous_height = current_height
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1_500)

            # For incremental runs: check if the bottom posts are all known
            if incremental:
                try:
                    bottom_urls: list[str] = page.evaluate(
                        _JS_BOTTOM_IMAGE_URLS, INCREMENTAL_STOP_THRESHOLD
                    )
                    if bottom_urls and _all_images_known(state_conn, bottom_urls):
                        consecutive_known_batches += 1
                        logger.debug(
                            "Bottom posts all known (%d/%d).",
                            consecutive_known_batches,
                            2,
                        )
                        if consecutive_known_batches >= 2:
                            logger.info(
                                "Reached already-processed posts – stopping scroll."
                            )
                            break
                    else:
                        consecutive_known_batches = 0
                except Exception:
                    pass  # JS evaluation failures are non-fatal

            if stalled_scrolls >= 5:
                logger.info("Reached the end of the feed.")
                break

        # ------------------------------------------------------------------
        # 3. Collect posts (newest → oldest; stop early in incremental mode)
        # ------------------------------------------------------------------
        posts = page.locator(SELECTORS["post_container"]).all()
        logger.info("Found %d post element(s) in the DOM.", len(posts))

        processed_count = 0
        consecutive_all_known = 0  # post-level early stop for incremental

        for post in posts:
            if MAX_POSTS and processed_count >= MAX_POSTS:
                break

            # ----------------------------------------------------------
            # Extract post URL
            # ----------------------------------------------------------
            post_url = ""
            try:
                anchor = post.locator("a").first
                href = anchor.get_attribute("href") or ""
                post_url = (
                    href if href.startswith("http") else STORYPARK_URL + href
                )
            except Exception:
                pass

            # ----------------------------------------------------------
            # Extract post date – try <time datetime="…"> first, then
            # visible text, then data-* attributes.
            # ----------------------------------------------------------
            post_date: datetime | None = None
            try:
                time_el = post.locator("time").first
                raw = (
                    time_el.get_attribute("datetime")
                    or time_el.get_attribute("data-date")
                    or time_el.inner_text()
                )
                if raw:
                    post_date = _parse_date(raw)
            except Exception:
                pass

            if post_date is None:
                # Fallback: look for any element with a date-like class
                try:
                    date_el = post.locator(SELECTORS["post_date"]).first
                    raw = (
                        date_el.get_attribute("datetime")
                        or date_el.get_attribute("data-date")
                        or date_el.inner_text()
                    )
                    if raw:
                        post_date = _parse_date(raw)
                except Exception:
                    pass

            # ----------------------------------------------------------
            # Collect images in this post
            # ----------------------------------------------------------
            images = post.locator(SELECTORS["post_image"]).all()
            image_urls = [
                img.get_attribute("src") or ""
                for img in images
            ]
            image_urls = [u for u in image_urls if u]

            # Check if all images in this post are already known
            if image_urls and all(
                is_processed(state_conn, u) for u in image_urls
            ):
                if incremental:
                    consecutive_all_known += 1
                    if consecutive_all_known >= INCREMENTAL_STOP_THRESHOLD:
                        logger.info(
                            "Hit %d consecutive already-processed posts – "
                            "stopping collection.",
                            INCREMENTAL_STOP_THRESHOLD,
                        )
                        break
                continue  # skip – nothing new here
            else:
                consecutive_all_known = 0

            # Download new images
            for image_url in image_urls:
                if is_processed(state_conn, image_url):
                    logger.debug("Already processed, skipping: %s", image_url)
                    continue

                local_path = _download_image(image_url, TEMP_DIR)
                if local_path:
                    results.append(
                        {
                            "image_url": image_url,
                            "post_date": post_date,
                            "post_url": post_url,
                            "local_path": local_path,
                        }
                    )
                    processed_count += 1

        browser.close()

    logger.info("Scraper finished – %d new image(s) collected.", len(results))
    return results
