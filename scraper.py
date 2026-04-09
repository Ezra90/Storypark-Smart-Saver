"""
scraper.py – Playwright-based Storypark scraper.

Logs in to Storypark, scrolls the activity feed to the very first post, and
yields a stream of (image_url, post_date, post_url) tuples for every photo
found.  Images are downloaded to TEMP_DIR.
"""

import os
import re
import time
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
)

logger = logging.getLogger(__name__)

STORYPARK_URL = "https://app.storypark.com"
LOGIN_URL = f"{STORYPARK_URL}/users/sign_in"
FEED_URL = f"{STORYPARK_URL}/stories"

# CSS selectors – adjust if Storypark changes its HTML structure
SELECTORS = {
    "email_input": 'input[type="email"], input[name="user[email]"], input[id="user_email"]',
    "password_input": 'input[type="password"], input[name="user[password]"], input[id="user_password"]',
    "submit_button": 'button[type="submit"], input[type="submit"]',
    "post_container": "article, [class*='story'], [class*='post'], [class*='activity']",
    "post_image": "img[src*='storypark'], img[src*='amazonaws'], img[src*='cloudfront']",
    "post_date": "time[datetime], [class*='date'], [class*='time']",
    "load_more": "[class*='load-more'], button:has-text('Load more'), button:has-text('Show more')",
}


def _safe_filename(url: str) -> str:
    """Derive a filesystem-safe filename from an image URL."""
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    # Strip query-string remnants
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
    Try to parse a date string extracted from the page into a datetime object.
    Storypark typically uses ISO-8601 in <time datetime="…"> attributes.
    """
    formats = [
        "%Y-%m-%dT%H:%M:%S.%fZ",
        "%Y-%m-%dT%H:%M:%SZ",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d",
    ]
    for fmt in formats:
        try:
            return datetime.strptime(raw.strip(), fmt)
        except ValueError:
            continue
    logger.warning("Could not parse date string: %r", raw)
    return None


def scrape(state_conn) -> list[dict]:
    """
    Scrape the Storypark feed and return a list of post dictionaries.

    Each dict contains:
        image_url  – remote URL of the photo
        post_date  – datetime of the post (or None)
        post_url   – URL of the individual post page
        local_path – path to the downloaded image file
    """
    from state_manager import is_processed, mark_processed

    Path(TEMP_DIR).mkdir(parents=True, exist_ok=True)
    results: list[dict] = []

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
            page.wait_for_url(re.compile(r"/stories|/dashboard|/home"), timeout=15_000)
            logger.info("Login successful.")
        except PlaywrightTimeout:
            logger.error(
                "Login did not redirect as expected. "
                "Check your credentials or the page selectors in SELECTORS."
            )
            browser.close()
            return results

        # ------------------------------------------------------------------
        # 2. Scroll to the bottom of the feed
        # ------------------------------------------------------------------
        logger.info("Loading the full activity feed – this may take a while…")
        page.goto(FEED_URL, wait_until="domcontentloaded")

        previous_height = -1
        scroll_attempts = 0
        max_scroll_attempts = 500  # safety valve

        while scroll_attempts < max_scroll_attempts:
            # Try clicking a "Load more" button first
            try:
                load_more = page.locator(SELECTORS["load_more"]).first
                if load_more.is_visible(timeout=2_000):
                    load_more.click()
                    page.wait_for_load_state("networkidle", timeout=10_000)
                    scroll_attempts = 0  # reset after successful load
                    continue
            except PlaywrightTimeout:
                pass

            # Scroll to the very bottom
            current_height = page.evaluate("document.body.scrollHeight")
            if current_height == previous_height:
                scroll_attempts += 1
            else:
                scroll_attempts = 0
            previous_height = current_height
            page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
            page.wait_for_timeout(1_500)

            if scroll_attempts >= 5:
                logger.info("Reached the end of the feed.")
                break

        # ------------------------------------------------------------------
        # 3. Collect all posts
        # ------------------------------------------------------------------
        posts = page.locator(SELECTORS["post_container"]).all()
        logger.info("Found %d post elements.", len(posts))

        processed_count = 0
        for post in posts:
            if MAX_POSTS and processed_count >= MAX_POSTS:
                break

            # Extract post URL (try the first anchor inside the post)
            post_url = ""
            try:
                anchor = post.locator("a").first
                href = anchor.get_attribute("href") or ""
                post_url = href if href.startswith("http") else STORYPARK_URL + href
            except Exception:
                pass

            # Extract date
            post_date: datetime | None = None
            try:
                time_el = post.locator(SELECTORS["post_date"]).first
                raw_date = time_el.get_attribute("datetime") or time_el.inner_text()
                post_date = _parse_date(raw_date)
            except Exception:
                pass

            # Extract all images in this post
            images = post.locator(SELECTORS["post_image"]).all()
            for img in images:
                image_url = img.get_attribute("src") or ""
                if not image_url:
                    continue

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

    logger.info("Scraper finished – %d new images collected.", len(results))
    return results
