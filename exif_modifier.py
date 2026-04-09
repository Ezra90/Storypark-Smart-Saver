"""
exif_modifier.py – Rewrite EXIF metadata on matched photos.

For every matched photo:
  • Sets DateTimeOriginal to the date extracted from the Storypark post.
  • Sets GPS coordinates to the static daycare location from config.py.
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

def _to_rational(value: float) -> tuple[tuple[int, int], tuple[int, int], tuple[int, int]]:
    """Convert a decimal degree value to EXIF rational GPS format (D, M, S)."""
    degrees = int(abs(value))
    minutes_float = (abs(value) - degrees) * 60
    minutes = int(minutes_float)
    seconds = round((minutes_float - minutes) * 60 * 100)  # hundredths of a second
    return ((degrees, 1), (minutes, 1), (seconds, 100))


def _datetime_to_exif(dt: datetime) -> str:
    """Format a datetime for the EXIF DateTimeOriginal tag (YYYY:MM:DD HH:MM:SS)."""
    return dt.strftime("%Y:%m:%d %H:%M:%S")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def apply_exif(posts: list[dict]) -> list[dict]:
    """
    Rewrite EXIF data on every photo in *posts*.

    Each item in *posts* must contain:
        local_path – path to the image file
        post_date  – datetime object (may be None; falls back to now)

    Returns the same list (all items updated in-place on disk).
    """
    updated: list[dict] = []

    for post in posts:
        local_path = post.get("local_path", "")
        post_date: datetime | None = post.get("post_date")

        if not local_path or not os.path.exists(local_path):
            continue

        try:
            # Use the post date or fall back to the current time
            dt = post_date if post_date else datetime.now()

            # -----------------------------------------------------------
            # Load existing EXIF (or start fresh)
            # -----------------------------------------------------------
            img = Image.open(local_path)

            # piexif can only work with JPEG; convert if necessary
            if img.format not in ("JPEG", "MPO"):
                jpeg_path = os.path.splitext(local_path)[0] + ".jpg"
                img = img.convert("RGB")
                img.save(jpeg_path, "JPEG", quality=95)
                os.remove(local_path)
                local_path = jpeg_path
                post["local_path"] = jpeg_path

            try:
                exif_dict = piexif.load(local_path)
            except Exception:
                exif_dict = {"0th": {}, "Exif": {}, "GPS": {}, "1st": {}}

            # -----------------------------------------------------------
            # DateTimeOriginal
            # -----------------------------------------------------------
            exif_str = _datetime_to_exif(dt)
            exif_dict["Exif"][piexif.ExifIFD.DateTimeOriginal] = exif_str.encode()
            exif_dict["Exif"][piexif.ExifIFD.DateTimeDigitized] = exif_str.encode()
            exif_dict["0th"][piexif.ImageIFD.DateTime] = exif_str.encode()

            # -----------------------------------------------------------
            # GPS coordinates (daycare location)
            # -----------------------------------------------------------
            lat = DAYCARE_LATITUDE
            lon = DAYCARE_LONGITUDE

            exif_dict["GPS"][piexif.GPSIFD.GPSLatitudeRef] = b"N" if lat >= 0 else b"S"
            exif_dict["GPS"][piexif.GPSIFD.GPSLatitude] = _to_rational(lat)
            exif_dict["GPS"][piexif.GPSIFD.GPSLongitudeRef] = b"E" if lon >= 0 else b"W"
            exif_dict["GPS"][piexif.GPSIFD.GPSLongitude] = _to_rational(lon)

            # -----------------------------------------------------------
            # Save
            # -----------------------------------------------------------
            exif_bytes = piexif.dump(exif_dict)
            piexif.insert(exif_bytes, local_path)

            logger.info("EXIF updated: %s  (date=%s)", local_path, exif_str)
            updated.append(post)

        except Exception as exc:
            logger.warning("Failed to update EXIF for %s: %s", local_path, exc)

    logger.info("EXIF modification complete: %d/%d images updated.", len(updated), len(posts))
    return updated
