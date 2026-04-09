"""
uploader.py – Upload photos to Google Photos via the Library API.

Delegates all authentication and HTTP logic to google_photos.py.
The token is cached in GOOGLE_TOKEN_FILE so re-authorisation is only
needed when the refresh token expires (~6 months of inactivity).

Handles Google Photos daily API quota limits (HTTP 429 / 500) by saving
the current database state and raising :class:`google_photos.QuotaExceededError`
with a user-friendly message.
"""

import logging
import os

import google_photos
from config import ALBUM_ID
from google_photos import QuotaExceededError

logger = logging.getLogger(__name__)

# User-facing message shown when the quota is hit.
_QUOTA_MESSAGE = (
    "Daily Google Photos limit reached. Please click Sync again tomorrow."
)


def upload_photos(posts: list[dict], state_conn) -> list[dict]:
    """
    Upload every photo in *posts* to Google Photos.

    • Successfully uploaded images are deleted from the local filesystem.
    • Each upload is recorded in the state database so it is never
      re-uploaded on a future run.

    Returns the subset of *posts* that were successfully uploaded.

    Raises :class:`google_photos.QuotaExceededError` (with a clear,
    user-friendly message) if the daily API limit is hit.  The database
    state is committed before the exception is raised so no work is lost.
    """
    from state_manager import mark_processed

    creds = google_photos.get_credentials()
    session = google_photos.make_session(creds)

    uploaded: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        image_url = post.get("image_url", "")
        post_url = post.get("post_url", "")
        children = post.get("matched_children", [])

        if not local_path or not os.path.exists(local_path):
            continue

        try:
            upload_token = google_photos.upload_bytes(session, local_path)
        except QuotaExceededError as exc:
            logger.warning(
                "API quota exceeded during upload – saving state and stopping.  "
                "%d photo(s) uploaded before the limit was reached.",
                len(uploaded),
            )
            state_conn.commit()
            quota_err = QuotaExceededError(_QUOTA_MESSAGE)
            quota_err.uploaded_count = len(uploaded)
            raise quota_err from exc

        if not upload_token:
            continue

        filename = os.path.basename(local_path)
        description = f"Storypark – {', '.join(children)}" if children else "Storypark"

        try:
            success = google_photos.create_media_item(
                session, upload_token, filename, description,
                album_id=ALBUM_ID,
            )
        except QuotaExceededError as exc:
            logger.warning(
                "API quota exceeded during batchCreate – saving state and "
                "stopping.  %d photo(s) uploaded before the limit was reached.",
                len(uploaded),
            )
            state_conn.commit()
            quota_err = QuotaExceededError(_QUOTA_MESSAGE)
            quota_err.uploaded_count = len(uploaded)
            raise quota_err from exc

        if success:
            mark_processed(state_conn, image_url, post_url)
            os.remove(local_path)
            logger.info("Deleted local copy: %s", local_path)
            uploaded.append(post)

    logger.info(
        "Upload complete: %d/%d photo(s) sent to Google Photos.",
        len(uploaded),
        len(posts),
    )
    return uploaded
