#!/usr/bin/env bash
# install_rpi.sh – One-click installer for Raspberry Pi (and Debian/Ubuntu Linux)
#
# Usage:
#   chmod +x install_rpi.sh
#   ./install_rpi.sh
#
# What it does:
#   1. Updates the system package list
#   2. Installs build tools, CMake, and OpenBLAS (needed to compile dlib)
#   3. Creates a Python virtual environment in ./venv
#   4. Installs all Python dependencies (pip install -r requirements.txt)
#      Note: dlib compilation takes 15-40 minutes on a Pi 4 – this is normal.
#   5. Installs the Playwright Chromium browser

set -e   # Exit immediately if any command fails

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Colour helpers ────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
info()    { echo -e "${CYAN}[INFO]${RESET}  $*"; }
success() { echo -e "${GREEN}[OK]${RESET}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error()   { echo -e "${RED}[ERROR]${RESET} $*"; exit 1; }

echo
echo -e "${BOLD}============================================================${RESET}"
echo -e "${BOLD}  Storypark Photo Sync – Raspberry Pi Installer${RESET}"
echo -e "${BOLD}============================================================${RESET}"
echo
echo "  This installer will set up everything needed to run the app."
echo "  The face recognition step takes 15–40 minutes to compile on a Pi 4."
echo "  Please keep this terminal open and do not restart the Pi."
echo
read -r -p "  Press ENTER to start... "
echo

# ── 1. System packages ────────────────────────────────────────────────────────
info "[1/5] Installing system packages (requires sudo)..."

sudo apt-get update -qq

sudo apt-get install -y \
    python3 \
    python3-pip \
    python3-venv \
    build-essential \
    cmake \
    libopenblas-dev \
    liblapack-dev \
    libx11-dev \
    libgtk-3-dev \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libjpeg-dev \
    libpng-dev \
    git

success "System packages installed."

# ── 2. Check Python version ───────────────────────────────────────────────────
info "[2/5] Checking Python version..."

PYTHON=$(command -v python3 || command -v python)
PY_VERSION=$("$PYTHON" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$("$PYTHON" -c "import sys; print(sys.version_info.major)")
PY_MINOR=$("$PYTHON" -c "import sys; print(sys.version_info.minor)")

if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 10 ]; }; then
    error "Python 3.10 or later is required. Found $PY_VERSION.
       On older Pi OS versions, install it with:
         sudo apt install python3.11
       Or update to Raspberry Pi OS Bookworm (64-bit)."
fi

success "Python $PY_VERSION found."

# ── 3. Virtual environment ────────────────────────────────────────────────────
info "[3/5] Setting up Python virtual environment..."

if [ -f "venv/bin/python" ]; then
    warn "Virtual environment already exists – skipping creation."
else
    "$PYTHON" -m venv venv
    success "Virtual environment created."
fi

# Activate for the rest of the script
# shellcheck source=/dev/null
source venv/bin/activate

python -m pip install --upgrade pip --quiet
success "pip upgraded."

# ── 4. Python dependencies ────────────────────────────────────────────────────
info "[4/5] Installing Python dependencies..."
echo
echo "  ⚠  The 'dlib' library compiles from source."
echo "     On a Raspberry Pi 4 this takes 15–40 minutes. This is normal."
echo "     You can leave this running and come back later."
echo

pip install -r requirements.txt

success "Python dependencies installed."

# ── 5. Playwright browser ─────────────────────────────────────────────────────
info "[5/5] Installing Playwright Chromium browser..."

playwright install chromium
playwright install-deps chromium

success "Playwright browser installed."

# ── Final checks ──────────────────────────────────────────────────────────────

echo
echo -e "${BOLD}============================================================${RESET}"
echo -e "${GREEN}${BOLD}  Installation complete!${RESET}"
echo -e "${BOLD}============================================================${RESET}"
echo

if [ ! -f "client_secret.json" ]; then
    echo -e "${YELLOW}  IMPORTANT: client_secret.json is missing!${RESET}"
    echo
    echo "  Before using the app you need to:"
    echo "  1. Follow the Google Cloud setup in RASPBERRY_PI.md"
    echo "  2. Copy client_secret.json into this folder:"
    echo "     $SCRIPT_DIR/client_secret.json"
    echo
else
    echo -e "${GREEN}  client_secret.json found – ready to go!${RESET}"
    echo
fi

echo "  To start the app, run:"
echo "    ./run_rpi.sh"
echo
echo "  Or add a cron job for automatic nightly syncs:"
echo "    crontab -e"
echo "    # Add this line (runs at 2:00 AM every day):"
echo "    0 2 * * * $SCRIPT_DIR/venv/bin/python $SCRIPT_DIR/main.py >> $SCRIPT_DIR/pipeline.log 2>&1"
echo
