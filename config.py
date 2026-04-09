"""
config.py – User-configurable settings for the Storypark scraper pipeline.

Edit the values in this file before running main.py.
"""

# ---------------------------------------------------------------------------
# Storypark credentials
# ---------------------------------------------------------------------------
STORYPARK_EMAIL = "your_email@example.com"
STORYPARK_PASSWORD = "your_password"

# ---------------------------------------------------------------------------
# Facial recognition – reference image
# ---------------------------------------------------------------------------
# Path to a clear, front-facing headshot of the child you want to match.
# Example: "reference/hugo.jpg"
REFERENCE_IMAGE_PATH = "reference/hugo.jpg"

# ---------------------------------------------------------------------------
# Daycare GPS coordinates
# Obtain from Google Maps: right-click the location → "What's here?"
# ---------------------------------------------------------------------------
DAYCARE_LATITUDE = -33.8688   # Replace with actual latitude  (e.g. -33.8688)
DAYCARE_LONGITUDE = 151.2093  # Replace with actual longitude (e.g. 151.2093)

# ---------------------------------------------------------------------------
# Local directories
# ---------------------------------------------------------------------------
# Temporary directory for downloaded images (created automatically)
TEMP_DIR = "tmp_photos"

# ---------------------------------------------------------------------------
# State management
# ---------------------------------------------------------------------------
# SQLite database file used to track already-processed posts
STATE_DB_PATH = "processed_posts.db"

# ---------------------------------------------------------------------------
# Google Photos OAuth 2.0
# ---------------------------------------------------------------------------
# Path to the client_secret JSON file downloaded from Google Cloud Console.
# See README.md for instructions on creating these credentials.
GOOGLE_CREDENTIALS_FILE = "client_secret.json"

# Path where the OAuth token will be cached after the first login.
GOOGLE_TOKEN_FILE = "token.json"

# ---------------------------------------------------------------------------
# Scraper behaviour
# ---------------------------------------------------------------------------
# Set to True to run the browser in headless mode (no visible window).
HEADLESS_BROWSER = False

# Maximum number of posts to process in a single run (0 = unlimited).
# Useful for testing before processing the entire historical feed.
MAX_POSTS = 0
