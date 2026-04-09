"""
google_photos.py – Google Photos API client.

Handles OAuth authentication, album browsing (used by setup.py to build
reference face encodings), sample photo downloading, and photo uploading.

All other modules that need to talk to Google Photos import from here so
credentials and HTTP logic live in one place.
"""

import logging
import mimetypes
import os

import requests
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

from config import GOOGLE_CREDENTIALS_FILE, GOOGLE_TOKEN_FILE

logger = logging.getLogger(__name__)

# Both scopes are required:
#   readonly   – list albums and download sample photos during setup
#   appendonly – upload processed photos to the library
SCOPES = [
    "https://www.googleapis.com/auth/photoslibrary.readonly",
    "https://www.googleapis.com/auth/photoslibrary.appendonly",
]

_BASE = "https://photoslibrary.googleapis.com/v1"


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class QuotaExceededError(Exception):
    """Raised when the Google Photos API returns HTTP 429 or 500.

    This typically means the daily upload quota has been reached.
    The caller should save state and inform the user to try again tomorrow.
    """


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

def get_credentials() -> Credentials:
    """
    Return valid Google OAuth 2.0 credentials.

    On the first call, a browser window opens for the user to authorise
    access.  The token is cached in GOOGLE_TOKEN_FILE so future calls do
    not require re-authorisation unless the token expires.
    """
    creds: Credentials | None = None

    if os.path.exists(GOOGLE_TOKEN_FILE):
        creds = Credentials.from_authorized_user_file(GOOGLE_TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            logger.info("Refreshing expired Google OAuth token…")
            creds.refresh(Request())
        else:
            if not os.path.exists(GOOGLE_CREDENTIALS_FILE):
                raise FileNotFoundError(
                    f"Google credentials file not found: {GOOGLE_CREDENTIALS_FILE}\n"
                    "Download it from Google Cloud Console and place it in the "
                    "project root.  See README.md for step-by-step instructions."
                )
            flow = InstalledAppFlow.from_client_secrets_file(
                GOOGLE_CREDENTIALS_FILE, SCOPES
            )
            creds = flow.run_local_server(port=0)

        with open(GOOGLE_TOKEN_FILE, "w") as fh:
            fh.write(creds.to_json())
        logger.info("OAuth token saved to %s", GOOGLE_TOKEN_FILE)

    return creds


def make_session(creds: Credentials) -> requests.Session:
    """Return a requests.Session pre-configured with the OAuth bearer token."""
    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {creds.token}"})
    return session


# ---------------------------------------------------------------------------
# Album browsing (used by setup.py)
# ---------------------------------------------------------------------------

def list_albums(session: requests.Session) -> list[dict]:
    """
    Return every album in the user's Google Photos library.

    Each item contains at least: ``{"id", "title", "mediaItemsCount"}``.
    """
    albums: list[dict] = []
    params: dict = {"pageSize": 50}
    while True:
        resp = session.get(f"{_BASE}/albums", params=params)
        resp.raise_for_status()
        data = resp.json()
        albums.extend(data.get("albums", []))
        next_token = data.get("nextPageToken")
        if not next_token:
            break
        params["pageToken"] = next_token
    return albums


def list_media_in_album(
    session: requests.Session, album_id: str, max_items: int = 30
) -> list[dict]:
    """
    Return up to *max_items* media items from *album_id*.

    Each item contains at least: ``{"id", "baseUrl", "mimeType", "filename"}``.
    """
    items: list[dict] = []
    body: dict = {"albumId": album_id, "pageSize": min(max_items, 100)}
    while len(items) < max_items:
        resp = session.post(f"{_BASE}/mediaItems:search", json=body)
        resp.raise_for_status()
        data = resp.json()
        items.extend(data.get("mediaItems", []))
        next_token = data.get("nextPageToken")
        if not next_token or len(items) >= max_items:
            break
        body["pageToken"] = next_token
    return items[:max_items]


def download_media_item(
    session: requests.Session, media_item: dict, dest_dir: str
) -> str | None:
    """
    Download a single Google Photos media item to *dest_dir*.

    Returns the local file path, or ``None`` on failure.
    Appending ``=d`` to the ``baseUrl`` fetches the original-resolution file.
    """
    base_url = media_item.get("baseUrl", "")
    filename = media_item.get("filename") or f"{media_item.get('id', 'photo')}.jpg"
    local_path = os.path.join(dest_dir, filename)

    if os.path.exists(local_path):
        return local_path

    try:
        resp = session.get(base_url + "=d", timeout=30)
        resp.raise_for_status()
        with open(local_path, "wb") as fh:
            fh.write(resp.content)
        return local_path
    except Exception as exc:
        logger.warning("Failed to download %s: %s", filename, exc)
        return None


def create_album(session: requests.Session, title: str) -> dict:
    """
    Create a new album in the user's Google Photos library.

    Returns the album dict with at least ``{"id", "title"}``.
    """
    body = {"album": {"title": title}}
    resp = session.post(f"{_BASE}/albums", json=body)
    resp.raise_for_status()
    album = resp.json()
    logger.info("Created album: %s (id=%s)", album.get("title"), album.get("id"))
    return album


# ---------------------------------------------------------------------------
# Upload (used by uploader.py)
# ---------------------------------------------------------------------------

def upload_bytes(session: requests.Session, local_path: str) -> str | None:
    """
    Upload the raw bytes of *local_path* to the Google Photos upload endpoint.

    Returns the upload token needed for ``create_media_item``, or ``None``
    on failure.

    Raises :class:`QuotaExceededError` if the API responds with HTTP 429
    (Too Many Requests) or HTTP 500 (Internal Server Error), which
    typically indicates the daily quota has been reached.
    """
    mime_type, _ = mimetypes.guess_type(local_path)
    mime_type = mime_type or "image/jpeg"
    filename = os.path.basename(local_path)

    try:
        with open(local_path, "rb") as fh:
            data = fh.read()

        resp = session.post(
            f"{_BASE}/uploads",
            data=data,
            headers={
                "Content-Type": "application/octet-stream",
                "X-Goog-Upload-Content-Type": mime_type,
                "X-Goog-Upload-Protocol": "raw",
                "X-Goog-Upload-File-Name": filename,
            },
        )

        if resp.status_code in (429, 500):
            logger.warning(
                "Google Photos API returned HTTP %d for %s – quota likely exceeded.",
                resp.status_code, filename,
            )
            raise QuotaExceededError(
                f"Google Photos API returned HTTP {resp.status_code} "
                f"during upload of {filename}."
            )

        resp.raise_for_status()
        logger.debug("Upload token received for %s", filename)
        return resp.text.strip()
    except QuotaExceededError:
        raise  # propagate without wrapping
    except Exception as exc:
        logger.warning("Upload failed for %s: %s", local_path, exc)
        return None


def create_media_item(
    session: requests.Session,
    upload_token: str,
    filename: str,
    description: str = "",
    album_id: str = "",
) -> bool:
    """
    Finalise an upload via the ``mediaItems:batchCreate`` endpoint.

    If *album_id* is provided the photo is added to that album;
    otherwise it goes into the main Google Photos library.

    Returns ``True`` on success.

    Raises :class:`QuotaExceededError` on HTTP 429 / 500.
    """
    body: dict = {
        "newMediaItems": [
            {
                "description": description,
                "simpleMediaItem": {
                    "uploadToken": upload_token,
                    "fileName": filename,
                },
            }
        ]
    }
    if album_id:
        body["albumId"] = album_id
    try:
        resp = session.post(f"{_BASE}/mediaItems:batchCreate", json=body)

        if resp.status_code in (429, 500):
            logger.warning(
                "Google Photos API returned HTTP %d for batchCreate (%s) "
                "– quota likely exceeded.",
                resp.status_code, filename,
            )
            raise QuotaExceededError(
                f"Google Photos API returned HTTP {resp.status_code} "
                f"during batchCreate for {filename}."
            )

        resp.raise_for_status()
        result = resp.json()
        status = (
            result.get("newMediaItemResults", [{}])[0]
            .get("status", {})
            .get("message", "")
        )
        if status in ("Success", "OK") or resp.status_code == 200:
            logger.info("Google Photos: added %s", filename)
            return True
        logger.warning("Unexpected batchCreate response for %s: %s", filename, result)
        return False
    except QuotaExceededError:
        raise  # propagate without wrapping
    except Exception as exc:
        logger.warning("batchCreate failed for %s: %s", filename, exc)
        return False
