"""
setup.py – Interactive first-run wizard for the Storypark Photo Pipeline.

Run once before using main.py:

    python setup.py

The wizard walks you through:
  1. Storypark account credentials
  2. Google Photos OAuth (opens a browser window)
  3. Selecting which Google Photos album best represents each child
     → sample photos are downloaded and face encodings are built automatically
  4. Daycare GPS coordinates (from Google Maps)
  5. General options (headless mode, post limit)

Everything is saved to config.json and face_encodings.pkl so you never need to
edit config files or provide reference photos manually.  The Storypark
password is stored securely in the OS keychain – it never touches a file.
"""

import getpass
import logging
import os
import pickle
import sys
import tempfile
from pathlib import Path

# Keep wizard output clean – only show warnings and errors from libraries
logging.basicConfig(level=logging.WARNING)

# ---------------------------------------------------------------------------
# Dependency checks with friendly messages
# ---------------------------------------------------------------------------
try:
    import face_recognition
except ImportError:
    sys.exit(
        "\n  ✗  face_recognition is not installed.\n"
        "     Run: pip install -r requirements.txt\n"
    )

try:
    import google_photos
except ImportError:
    sys.exit(
        "\n  ✗  google_photos module not found.\n"
        "     Make sure you are running this from the project directory.\n"
    )


# ---------------------------------------------------------------------------
# Console helpers
# ---------------------------------------------------------------------------

def _banner(text: str) -> None:
    print()
    print("=" * 62)
    print(f"  {text}")
    print("=" * 62)


def _ask(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"  {prompt}{suffix}: ").strip()
    return value if value else default


def _ask_password(prompt: str) -> str:
    return getpass.getpass(f"  {prompt}: ")


def _ask_float(prompt: str, default: float = 0.0) -> float:
    while True:
        raw = _ask(prompt, str(default))
        try:
            return float(raw)
        except ValueError:
            print("    Please enter a valid decimal number (e.g. -33.8688).")


def _ask_int(prompt: str, default: int = 0, min_val: int = 0) -> int:
    while True:
        raw = _ask(prompt, str(default))
        try:
            val = int(raw)
            if val >= min_val:
                return val
            print(f"    Please enter a number ≥ {min_val}.")
        except ValueError:
            print("    Please enter a whole number.")


def _ask_yn(prompt: str, default: bool = True) -> bool:
    default_str = "Y/n" if default else "y/N"
    raw = input(f"  {prompt} ({default_str}): ").strip().lower()
    if not raw:
        return default
    return raw.startswith("y")


# ---------------------------------------------------------------------------
# Face encoding builder
# ---------------------------------------------------------------------------

def _build_encodings_for_child(
    child_name: str,
    session,
    album: dict,
) -> list:
    """
    Download sample photos from *album* and extract face encodings for
    *child_name*.  Returns a (possibly empty) list of numpy encoding arrays.
    """
    print(f"\n  Downloading sample photos from '{album['title']}'…")
    sample_dir = Path(tempfile.mkdtemp(prefix="storypark_setup_"))

    try:
        media_items = google_photos.list_media_in_album(
            session, album["id"], max_items=30
        )

        if not media_items:
            print("  ⚠  No photos found in this album.")
            return []

        encodings_found: list = []
        checked = 0

        for item in media_items:
            if not item.get("mimeType", "").startswith("image/"):
                continue

            local_path = google_photos.download_media_item(
                session, item, str(sample_dir)
            )
            if not local_path:
                continue

            checked += 1
            print(f"  Scanning photo {checked}/{len(media_items)}…", end="\r")

            try:
                photo = face_recognition.load_image_file(local_path)
                encodings_found.extend(face_recognition.face_encodings(photo))
            except Exception:
                pass
            finally:
                try:
                    os.remove(local_path)
                except OSError:
                    pass

            if len(encodings_found) >= 10:
                break  # We have enough reference encodings

        print(f"  Scanned {checked} photo(s).{' ' * 20}")  # clear \r line
        return encodings_found

    finally:
        try:
            sample_dir.rmdir()
        except OSError:
            pass  # directory may not be empty if a download was interrupted


# ---------------------------------------------------------------------------
# Config writer
# ---------------------------------------------------------------------------

def _write_config(cfg: dict) -> None:
    """Save wizard settings to config.json.

    The Storypark password is **not** included – it is stored separately
    in the OS keychain by the wizard's credential step.
    """
    from config_manager import save_config  # noqa: PLC0415

    save_config({
        "storypark_email":          cfg["storypark_email"],
        "children":                 cfg["children"],
        "daycare_latitude":         cfg["latitude"],
        "daycare_longitude":        cfg["longitude"],
        "headless_browser":         cfg["headless"],
        "max_posts":                cfg["max_posts"],
    })


# ---------------------------------------------------------------------------
# Wizard
# ---------------------------------------------------------------------------

def run_wizard() -> None:
    _banner("Storypark Photo Pipeline – Setup Wizard")
    print()
    print("  This wizard runs once to configure the pipeline.")
    print("  Afterwards, just run:  python main.py")
    print()
    print("  You will need:")
    print("    • Your Storypark email and password")
    print("    • A client_secret.json file from Google Cloud Console")
    print("      (see README.md if you have not set this up yet)")
    print("    • The GPS coordinates of the daycare (from Google Maps)")

    cfg: dict = {}

    # ------------------------------------------------------------------
    # Step 1 – Storypark credentials
    # ------------------------------------------------------------------
    _banner("Step 1 of 5 – Storypark Account")
    print()
    cfg["storypark_email"] = _ask("Storypark email")
    storypark_password = _ask_password("Storypark password")

    # Save password to the OS keychain immediately.
    try:
        import keyring  # noqa: PLC0415
        from config_manager import KEYRING_SERVICE  # noqa: PLC0415
        keyring.set_password(
            KEYRING_SERVICE, cfg["storypark_email"], storypark_password,
        )
        print("  ✓ Password saved securely in the OS keychain.")
    except Exception as exc:
        print(f"\n  ✗ Could not save password to keychain: {exc}")
        sys.exit(1)
    finally:
        storypark_password = ""  # best-effort clear

    # ------------------------------------------------------------------
    # Step 2 – Google Photos OAuth
    # ------------------------------------------------------------------
    _banner("Step 2 of 5 – Google Photos Account")
    print()
    print("  A browser window will open so you can sign in to Google and")
    print("  grant this app access to your Google Photos library.")
    print()
    input("  Press ENTER to open the browser… ")

    try:
        creds = google_photos.get_credentials()
        session = google_photos.make_session(creds)
        print()
        print("  ✓ Connected to Google Photos.")
    except FileNotFoundError as exc:
        print(f"\n  ✗ {exc}")
        sys.exit(1)
    except Exception as exc:
        print(f"\n  ✗ Google authentication failed: {exc}")
        sys.exit(1)

    # ------------------------------------------------------------------
    # Step 3 – Children and face encodings
    # ------------------------------------------------------------------
    _banner("Step 3 of 5 – Your Children")
    print()
    print("  For each child, you will pick a Google Photos album that")
    print("  contains plenty of clear photos of their face.  The wizard")
    print("  downloads samples and builds face encodings automatically.")
    print()
    num_children = _ask_int(
        "How many children do you want to track?", default=1, min_val=1
    )

    print()
    print("  Fetching your Google Photos albums…")
    try:
        albums = google_photos.list_albums(session)
    except Exception as exc:
        print(f"\n  ✗ Could not fetch albums: {exc}")
        sys.exit(1)

    if not albums:
        print(
            "\n  ✗ No albums found in your Google Photos library.\n"
            "     Create an album containing photos of each child,\n"
            "     then re-run setup.py."
        )
        sys.exit(1)

    children: list[str] = []
    encodings_by_child: dict = {}

    child_num = 0
    while child_num < num_children:
        print()
        print(f"  ── Child {child_num + 1} of {num_children} ──────────────────────────────")
        child_name = _ask("Name")

        print()
        print("  Your Google Photos albums:")
        for idx, album in enumerate(albums, 1):
            count = album.get("mediaItemsCount", "?")
            title = album.get("title", "(untitled)")
            print(f"    {idx:3}.  {title}  ({count} items)")

        print()
        while True:
            choice = _ask_int(
                f"Select the album with the most photos of {child_name} (enter number)",
                default=1,
                min_val=1,
            )
            if 1 <= choice <= len(albums):
                break
            print(f"    Please enter a number between 1 and {len(albums)}.")

        chosen_album = albums[choice - 1]
        child_encodings = _build_encodings_for_child(child_name, session, chosen_album)

        if not child_encodings:
            print(
                f"\n  ⚠  No face encodings found in '{chosen_album['title']}'.\n"
                f"     Try choosing an album with larger, clearer photos of {child_name}."
            )
            retry = _ask_yn("  Try a different album?", default=True)
            if retry:
                continue  # retry this child (child_num not incremented)
            print(f"  Skipping {child_name}.")
        else:
            print(
                f"  ✓ {child_name}: {len(child_encodings)} face encoding(s) built."
            )
            children.append(child_name)
            encodings_by_child[child_name] = child_encodings

        child_num += 1  # advance to the next child only after this one is done

    if not children:
        print("\n  ✗ No face encodings were built.  Setup cannot continue.")
        sys.exit(1)

    cfg["children"] = children

    # Save encodings file – we need the filename from config if it exists,
    # otherwise use the default.
    try:
        from config_manager import load_config  # noqa: PLC0415
        REFERENCE_ENCODINGS_FILE = load_config()["reference_encodings_file"]
    except Exception:
        REFERENCE_ENCODINGS_FILE = "face_encodings.pkl"

    with open(REFERENCE_ENCODINGS_FILE, "wb") as fh:
        pickle.dump(encodings_by_child, fh)
    print(f"\n  ✓ Face encodings saved to {REFERENCE_ENCODINGS_FILE}")

    # ------------------------------------------------------------------
    # Step 4 – Daycare GPS
    # ------------------------------------------------------------------
    _banner("Step 4 of 5 – Daycare Location (GPS)")
    print()
    print("  These coordinates are stamped into every matched photo so it")
    print("  appears at the daycare location in Google Photos timelines.")
    print()
    print("  How to find the exact coordinates:")
    print("    1. Open Google Maps in your browser.")
    print("    2. Find the daycare.")
    print("    3. Right-click the exact spot → 'What's here?'")
    print("    4. The latitude and longitude appear at the bottom of the screen.")
    print()
    cfg["latitude"] = _ask_float(
        "Daycare latitude   (e.g. -33.8688)", default=0.0
    )
    cfg["longitude"] = _ask_float(
        "Daycare longitude  (e.g. 151.2093)", default=0.0
    )

    # ------------------------------------------------------------------
    # Step 5 – Options
    # ------------------------------------------------------------------
    _banner("Step 5 of 5 – Options")
    print()
    cfg["headless"] = _ask_yn(
        "Run browser in headless mode? (no visible window – recommended)",
        default=True,
    )
    cfg["max_posts"] = _ask_int(
        "Max posts per run (0 = unlimited, try 10 for first test)",
        default=0,
        min_val=0,
    )

    # ------------------------------------------------------------------
    # Write config
    # ------------------------------------------------------------------
    _write_config(cfg)

    print()
    print("=" * 62)
    print("  ✓ Setup complete!  Configuration saved to config.json")
    print()
    print("  Next steps:")
    print("    1. Run:  python main.py")
    print("       The first run downloads ALL historical Storypark posts.")
    print("       Subsequent runs only download new posts.")
    print()
    print("  Children configured:")
    for name in children:
        n = len(encodings_by_child[name])
        print(f"    • {name}  ({n} face encoding(s))")
    print("=" * 62)
    print()


if __name__ == "__main__":
    run_wizard()
