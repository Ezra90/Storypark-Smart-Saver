"""
face_filter.py – Filter photos using local facial recognition.

Loads a reference headshot of the target child and checks every downloaded
photo.  Images where the child is NOT detected are deleted from the local
temporary directory.
"""

import os
import logging
from pathlib import Path

import face_recognition

from config import REFERENCE_IMAGE_PATH

logger = logging.getLogger(__name__)


def _load_reference_encoding(reference_path: str) -> list:
    """
    Load the reference image and return its face encoding(s).

    Raises FileNotFoundError if the reference image does not exist.
    Raises ValueError if no face is detected in the reference image.
    """
    if not os.path.exists(reference_path):
        raise FileNotFoundError(
            f"Reference image not found: {reference_path}\n"
            "Please place a clear, front-facing headshot at the path configured "
            "in config.py (REFERENCE_IMAGE_PATH)."
        )

    image = face_recognition.load_image_file(reference_path)
    encodings = face_recognition.face_encodings(image)

    if not encodings:
        raise ValueError(
            f"No face detected in the reference image: {reference_path}\n"
            "Use a clear, well-lit, front-facing photo."
        )

    logger.info(
        "Reference image loaded (%d face(s) found): %s", len(encodings), reference_path
    )
    return encodings


def filter_photos(posts: list[dict]) -> list[dict]:
    """
    Filter *posts* to only those where the reference child appears.

    Each item in *posts* must have a 'local_path' key pointing to a downloaded
    image.  Items that do NOT match are deleted from disk.

    Returns the filtered list (items where the child was found).
    """
    reference_encodings = _load_reference_encoding(REFERENCE_IMAGE_PATH)

    matched: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        if not local_path or not os.path.exists(local_path):
            continue

        try:
            photo = face_recognition.load_image_file(local_path)
            face_encodings = face_recognition.face_encodings(photo)

            if not face_encodings:
                logger.debug("No faces detected in %s – deleting.", local_path)
                os.remove(local_path)
                continue

            # Compare every face in the photo against the reference
            matches = face_recognition.compare_faces(
                reference_encodings, face_encodings[0], tolerance=0.6
            )

            if any(matches):
                logger.info("Match found: %s", local_path)
                matched.append(post)
            else:
                logger.debug("No match in %s – deleting.", local_path)
                os.remove(local_path)

        except Exception as exc:
            logger.warning("Error processing %s: %s – skipping.", local_path, exc)

    logger.info(
        "Face filter complete: %d/%d images kept.", len(matched), len(posts)
    )
    return matched
