"""
_runtime_hooks.py – PyInstaller runtime hook for StoryparkSync.exe

This file is executed by the PyInstaller bootloader immediately after the
frozen application starts, before any application code runs.  It patches
environment variables so that Playwright and face_recognition can locate
their bundled assets inside sys._MEIPASS (the PyInstaller temp extraction
directory).
"""

import os
import sys

if getattr(sys, "frozen", False):
    base = sys._MEIPASS  # type: ignore[attr-defined]

    # Tell Playwright where to find the bundled Chromium browser.
    # build_exe.py bundles the browser under playwright_browsers/ inside the exe.
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = os.path.join(base, "playwright_browsers")

    # Tell face_recognition where to find the pre-trained .dat model files.
    # build_exe.py bundles them under face_recognition_models/ inside the exe.
    os.environ["FACE_RECOGNITION_MODELS"] = os.path.join(base, "face_recognition_models")
