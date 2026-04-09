"""
config.py – Settings for the Storypark Photo Pipeline.

The easiest way to configure this file is to run setup.py, which fills in
all values interactively.  You can also edit the values here directly if
you prefer.

NOTE: The Storypark password is NOT stored here.  It is saved in the
operating system's secure keychain by setup.py and retrieved at runtime
via the get_storypark_password() function below.
"""

# ---------------------------------------------------------------------------
# Storypark credentials
# ---------------------------------------------------------------------------
# Filled in by the setup wizard (setup.py or the GUI Settings button).
# Do not edit STORYPARK_EMAIL by hand unless you also update the keychain
# entry – run the setup wizard instead.
STORYPARK_EMAIL = ""
# Password is stored in the OS keychain – call get_storypark_password()
STORYPARK_KEYRING_SERVICE = "storypark-scraper"


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
# Names must match those entered during setup.py.
# Face encodings are stored in REFERENCE_ENCODINGS_FILE.
# ---------------------------------------------------------------------------
CHILDREN: list[str] = []

# ---------------------------------------------------------------------------
# Face encodings file  (built automatically by setup.py)
# ---------------------------------------------------------------------------
REFERENCE_ENCODINGS_FILE = "face_encodings.pkl"

# ---------------------------------------------------------------------------
# Daycare GPS coordinates
# These are written into the EXIF of every matched photo so it appears
# at the daycare location in Google Photos / Apple Photos timelines.
# Obtain from Google Maps: right-click the location → "What's here?"
# ---------------------------------------------------------------------------
DAYCARE_LATITUDE = 0.0    # e.g. -33.8688
DAYCARE_LONGITUDE = 0.0   # e.g. 151.2093

# ---------------------------------------------------------------------------
# Local directories
# ---------------------------------------------------------------------------
TEMP_DIR = "tmp_photos"

# ---------------------------------------------------------------------------
# State management – SQLite database tracking processed images
# ---------------------------------------------------------------------------
STATE_DB_PATH = "processed_posts.db"

# ---------------------------------------------------------------------------
# Google Photos OAuth 2.0
# ---------------------------------------------------------------------------
# client_secret.json – downloaded from Google Cloud Console (see README.md)
GOOGLE_CREDENTIALS_FILE = "client_secret.json"
# Cached OAuth token (written automatically after first login)
GOOGLE_TOKEN_FILE = "token.json"

# ---------------------------------------------------------------------------
# Scraper behaviour
# ---------------------------------------------------------------------------
# True  → run Chrome in the background (recommended for regular use)
# False → show the browser window (useful for debugging)
HEADLESS_BROWSER = True

# Maximum posts to process per run (0 = unlimited).
# Set to a small number (e.g. 10) when testing for the first time.
MAX_POSTS = 0

# How many consecutive already-processed posts trigger an early stop when
# doing an incremental (catch-up) run.  Increase if posts are sometimes
# missed; decrease to speed up daily runs.
INCREMENTAL_STOP_THRESHOLD = 5
