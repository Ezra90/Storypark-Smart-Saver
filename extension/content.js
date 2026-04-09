/**
 * content.js – Storypark Feed Scraper (Content Script)
 *
 * Injected into https://app.storypark.com/* pages. On receiving a
 * "SCRAPE_FEED" message from the background service worker, it:
 *   1. Scrolls the activity feed to load posts.
 *   2. Extracts image URLs and post dates from the DOM.
 *   3. Returns the scraped data back to the service worker.
 *
 * Communication is via chrome.runtime.sendMessage / onMessage.
 */

(() => {
  /* ---------- Constants ---------- */

  const SELECTORS = {
    postContainer:
      "article, [class*='story'], [class*='post'], [class*='activity']",
    postImage:
      "img[src*='storypark'], img[src*='amazonaws'], img[src*='cloudfront']",
    postDate: "time[datetime], [class*='date'], [class*='time']",
    loadMore: "[class*='load-more'], button",
  };

  const SCROLL_DELAY_MIN = 1500;
  const SCROLL_DELAY_MAX = 3500;
  const MAX_STALLED_SCROLLS = 500;
  const INCREMENTAL_STOP = 5;

  /* ---------- Helpers ---------- */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function randomDelay() {
    return (
      Math.floor(Math.random() * (SCROLL_DELAY_MAX - SCROLL_DELAY_MIN + 1)) +
      SCROLL_DELAY_MIN
    );
  }

  function parseDate(raw) {
    if (!raw) return null;
    const d = new Date(raw.trim());
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  /**
   * Try to extract a date from a post container element.
   * Cascades through several strategies matching the Python scraper.
   */
  function extractDate(container) {
    // Strategy 1: <time datetime="...">
    const timeEl = container.querySelector("time[datetime]");
    if (timeEl) {
      const d = parseDate(timeEl.getAttribute("datetime"));
      if (d) return d;
    }

    // Strategy 2: date/time class text content
    for (const sel of ["[class*='date']", "[class*='time']"]) {
      const el = container.querySelector(sel);
      if (el) {
        const d = parseDate(el.textContent);
        if (d) return d;
      }
    }

    // Strategy 3: data attributes
    for (const attr of ["data-date", "data-time", "data-timestamp"]) {
      const el = container.querySelector(`[${attr}]`);
      if (el) {
        const d = parseDate(el.getAttribute(attr));
        if (d) return d;
      }
    }

    return null;
  }

  /**
   * Extract all image URLs from a post container.
   */
  function extractImages(container) {
    const urls = new Set();
    const imgs = container.querySelectorAll(SELECTORS.postImage);
    for (const img of imgs) {
      const src = img.src || img.dataset.src;
      if (src && src.startsWith("http")) {
        urls.add(src);
      }
    }
    return [...urls];
  }

  /**
   * Extract post URL from a container (first anchor href).
   */
  function extractPostUrl(container) {
    const a = container.querySelector("a[href]");
    return a ? a.href : "";
  }

  /* ---------- Scrolling ---------- */

  /**
   * Try to click a "Load more" button; returns true if clicked.
   */
  function tryLoadMore() {
    const buttons = document.querySelectorAll(SELECTORS.loadMore);
    for (const btn of buttons) {
      const text = btn.textContent.toLowerCase();
      if (text.includes("load more") || text.includes("show more")) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  /**
   * Scroll the feed, extract posts, and return structured data.
   *
   * @param {Set<string>} knownUrls – URLs already processed (for incremental mode).
   * @param {Function} sendProgress – Callback to report progress.
   * @returns {Promise<Array>} – Array of { imageUrl, postDate, postUrl } objects.
   */
  async function scrollAndExtract(knownUrls, sendProgress) {
    const results = [];
    const seenUrls = new Set();
    let stalledCount = 0;
    let consecutiveKnown = 0;
    let lastHeight = 0;

    sendProgress("Starting feed scan…");

    for (let scroll = 0; scroll < MAX_STALLED_SCROLLS; scroll++) {
      // Try pagination button first, else scroll
      if (!tryLoadMore()) {
        window.scrollTo(0, document.body.scrollHeight);
      }

      await sleep(randomDelay());

      // Check if page grew
      const currentHeight = document.body.scrollHeight;
      if (currentHeight === lastHeight) {
        stalledCount++;
        if (stalledCount >= 5) {
          sendProgress("Reached end of feed.");
          break;
        }
      } else {
        stalledCount = 0;
      }
      lastHeight = currentHeight;

      // Extract from all visible post containers
      const containers = document.querySelectorAll(SELECTORS.postContainer);
      let batchNewCount = 0;

      for (const container of containers) {
        const imageUrls = extractImages(container);
        if (imageUrls.length === 0) continue;

        const postDate = extractDate(container);
        const postUrl = extractPostUrl(container);

        for (const imageUrl of imageUrls) {
          if (seenUrls.has(imageUrl)) continue;
          seenUrls.add(imageUrl);

          if (knownUrls.has(imageUrl)) {
            consecutiveKnown++;
            if (consecutiveKnown >= INCREMENTAL_STOP) {
              sendProgress(
                `Found ${INCREMENTAL_STOP} consecutive known images – stopping incremental scan.`
              );
              return results;
            }
            continue;
          }

          consecutiveKnown = 0;
          batchNewCount++;

          results.push({ imageUrl, postDate, postUrl });
        }
      }

      if (batchNewCount > 0) {
        sendProgress(`Found ${results.length} new images so far…`);
      }
    }

    sendProgress(`Feed scan complete. ${results.length} new images found.`);
    return results;
  }

  /* ---------- Message listener ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "SCRAPE_FEED") return false;

    const knownUrls = new Set(msg.knownUrls || []);
    const sendProgress = (text) => {
      try {
        chrome.runtime.sendMessage({ type: "LOG", message: `[scraper] ${text}` });
      } catch {
        /* popup may not be open */
      }
    };

    scrollAndExtract(knownUrls, sendProgress)
      .then((posts) => sendResponse({ ok: true, posts }))
      .catch((err) =>
        sendResponse({ ok: false, error: err.message || String(err) })
      );

    return true; // keep the message channel open for async response
  });
})();
