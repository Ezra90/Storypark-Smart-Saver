"""
exif_modifier.py – Rewrite EXIF metadata on matched photos.

For every matched photo:
  • Sets DateTimeOriginal (and related tags) to the date the story was
    uploaded to Storypark.  If no date was captured during scraping the
    timestamp tags are left unchanged – we never substitute the current
    time, which would produce misleading metadata.
  • Always overwrites the GPS tags with the static daycare coordinates
    from config.py so every photo is placed at the correct location in
    Google Photos / Apple Photos timelines.
"""

import logging
import os
from datetime import datetime

import piexif
from PIL import Image

from config import DAYCARE_LATITUDE, DAYCARE_LONGITUDE

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _to_rational(
    value: float,
) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    """Convert a decimal-degree value to EXIF rational GPS format (D, M, S)."""
    degrees = int(abs(value))
    minutes_float = (abs(value) - degrees) * 60
    minutes = int(minutes_float)
    seconds = round((minutes_float - minutes) * 60 * 100)  # hundredths of a second
    return ((degrees, 1), (minutes, 1), (seconds, 100))


def _datetime_to_exif(dt: datetime) -> str:
    """Format a datetime for EXIF tags (YYYY:MM:DD HH:MM:SS)."""
    return dt.strftime("%Y:%m:%d %H:%M:%S")


def _ensure_jpeg(local_path: str, post: dict) -> str:
    """
    If *local_path* is not a JPEG, convert it and update ``post['local_path']``.

    Returns the (possibly new) path to the JPEG file.
    piexif only supports JPEG so this conversion is required for PNG/WebP.
    """
    img = Image.open(local_path)
    if img.format in ("JPEG", "MPO"):
        img.close()
        return local_path

    jpeg_path = os.path.splitext(local_path)[0] + ".jpg"
    rgb = img.convert("RGB")
    rgb.save(jpeg_path, "JPEG", quality=95)
    img.close()
    os.remove(local_path)
    post["local_path"] = jpeg_path
    logger.debug("Converted %s → %s", local_path, jpeg_path)
    return jpeg_path


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def apply_exif(posts: list[dict]) -> list[dict]:
    """
    Rewrite EXIF data on every photo in *posts*.

    Expected keys in each post dict:
        local_path – path to the image file on disk
        post_date  – datetime object from the Storypark post, or None

    Behaviour:
        • DateTimeOriginal is set to post_date when available.
          If post_date is None the timestamp tags are left untouched
          (we never stamp photos with the current time).
        • GPS tags are always set to the daycare coordinates in config.py.

    Returns the updated list (items where EXIF was successfully written).
    """
    updated: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        post_date: datetime | None = post.get("post_date")

        if not local_path or not os.path.exists(local_path):
            continue

        try:
            # ----------------------------------------------------------
            # Ensure the file is a JPEG (piexif requirement)
            # ----------------------------------------------------------
            local_path = _ensure_jpeg(local_path, post)

            # ----------------------------------------------------------
            # Load existing EXIF data (or start with an empty structure)
            # ----------------------------------------------------------
            try:
                exif_dict = piexif.load(local_path)
            except Exception:
                exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}}

            # ----------------------------------------------------------
            # Timestamp – only if we have the real Storypark upload date
            # ----------------------------------------------------------
            if post_date is not None:
                exif_str = _datetime_to_exif(post_date)
                exif_dict["Exif"][piexif.ExifIFD.DateTimeOriginal] = (
                    exif_str.encode()
                )
                exif_dict["Exif"][piexif.ExifIFD.DateTimeDigitized] = (
                    exif_str.encode()
                )
                exif_dict["0th"][piexif.ImageIFD.DateTime] = exif_str.encode()
                logger.info(
                    "EXIF date set to Storypark upload date: %s  (%s)",
                    exif_str,
                    local_path,
                )
            else:
                logger.warning(
                    "No Storypark upload date found for %s – "
                    "timestamp tags left unchanged.",
                    local_path,
                )

            # ----------------------------------------------------------
            # GPS – always stamp with the daycare location
            # ----------------------------------------------------------
            lat = DAYCARE_LATITUDE
            lon = DAYCARE_LONGITUDE
            exif_dict["GPS"][piexif.GPSIFD.GPSLatitudeRef] = (
                b"N" if lat >= 0 else b"S"
            )
            exif_dict["GPS"][piexif.GPSIFD.GPSLatitude] = _to_rational(lat)
            exif_dict["GPS"][piexif.GPSIFD.GPSLongitudeRef] = (
                b"E" if lon >= 0 else b"W"
            )
            exif_dict["GPS"][piexif.GPSIFD.GPSLongitude] = _to_rational(lon)

            # ----------------------------------------------------------
            # Write back
            # ----------------------------------------------------------
            exif_bytes = piexif.dump(exif_dict)
            piexif.insert(exif_bytes, local_path)

            updated.append(post)

        except Exception as exc:
            logger.warning("Failed to update EXIF for %s: %s", local_path, exc)

    missing_dates = sum(1 for p in posts if p.get("post_date") is None)
    if missing_dates:
        logger.warning(
            "%d photo(s) had no Storypark date – their timestamps were not changed.",
            missing_dates,
        )
    logger.info(
        "EXIF modification complete: %d/%d image(s) updated.", len(updated), len(posts)
    )
    return updated
