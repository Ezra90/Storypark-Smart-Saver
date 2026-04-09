# Raspberry Pi Setup Guide – Storypark Photo Pipeline

A Raspberry Pi is the ideal "set and forget" device for this pipeline.  Leave it plugged in at home, and it automatically syncs new Storypark photos to Google Photos every night while you sleep – no need to keep a laptop running.

---

## Which Raspberry Pi should I use?

| Model | Verdict | Notes |
|-------|---------|-------|
| **Pi 5 (4 GB or 8 GB)** | ✅ Best choice | Fast enough for face recognition to complete in minutes |
| **Pi 4 (4 GB)** | ✅ Works well | Face recognition takes longer (~2–5 min per photo batch) |
| **Pi 4 (2 GB)** | ⚠️ Borderline | May run out of RAM with large photo batches; use 1 GB swap |
| **Pi 3B+** | ⚠️ Slow | Works but face recognition is very slow; not recommended |
| **Pi Zero / Zero 2 W** | ❌ Too slow | Insufficient RAM and CPU for `dlib` and Playwright |

> **Recommended minimum:** Raspberry Pi 4 with 4 GB RAM running **Raspberry Pi OS (64-bit)**.

---

## Quick start (recommended)

1. [Flash Raspberry Pi OS](#1-flash-the-operating-system) (64-bit, not Lite).
2. Boot the Pi and connect to the internet.
3. Clone the project and **run `./install_rpi.sh`** – installs all dependencies automatically.  
   *(The dlib compilation step takes 15–40 minutes – this is normal.)*
4. Follow the [Google Cloud credentials](#8-set-up-google-cloud-credentials) steps and copy `client_secret.json` to the project folder.
5. **Run `./run_rpi.sh`** – opens the graphical app.  
   Click **⚙ Settings** to run the setup wizard (one time only), then **▶ Sync Photos Now**.
6. Set up a daily cron job so the sync runs automatically every night.

---

## Table of contents

1. [Flash the operating system](#1-flash-the-operating-system)
2. [First boot and basic setup](#2-first-boot-and-basic-setup)
3. [Install system dependencies](#3-install-system-dependencies)
4. [Download the project](#4-download-the-project)
5. [Create a virtual environment](#5-create-a-virtual-environment)
6. [Install Python dependencies](#6-install-python-dependencies)
7. [Install the Playwright browser](#7-install-the-playwright-browser)
8. [Set up Google Cloud credentials](#8-set-up-google-cloud-credentials)
9. [Run the setup wizard](#9-run-the-setup-wizard)
10. [Run the pipeline](#10-run-the-pipeline)
11. [Automate daily runs with cron](#11-automate-daily-runs-with-cron)
12. [Optional – run headlessly over SSH](#12-optional--run-headlessly-over-ssh)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Flash the operating system

1. Download **[Raspberry Pi Imager](https://www.raspberrypi.com/software/)** on your computer.
2. Insert a microSD card (32 GB or larger recommended).
3. Open Raspberry Pi Imager:
   - **Device**: choose your Pi model
   - **OS**: choose **Raspberry Pi OS (64-bit)** *(not Lite – you need a desktop for the Google OAuth browser window during setup)*
   - **Storage**: choose your SD card
4. Click **Next**, then click **Edit Settings** (⚙️) to pre-configure:
   - Set a **hostname** (e.g. `storypark-pi`)
   - Enable **SSH**
   - Set a **username and password**
   - Enter your **Wi-Fi network name and password**
5. Click **Save → Yes → Yes** to write the image.
6. Insert the SD card into the Pi and power it on.

---

## 2. First boot and basic setup

Connect a monitor and keyboard for the first boot, or SSH in from another computer once the Pi has joined Wi-Fi:

```bash
ssh pi@storypark-pi.local
```

Update the system:

```bash
sudo apt update && sudo apt upgrade -y
```

Expand the swap file (important for Pi 4 2 GB and recommended for all models when running face recognition):

```bash
sudo dphys-swapfile swapoff
sudo nano /etc/dphys-swapfile
```

Change `CONF_SWAPSIZE=100` to `CONF_SWAPSIZE=1024`, then:

```bash
sudo dphys-swapfile setup
sudo dphys-swapfile swapon
```

---

## 3. Install system dependencies

`dlib` and `face_recognition` need several system libraries to compile and run:

```bash
sudo apt install -y \
    python3 python3-pip python3-venv \
    build-essential cmake \
    libopenblas-dev liblapack-dev \
    libx11-dev libgtk-3-dev \
    git
```

> **Why these packages?**
> - `build-essential` + `cmake` – compile `dlib`
> - `libopenblas-dev` + `liblapack-dev` – fast linear algebra for face recognition (much faster than plain C)
> - `libx11-dev` + `libgtk-3-dev` – needed by Playwright's Chromium browser

---

## 4. Download the project

```bash
git clone https://github.com/Ezra90/Storypark-Scraper.git
cd Storypark-Scraper
```

---

## 5. Create a virtual environment

```bash
python3 -m venv venv
source venv/bin/activate
```

Your prompt will now show `(venv)`.  You need to run `source venv/bin/activate` again each time you open a new terminal session.

---

## 6. Install Python dependencies

Upgrade pip first, then install.  The `dlib` compilation step takes **15–40 minutes** on a Pi 4 – this is normal.  Go make a coffee. ☕

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

---

## 7. Install the Playwright browser

```bash
playwright install chromium
playwright install-deps chromium
```

The second command installs the system libraries Chromium needs on Linux.

---

## 8. Set up Google Cloud credentials

Follow the exact same steps as in the [main README](README.md#2--set-up-google-cloud-credentials).

Once you have `client_secret.json`, copy it to the Pi.  The easiest way is `scp` from your regular computer:

```bash
# Run this on your computer, not the Pi
scp /path/to/client_secret.json pi@storypark-pi.local:~/Storypark-Scraper/
```

Or plug a USB drive into the Pi and copy from there.

---

## 9. Run the setup wizard

The setup wizard needs a browser window to open for Google authorisation.  You have two options:

### Option A – Run directly on the Pi desktop (easiest)

Connect a monitor (or use VNC) and run the wizard from a terminal on the Pi desktop:

```bash
cd ~/Storypark-Scraper
source venv/bin/activate
python setup.py
```

A Chromium window will open on the Pi's desktop for the Google login step.

### Option B – Run with SSH and X11 forwarding

If you want to do everything from your computer over SSH:

```bash
# On your computer:
ssh -X pi@storypark-pi.local

# On the Pi (inside the SSH session):
cd ~/Storypark-Scraper
source venv/bin/activate
python setup.py
```

The `-X` flag forwards the browser window to your computer's display.

> **macOS users**: Install [XQuartz](https://www.xquartz.org/) first and use `ssh -Y` instead of `ssh -X`.

The wizard steps are the same as described in the [main README](README.md#3--run-the-setup-wizard).  Your Storypark password is stored in the Pi's **Linux Secret Service keychain** (provided by `libsecret`) and is never written to a file.

---

## 10. Run the pipeline

**With the graphical app:**

```bash
./run_rpi.sh
```

This opens the GUI.  Click **▶ Sync Photos Now** to start.

**Headless / CLI mode** (for cron jobs or SSH sessions without a display):

```bash
./run_rpi.sh --cli
# or directly:
source venv/bin/activate && python main.py
```

The first run processes all historical Storypark posts and may take **1–3 hours** depending on how many posts exist and your Pi model.  Subsequent daily runs typically take **2–10 minutes**.

---

## 11. Automate daily runs with cron

`cron` is the Linux equivalent of Windows Task Scheduler.

Open the crontab editor:

```bash
crontab -e
```

If prompted to choose an editor, pick **nano** (option 1).

Add this line at the bottom of the file to run the pipeline every day at **2:00 AM**:

```cron
0 2 * * * /home/pi/Storypark-Scraper/run_rpi.sh --cli >> /home/pi/Storypark-Scraper/pipeline.log 2>&1
```

> ⚠️ Replace `pi` with your actual Pi username if you chose a different one during setup.

Save and exit (in nano: `Ctrl+O`, `Enter`, `Ctrl+X`).

**Understanding the schedule format** (`0 2 * * *`):

```
┌── minute (0–59)
│  ┌── hour (0–23)
│  │  ┌── day of month (1–31)
│  │  │  ┌── month (1–12)
│  │  │  │  ┌── day of week (0–7, 0=Sunday)
│  │  │  │  │
0  2  *  *  *   →  every day at 2:00 AM
```

To change the time, adjust the hour and minute.  For example, `30 7 * * *` runs at 7:30 AM.

Verify the cron job is registered:

```bash
crontab -l
```

---

## 12. Optional – run headlessly over SSH

Once setup is complete, all pipeline runs (`python main.py`) work in headless mode with no monitor needed.  The Pi can sit in a drawer or on a shelf and be managed entirely via SSH.

To check on a running job or view logs from your computer:

```bash
# Live log output
ssh pi@storypark-pi.local "tail -f ~/Storypark-Scraper/pipeline.log"

# See last 50 lines
ssh pi@storypark-pi.local "tail -50 ~/Storypark-Scraper/pipeline.log"
```

---

## 13. Troubleshooting

### `dlib` compilation fails or takes forever

Make sure you installed all system dependencies in [Section 3](#3-install-system-dependencies), especially `libopenblas-dev`.  If it still fails:

```bash
# Try installing with more verbose output to see the exact error
pip install dlib -v
```

If compilation keeps failing, force a single-threaded build (uses less RAM):

```bash
pip install dlib --global-option="build_ext" --global-option="--no-dlib_all"
```

### Out of memory during face recognition

Increase swap as described in [Section 2](#2-first-boot-and-basic-setup) and re-run.  You can also reduce batch size by setting `MAX_POSTS = 50` in `config.py` so the pipeline processes posts in smaller chunks across multiple runs.

### Playwright: "Host system is missing dependencies"

Run:

```bash
playwright install-deps chromium
```

### Google OAuth browser window won't open over SSH

You must use `ssh -X` (or `ssh -Y`) and have a working X11 display.  Alternatively:

1. Complete the setup wizard once while physically at the Pi (connected to a monitor).
2. After that, the token is cached in `token.json` and `pipeline.py` runs headlessly over SSH without needing a browser.

### Keyring / Secret Service not available

On a Pi without a desktop session running, `keyring` may fall back to a plaintext backend.  Fix by installing the `libsecret` keyring backend:

```bash
pip install secretstorage dbus-python
```

If you are running the pipeline via cron (no desktop session), set the `DBUS_SESSION_BUS_ADDRESS` environment variable in the crontab so `keyring` can access the secret service:

```cron
0 2 * * * DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus /home/pi/Storypark-Scraper/venv/bin/python /home/pi/Storypark-Scraper/main.py >> /home/pi/Storypark-Scraper/pipeline.log 2>&1
```

*(Replace `1000` with the output of `id -u` on your Pi.)*

### Cron job runs but produces no output

Test the exact command cron would run by pasting it directly into your terminal.  Also check that all paths use the **full absolute path** (no `~` shorthand – cron does not expand it).

### The Pi loses time after a reboot

The Pi does not have a real-time clock.  Add `fake-hwclock` or connect the Pi to the internet (NTP will sync time automatically within ~30 seconds of boot):

```bash
sudo apt install -y fake-hwclock
```
