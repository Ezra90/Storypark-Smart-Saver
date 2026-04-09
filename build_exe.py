"""
build_exe.py – Developer script to build StoryparkSync.exe with PyInstaller.

Run this on your Windows machine inside the activated virtual environment::

    python build_exe.py

The resulting  dist/StoryparkSync.exe  is a single self-contained executable
that non-technical users can run without installing Python, dlib, or any
other dependency.

Requirements
------------
* Python 3.11 or 3.12 (same version you used for development)
* The project virtual environment must be activated and all dependencies
  installed (including dlib-bin, face_recognition, playwright).
* Playwright Chromium must already be downloaded:
      playwright install chromium

The script will offer to install/download missing pieces automatically.
"""

from __future__ import annotations

import importlib
import os
import shutil
import subprocess
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent


def _run(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    """Run a subprocess command and stream its output."""
    print(f"  $ {' '.join(args)}")
    result = subprocess.run(list(args), check=check)
    return result


def _pip_install(package: str) -> None:
    _run(sys.executable, "-m", "pip", "install", package)


def _check_import(module: str, pip_name: str | None = None) -> None:
    """Abort with a helpful message if *module* cannot be imported."""
    try:
        importlib.import_module(module)
    except ImportError:
        pkg = pip_name or module
        print(f"\nERROR: Python package '{module}' is not installed.")
        answer = input(f"  Install '{pkg}' now? [y/N] ").strip().lower()
        if answer == "y":
            _pip_install(pkg)
            try:
                importlib.import_module(module)
            except ImportError:
                print(f"ERROR: Still cannot import '{module}'. Aborting.")
                sys.exit(1)
        else:
            print("Aborting.")
            sys.exit(1)


# ---------------------------------------------------------------------------
# Step 1: Verify required packages
# ---------------------------------------------------------------------------

def check_prerequisites() -> None:
    print("\n[1/5] Checking prerequisites...")

    _check_import("PyInstaller", "pyinstaller")
    _check_import("playwright", "playwright")
    _check_import("face_recognition", "face_recognition")
    _check_import("face_recognition_models", "face_recognition_models")
    _check_import("dlib", "dlib-bin")

    print("      All required packages are present.")


# ---------------------------------------------------------------------------
# Step 2: Find Playwright Chromium browser directory
# ---------------------------------------------------------------------------

def find_playwright_chromium() -> Path:
    """
    Return the path to the installed Playwright Chromium browser directory.

    Playwright stores browsers under $PLAYWRIGHT_BROWSERS_PATH (defaults to
    %LOCALAPPDATA%\\ms-playwright on Windows).  We locate the chromium-* folder
    inside that directory.
    """
    print("\n[2/5] Locating Playwright Chromium browser...")

    # Ask playwright for its browser path via the CLI
    try:
        result = subprocess.run(
            [sys.executable, "-m", "playwright", "install", "--dry-run", "chromium"],
            capture_output=True,
            text=True,
            check=False,
        )
        # Parse the browser directory from playwright's output
        for line in (result.stdout + result.stderr).splitlines():
            if "chromium" in line.lower() and os.sep in line:
                candidate = Path(line.strip().split()[-1])
                if candidate.is_dir():
                    return candidate
    except Exception:
        pass

    # Fallback: check the default ms-playwright location
    default_base_dirs = [
        Path(os.environ.get("PLAYWRIGHT_BROWSERS_PATH", "")),
        Path(os.environ.get("LOCALAPPDATA", "")) / "ms-playwright",
        Path.home() / ".cache" / "ms-playwright",  # Linux/macOS fallback
    ]

    for base in default_base_dirs:
        if not base or not base.is_dir():
            continue
        for child in base.iterdir():
            if child.is_dir() and child.name.startswith("chromium"):
                print(f"      Found Chromium at: {child}")
                return child

    # Browser not downloaded yet — offer to download it
    print("      Chromium not found. Downloading now...")
    _run(sys.executable, "-m", "playwright", "install", "chromium")

    # Try again after download
    for base in default_base_dirs:
        if not base or not base.is_dir():
            continue
        for child in base.iterdir():
            if child.is_dir() and child.name.startswith("chromium"):
                print(f"      Chromium downloaded to: {child}")
                return child

    print("ERROR: Could not locate Playwright Chromium browser after download.")
    sys.exit(1)


# ---------------------------------------------------------------------------
# Step 3: Find face_recognition model files
# ---------------------------------------------------------------------------

def find_face_recognition_models() -> Path:
    """Return the directory containing the pre-trained .dat model files."""
    print("\n[3/5] Locating face_recognition model files...")

    import face_recognition_models  # noqa: PLC0415  (imported after check)

    models_dir = Path(face_recognition_models.face_recognition_model_location()).parent
    print(f"      Models directory: {models_dir}")
    return models_dir


# ---------------------------------------------------------------------------
# Step 4: Build the exe
# ---------------------------------------------------------------------------

def build_exe(chromium_dir: Path, models_dir: Path) -> None:
    print("\n[4/5] Running PyInstaller...")

    runtime_hook = str(ROOT / "_runtime_hooks.py")

    # --add-data format on Windows uses semicolon as separator
    sep = ";" if sys.platform == "win32" else ":"

    pyinstaller_args = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        # Output
        "--name", "StoryparkSync",
        "--distpath", str(ROOT / "dist"),
        "--workpath", str(ROOT / "build"),
        "--specpath", str(ROOT / "build"),
        # Packaging style
        "--onefile",
        "--windowed",
        # Runtime hook must run before any app code
        "--runtime-hook", runtime_hook,
        # Hidden imports that PyInstaller's static analysis misses
        "--hidden-import", "face_recognition",
        "--hidden-import", "face_recognition_models",
        "--hidden-import", "dlib",
        "--hidden-import", "PIL",
        "--hidden-import", "piexif",
        "--hidden-import", "keyring",
        "--hidden-import", "keyring.backends",
        "--hidden-import", "keyring.backends.Windows",
        "--hidden-import", "google.auth",
        "--hidden-import", "google_auth_oauthlib",
        "--hidden-import", "playwright",
        "--hidden-import", "playwright.sync_api",
        # Collect face_recognition_models data (.dat files)
        "--collect-data", "face_recognition_models",
        # Collect all playwright internal files (driver stubs, etc.)
        "--collect-all", "playwright",
        # Bundle the Chromium browser directory
        "--add-data", f"{chromium_dir}{sep}playwright_browsers/{chromium_dir.name}",
        # Entry point
        str(ROOT / "gui.py"),
    ]

    _run(*pyinstaller_args)


# ---------------------------------------------------------------------------
# Step 5: Report result
# ---------------------------------------------------------------------------

def report_result() -> None:
    print("\n[5/5] Build complete!")
    exe = ROOT / "dist" / "StoryparkSync.exe"
    if exe.exists():
        size_mb = exe.stat().st_size / (1024 * 1024)
        print(f"\n  ✓  StoryparkSync.exe  ({size_mb:.1f} MB)")
        print(f"     Location: {exe}")
        print()
        print("  To distribute: copy StoryparkSync.exe to the parent's PC.")
        print("  They also need client_secret.json in the same folder as the exe.")
    else:
        print("\n  WARNING: dist/StoryparkSync.exe was not found.")
        print("  Check the PyInstaller output above for errors.")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    print("=" * 60)
    print("  StoryparkSync.exe – PyInstaller Build Script")
    print("=" * 60)

    if sys.platform != "win32":
        print(
            "\nWARNING: This script is intended to run on Windows.\n"
            "Building on another platform will not produce a Windows exe.\n"
        )

    check_prerequisites()
    chromium_dir = find_playwright_chromium()
    models_dir = find_face_recognition_models()
    build_exe(chromium_dir, models_dir)
    report_result()


if __name__ == "__main__":
    main()
