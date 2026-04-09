"""
face_filter.py – Filter photos using local facial recognition.

Loads pre-computed face encodings for every configured child (built by
setup.py and stored in face_encodings.pkl) and checks each downloaded photo.

Photos where NONE of the children are detected are deleted from disk.
Photos where at least one child is detected are kept, and the matching
child names are recorded in the post dict under the key 'matched_children'.
"""

import logging
import os
import pickle

import face_recognition

from config import REFERENCE_ENCODINGS_FILE

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Loading encodings
# ---------------------------------------------------------------------------

def _load_encodings() -> dict[str, list]:
    """
    Load face encodings from the pickle file created by setup.py.

    Returns a dict mapping child name → list of numpy encoding arrays.
    Raises FileNotFoundError if the encodings file does not exist.
    """
    if not os.path.exists(REFERENCE_ENCODINGS_FILE):
        raise FileNotFoundError(
            f"Face encodings file not found: {REFERENCE_ENCODINGS_FILE}\n"
            "Run  python setup.py  first to build the face encodings from\n"
            "your Google Photos library."
        )

    with open(REFERENCE_ENCODINGS_FILE, "rb") as fh:
        data = pickle.load(fh)

    if not isinstance(data, dict) or not data:
        raise ValueError(
            f"Face encodings file appears empty or corrupt: {REFERENCE_ENCODINGS_FILE}\n"
            "Delete it and re-run  python setup.py  to rebuild."
        )

    total = sum(len(v) for v in data.values())
    logger.info(
        "Loaded face encodings for %d child(ren), %d encoding(s) total: %s",
        len(data),
        total,
        ", ".join(f"{name} ({len(enc)})" for name, enc in data.items()),
    )
    return data


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def filter_photos(posts: list[dict]) -> list[dict]:
    """
    Filter *posts* to only those where at least one known child appears.

    Each item in *posts* must have a ``local_path`` key.  Items that do NOT
    match any child are deleted from disk.  Matched items gain a new key:

        ``matched_children`` – list of child names found in the photo

    Returns the filtered list.
    """
    encodings_by_child = _load_encodings()

    # Flatten all encodings into a single list, keeping track of which child
    # each encoding belongs to so we can report matches by name.
    all_encodings: list = []
    all_labels: list[str] = []
    for child_name, encs in encodings_by_child.items():
        all_encodings.extend(encs)
        all_labels.extend([child_name] * len(encs))

    matched: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        if not local_path or not os.path.exists(local_path):
            continue

        try:
            photo = face_recognition.load_image_file(local_path)
            face_encodings_in_photo = face_recognition.face_encodings(photo)

            if not face_encodings_in_photo:
                logger.debug("No faces detected in %s – deleting.", local_path)
                os.remove(local_path)
                continue

            # Check every face found in the photo against every known encoding
            found_children: set[str] = set()
            for face_enc in face_encodings_in_photo:
                matches = face_recognition.compare_faces(
                    all_encodings, face_enc, tolerance=0.6
                )
                for is_match, label in zip(matches, all_labels):
                    if is_match:
                        found_children.add(label)

            if found_children:
                post["matched_children"] = sorted(found_children)
                logger.info(
                    "Match – %s found in: %s",
                    ", ".join(sorted(found_children)),
                    local_path,
                )
                matched.append(post)
            else:
                logger.debug("No match in %s – deleting.", local_path)
                os.remove(local_path)

        except Exception as exc:
            logger.warning("Error processing %s: %s – skipping.", local_path, exc)

    logger.info(
        "Face filter complete: %d/%d image(s) kept.", len(matched), len(posts)
    )
    return matched
