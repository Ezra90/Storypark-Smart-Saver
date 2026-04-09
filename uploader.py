"""
uploader.py – Upload photos to Google Photos via the Library API.

Authentication uses OAuth 2.0 with the credentials file created in Google
Cloud Console.  The token is cached locally so subsequent runs do not
require re-authorisation.

See README.md for step-by-step instructions on creating the credentials.
"""

import json
import logging
import mimetypes
import os

import requests
from google.oauth2.credentials import Credentials
from google.auth.transport.requests import Request
from google_auth_oauthlib.flow import InstalledAppFlow

from config import GOOGLE_CREDENTIALS_FILE, GOOGLE_TOKEN_FILE

logger = logging.getLogger(__name__)

# Read-only scope is not enough; we need to create media items.
SCOPES = ["https://www.googleapis.com/auth/photoslibrary.appendonly"]

UPLOAD_URL = "https://photoslibrary.googleapis.com/v1/uploads"
BATCH_CREATE_URL = "https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate"


# ---------------------------------------------------------------------------
# Authentication
# ---------------------------------------------------------------------------

def _get_credentials() -> Credentials:
    """
    Return valid Google OAuth 2.0 credentials.

    On the first run, opens a browser window for the user to authorise access.
    The resulting token is saved to GOOGLE_TOKEN_FILE for future runs.
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
                    "project root (see README.md for instructions)."
                )
            flow = InstalledAppFlow.from_client_secrets_file(
                GOOGLE_CREDENTIALS_FILE, SCOPES
            )
            creds = flow.run_local_server(port=0)

        with open(GOOGLE_TOKEN_FILE, "w") as token_file:
            token_file.write(creds.to_json())
        logger.info("OAuth token saved to %s", GOOGLE_TOKEN_FILE)

    return creds


# ---------------------------------------------------------------------------
# Upload helpers
# ---------------------------------------------------------------------------

def _upload_bytes(session: requests.Session, local_path: str) -> str | None:
    """
    Upload the raw bytes of *local_path* to the Google Photos upload endpoint.

    Returns the upload token (needed for batchCreate) or None on failure.
    """
    mime_type, _ = mimetypes.guess_type(local_path)
    mime_type = mime_type or "image/jpeg"
    filename = os.path.basename(local_path)

    try:
        with open(local_path, "rb") as fh:
            data = fh.read()

        response = session.post(
            UPLOAD_URL,
            data=data,
            headers={
                "Content-Type": "application/octet-stream",
                "X-Goog-Upload-Content-Type": mime_type,
                "X-Goog-Upload-Protocol": "raw",
                "X-Goog-Upload-File-Name": filename,
            },
        )
        response.raise_for_status()
        upload_token = response.text.strip()
        logger.debug("Upload token received for %s", filename)
        return upload_token

    except Exception as exc:
        logger.warning("Failed to upload %s: %s", local_path, exc)
        return None


def _create_media_item(
    session: requests.Session, upload_token: str, filename: str, description: str = ""
) -> bool:
    """
    Call the Google Photos batchCreate endpoint to finalise the upload.

    Returns True on success.
    """
    body = {
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
    try:
        response = session.post(BATCH_CREATE_URL, json=body)
        response.raise_for_status()
        result = response.json()
        status = (
            result.get("newMediaItemResults", [{}])[0]
            .get("status", {})
            .get("message", "")
        )
        if status == "Success" or response.status_code == 200:
            logger.info("Successfully added to Google Photos: %s", filename)
            return True
        logger.warning("Unexpected response for %s: %s", filename, result)
        return False
    except Exception as exc:
        logger.warning("batchCreate failed for %s: %s", filename, exc)
        return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def upload_photos(posts: list[dict], state_conn) -> list[dict]:
    """
    Upload every photo in *posts* to Google Photos.

    Successfully uploaded images are deleted from the local filesystem and
    marked as processed in the state database.

    Returns a list of posts that were successfully uploaded.
    """
    from state_manager import mark_processed

    creds = _get_credentials()

    session = requests.Session()
    session.headers.update({"Authorization": f"Bearer {creds.token}"})

    uploaded: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        image_url = post.get("image_url", "")
        post_url = post.get("post_url", "")

        if not local_path or not os.path.exists(local_path):
            continue

        upload_token = _upload_bytes(session, local_path)
        if not upload_token:
            continue

        filename = os.path.basename(local_path)
        success = _create_media_item(session, upload_token, filename)

        if success:
            mark_processed(state_conn, image_url, post_url)
            os.remove(local_path)
            logger.info("Deleted local copy: %s", local_path)
            uploaded.append(post)

    logger.info(
        "Upload complete: %d/%d photos uploaded to Google Photos.",
        len(uploaded),
        len(posts),
    )
    return uploaded
