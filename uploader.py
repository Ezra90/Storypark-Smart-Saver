"""
uploader.py – Upload photos to Google Photos via the Library API.

Delegates all authentication and HTTP logic to google_photos.py.
The token is cached in GOOGLE_TOKEN_FILE so re-authorisation is only
needed when the refresh token expires (~6 months of inactivity).
"""

import logging
import os

import google_photos

logger = logging.getLogger(__name__)


def upload_photos(posts: list[dict], state_conn) -> list[dict]:
    """
    Upload every photo in *posts* to Google Photos.

    • Successfully uploaded images are deleted from the local filesystem.
    • Each upload is recorded in the state database so it is never
      re-uploaded on a future run.

    Returns the subset of *posts* that were successfully uploaded.
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

        upload_token = google_photos.upload_bytes(session, local_path)
        if not upload_token:
            continue

        filename = os.path.basename(local_path)
        description = f"Storypark – {', '.join(children)}" if children else "Storypark"
        success = google_photos.create_media_item(
            session, upload_token, filename, description
        )

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
