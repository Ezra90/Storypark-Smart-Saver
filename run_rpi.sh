#!/usr/bin/env bash
# run_rpi.sh – Launcher for Storypark Photo Sync on Raspberry Pi / Linux
#
# Usage:
#   ./run_rpi.sh          Opens the GUI
#   ./run_rpi.sh --cli    Runs the pipeline headlessly (no GUI, for cron jobs)
#
# Run install_rpi.sh first if you have not set up the app yet.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Check the virtual environment exists
if [ ! -f "venv/bin/python" ]; then
    echo
    echo "  Virtual environment not found."
    echo "  Please run ./install_rpi.sh first."
    echo
    exit 1
fi

# Warn if client_secret.json is missing (non-fatal – let the app handle it)
if [ ! -f "client_secret.json" ]; then
    echo
    echo "  WARNING: client_secret.json not found."
    echo "  Google Photos connection will fail until you place it here:"
    echo "    $SCRIPT_DIR/client_secret.json"
    echo "  See RASPBERRY_PI.md for instructions."
    echo
    sleep 3
fi

# Activate the virtual environment
# shellcheck source=/dev/null
source venv/bin/activate

# CLI mode (used by cron jobs and headless servers)
if [ "$1" = "--cli" ]; then
    python main.py
    exit $?
fi

# GUI mode – try to launch the graphical interface
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    python gui.py
else
    echo
    echo "  No display detected (DISPLAY and WAYLAND_DISPLAY are not set)."
    echo "  Running in CLI mode instead..."
    echo "  To use the GUI, connect a monitor or use  ssh -X  when connecting."
    echo
    python main.py
fi
