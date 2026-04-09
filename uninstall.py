#!/usr/bin/env python3
"""
uninstall.py – Completely remove all Storypark Photo Pipeline data.

Run this script to wipe every trace of the app from your system:

    python uninstall.py

What it does:
  1. Deletes the Storypark password from the OS keychain.
  2. Uninstalls Playwright browser binaries (Chromium, etc.).
  3. Removes config.json, the SQLite database, face_encodings.pkl,
     pipeline logs, and all temporary directories.

The script never touches your Google Photos library.
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _remove_file(path: Path, label: str) -> None:
    """Delete a single file, logging the result."""
    if path.exists():
        try:
            path.unlink()
            print(f"  ✓ Deleted {label}: {path}")
        except OSError as exc:
            print(f"  ✗ Could not delete {label} ({path}): {exc}")
    else:
        print(f"  – {label} not found (already clean): {path}")


def _remove_dir(path: Path, label: str) -> None:
    """Recursively delete a directory tree, logging the result."""
    if path.exists():
        try:
            shutil.rmtree(path)
            print(f"  ✓ Deleted {label}: {path}")
        except OSError as exc:
            print(f"  ✗ Could not delete {label} ({path}): {exc}")
    else:
        print(f"  – {label} not found (already clean): {path}")


# ---------------------------------------------------------------------------
# Step 1 – Keychain
# ---------------------------------------------------------------------------

def _remove_keychain_entry() -> None:
    """Delete the Storypark password from the OS keychain."""
    print("\n── Step 1: Keychain ─────────────────────────────────────")

    # Try to read the email from config.json so we know which entry to delete.
    email = ""
    config_path = APP_DIR / "config.json"
    if config_path.exists():
        try:
            import json
            with open(config_path, "r", encoding="utf-8") as fh:
                cfg = json.load(fh)
            email = cfg.get("storypark_email", "")
        except Exception:
            pass

    if not email:
        print("  – No email found in config.json; skipping keychain cleanup.")
        return

    try:
        import keyring
        service = "storypark-scraper"
        existing = keyring.get_password(service, email)
        if existing:
            keyring.delete_password(service, email)
            print(f"  ✓ Removed password for {email} from the OS keychain.")
        else:
            print(f"  – No keychain entry found for {email}.")
    except ImportError:
        print("  – keyring library not installed; skipping keychain cleanup.")
    except Exception as exc:
        print(f"  ✗ Could not access keychain: {exc}")


# ---------------------------------------------------------------------------
# Step 2 – Playwright browsers
# ---------------------------------------------------------------------------

def _remove_playwright() -> None:
    """Uninstall all Playwright browser binaries."""
    print("\n── Step 2: Playwright browsers ──────────────────────────")
    try:
        result = subprocess.run(
            [sys.executable, "-m", "playwright", "uninstall", "--all"],
            capture_output=True,
            text=True,
            timeout=120,
        )
        if result.returncode == 0:
            print("  ✓ Playwright browsers uninstalled.")
        else:
            print(f"  ✗ Playwright uninstall exited with code {result.returncode}:")
            if result.stderr:
                print(f"    {result.stderr.strip()}")
    except FileNotFoundError:
        print("  – Playwright not installed; nothing to remove.")
    except subprocess.TimeoutExpired:
        print("  ✗ Playwright uninstall timed out.")
    except Exception as exc:
        print(f"  ✗ Playwright uninstall failed: {exc}")


# ---------------------------------------------------------------------------
# Step 3 – Data files
# ---------------------------------------------------------------------------

def _remove_data_files() -> None:
    """Delete config.json, database, face encodings, logs, and temp dirs."""
    print("\n── Step 3: Data files ──────────────────────────────────")

    _remove_file(APP_DIR / "config.json",         "Configuration")
    _remove_file(APP_DIR / "processed_posts.db",   "State database")
    _remove_file(APP_DIR / "face_encodings.pkl",   "Face encodings")
    _remove_file(APP_DIR / "pipeline.log",         "Pipeline log")
    _remove_file(APP_DIR / "token.json",           "Google OAuth token")
    _remove_dir(APP_DIR / "tmp_photos",            "Temp photo directory")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 58)
    print("  Storypark Photo Pipeline – Uninstaller")
    print("=" * 58)
    print()
    print("  This will permanently delete all app data including:")
    print("    • Your saved Storypark password (from the OS keychain)")
    print("    • Playwright browser binaries")
    print("    • config.json, the state database, face data, and logs")
    print()
    print("  Your Google Photos library will NOT be affected.")
    print()

    confirm = input("  Type YES to continue: ").strip()
    if confirm != "YES":
        print("\n  Cancelled – nothing was deleted.")
        return

    _remove_keychain_entry()
    _remove_playwright()
    _remove_data_files()

    print()
    print("=" * 58)
    print("  ✓ Uninstall complete.")
    print()
    print("  To fully remove the Python packages, run:")
    print("    pip uninstall -r requirements.txt -y")
    print("=" * 58)
    print()


if __name__ == "__main__":
    main()
