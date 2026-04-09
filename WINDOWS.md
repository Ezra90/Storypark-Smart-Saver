# Windows Setup Guide – Storypark Photo Pipeline

This guide walks Windows users through every step from a blank PC to a fully running pipeline.  The main README covers the general overview; this document focuses entirely on Windows-specific commands, tools, and gotchas.

---

## Quick start (recommended)

1. [Download the project](#5-download-the-project) and open the folder.
2. **Double-click `install_windows.bat`** – installs Python, CMake, build tools, and all dependencies automatically.
3. Follow the [Google Cloud credentials](#9-set-up-google-cloud-credentials) steps and save `client_secret.json` in the project folder.
4. **Double-click `run_windows.bat`** – opens the graphical app.
5. Click **⚙ Settings** to run the setup wizard (one time only), then **▶ Sync Photos Now**.

> The installer handles everything automatically using Windows Package Manager (winget).  
> If it fails at any step, the detailed manual steps below explain what to do.

---

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Install Python](#2-install-python)
3. [Install C++ Build Tools (required for face recognition)](#3-install-c-build-tools)
4. [Install CMake](#4-install-cmake)
5. [Download the project](#5-download-the-project)
6. [Create a virtual environment](#6-create-a-virtual-environment)
7. [Install Python dependencies](#7-install-python-dependencies)
8. [Install the Playwright browser](#8-install-the-playwright-browser)
9. [Set up Google Cloud credentials](#9-set-up-google-cloud-credentials)
10. [Run the setup wizard](#10-run-the-setup-wizard)
11. [Run the pipeline](#11-run-the-pipeline)
12. [Automate daily runs with Task Scheduler](#12-automate-daily-runs-with-task-scheduler)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Prerequisites

Before you start, make sure you have:

- A Windows 10 or Windows 11 PC (64-bit)
- An internet connection
- Your **Storypark** email and password
- A **Google account** that contains your children's photos
- The **`client_secret.json`** file from Google Cloud Console  
  *(see [Section 9](#9-set-up-google-cloud-credentials) if you have not created this yet)*

---

## 2. Install Python

1. Go to **[python.org/downloads](https://www.python.org/downloads/)** and download the latest **Python 3.12** (or 3.10+) Windows installer.
2. Run the installer.
3. ✅ **Tick "Add Python to PATH"** on the first screen – this is critical.
4. Click **Install Now**.

Verify the install by opening **Command Prompt** (press `Win + R`, type `cmd`, press Enter) and running:

```cmd
python --version
```

You should see something like `Python 3.12.x`.

---

## 3. Install C++ Build Tools

The `face_recognition` library uses `dlib` under the hood, and `dlib` must be compiled from source on Windows.  This requires the Microsoft C++ compiler.

1. Go to **[visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)** and click **Download Build Tools**.
2. Run the installer (`vs_buildtools.exe`).
3. In the **Workloads** tab, tick **"Desktop development with C++"**.
4. Click **Install** (the download is about 2–4 GB).
5. **Restart your PC** after installation completes.

> **Why is this needed?**  
> `dlib` is a C++ library.  `pip` compiles it on your machine when you run `pip install dlib`, and it needs the Microsoft C++ compiler to do that.

---

## 4. Install CMake

`dlib` also needs CMake during its build process.

1. Go to **[cmake.org/download](https://cmake.org/download/)** and download the latest **Windows x64 Installer** (`.msi` file).
2. Run the installer.
3. On the **Install Options** screen, choose **"Add CMake to the system PATH for all users"** (or for the current user).
4. Complete the install.

Verify in a **new** Command Prompt:

```cmd
cmake --version
```

You should see `cmake version 3.x.x`.

---

## 5. Download the project

**Option A – with Git** (recommended)

If you have [Git for Windows](https://git-scm.com/download/win) installed:

```cmd
git clone https://github.com/Ezra90/Storypark-Scraper.git
cd Storypark-Scraper
```

**Option B – without Git**

1. Go to the repository page on GitHub.
2. Click the green **Code** button → **Download ZIP**.
3. Extract the ZIP to a folder such as `C:\Users\YourName\Storypark-Scraper`.
4. Open Command Prompt and navigate to that folder:

```cmd
cd C:\Users\YourName\Storypark-Scraper
```

---

## 6. Create a virtual environment

A virtual environment keeps this project's dependencies separate from other Python programs on your PC.

```cmd
python -m venv venv
```

**Activate** the environment (you need to do this every time you open a new Command Prompt window):

```cmd
venv\Scripts\activate
```

Your prompt will change to show `(venv)` at the start.  All `pip` and `python` commands from here on run inside this environment.

> **PowerShell users:** If you use PowerShell instead of Command Prompt, you may need to first run:
> ```powershell
> Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
> ```
> Then activate with:
> ```powershell
> venv\Scripts\Activate.ps1
> ```

---

## 7. Install Python dependencies

First, upgrade pip itself:

```cmd
python -m pip install --upgrade pip
```

Then install all project dependencies.  The `dlib` compilation step takes **5–15 minutes** – this is normal.

```cmd
pip install -r requirements.txt
```

If `dlib` fails to compile, see [Troubleshooting → dlib will not install](#dlib-will-not-install).

---

## 8. Install the Playwright browser

Playwright needs to download a copy of Chromium:

```cmd
playwright install chromium
```

---

## 9. Set up Google Cloud credentials

You need an OAuth 2.0 client secret so the pipeline can access your Google Photos library.

1. Go to **[console.cloud.google.com](https://console.cloud.google.com)** and sign in with the Google account that has your children's photos.
2. Click **Select a project → New Project**.  Name it anything (e.g. `Storypark Scraper`).
3. In the left menu go to **APIs & Services → Library**.  Search for **"Google Photos Library API"** and click **Enable**.
4. Go to **APIs & Services → OAuth consent screen**.
   - User type: **External**
   - App name: `Storypark Scraper`
   - Fill in your email for both required email fields
   - Click **Save and continue** through the scopes screen (no extra scopes needed here)
   - On the **Test users** screen, click **Add users** and add your own Google email address
   - Click **Save and continue**
5. Go to **APIs & Services → Credentials**.
   - Click **Create credentials → OAuth client ID**
   - Application type: **Desktop app**
   - Name: `Storypark Scraper Desktop`
   - Click **Create**
6. Click the **download icon** (⬇) next to the new credential to download the JSON file.
7. **Rename the file to `client_secret.json`** and copy it into the project folder  
   (e.g. `C:\Users\YourName\Storypark-Scraper\client_secret.json`).

---

## Run the setup wizard

```cmd
python setup.py
```

Or simply double-click `run_windows.bat` to open the graphical app and click **⚙ Settings**.

The wizard walks you through five steps:

| Step | What happens |
|------|-------------|
| **1 – Storypark account** | Enter your Storypark email and password.  The password is saved in **Windows Credential Manager** (not in any file). |
| **2 – Google Photos** | Your default browser opens automatically.  Sign in and click **Allow**. |
| **3 – Your children** | The wizard lists all your Google Photos albums.  Pick the album with the most photos of each child.  It downloads samples and builds face encodings automatically. |
| **4 – Daycare GPS** | Open [Google Maps](https://maps.google.com), find the daycare, right-click it → **"What's here?"** and copy the latitude and longitude shown at the bottom of the screen. |
| **5 – Options** | Choose headless mode (recommended: **Y**) and post limit (use `10` for your first test, then `0` for unlimited). |

Setup creates two files in the project folder:

- `config.py` – all settings except the password
- `face_encodings.pkl` – face encodings for each child

You only need to run setup once.

---

## 11. Run the pipeline

**With the graphical app:**

```cmd
run_windows.bat
```

Double-click this file to open the app, then click **▶ Sync Photos Now**.

**From the command line:**

With the virtual environment active:

```cmd
python main.py
```

**First run** – Playwright opens Storypark, scrolls all the way back through the entire history, downloads every photo, filters for your children, stamps the EXIF data, and uploads to Google Photos.  Depending on how many posts are on Storypark this could take **30–90 minutes**.

**Subsequent runs** – the pipeline detects where it left off and only processes new posts.  A daily run typically completes in a few minutes.

Progress is printed to the console and also saved in `pipeline.log`.

---

## 12. Automate daily runs with Task Scheduler

Windows Task Scheduler can run the pipeline automatically every day.

### Step-by-step

1. Press `Win + S`, search for **"Task Scheduler"**, and open it.
2. In the right-hand **Actions** panel, click **Create Basic Task…**
3. **Name**: `Storypark Photo Pipeline`  
   **Description**: `Daily Storypark photo sync`  
   Click **Next**.
4. **Trigger**: Choose **Daily**, click **Next**.  
   Set a start time (e.g. 7:00 AM), click **Next**.
5. **Action**: Choose **Start a program**, click **Next**.
6. Fill in the fields:
   - **Program/script**:  
     ```
     C:\Users\YourName\Storypark-Scraper\venv\Scripts\python.exe
     ```
     *(replace `YourName` with your actual Windows username)*
   - **Add arguments**:  
     ```
     main.py
     ```
   - **Start in**:  
     ```
     C:\Users\YourName\Storypark-Scraper
     ```
7. Click **Next**, then **Finish**.
8. Right-click the new task → **Properties** → **Conditions** tab:  
   - Untick **"Start the task only if the computer is on AC power"** if you use a laptop.
9. Click **OK**.

To test it, right-click the task → **Run**.  Check `pipeline.log` in the project folder to confirm it worked.

---

## 13. Troubleshooting

### `python` is not recognised

The Python installer did not add Python to your PATH.  Fix it:

1. Open **Settings → System → About → Advanced system settings → Environment Variables**.
2. Under **User variables**, find `Path`, click **Edit**.
3. Click **New** and add: `C:\Users\YourName\AppData\Local\Programs\Python\Python312`  
   (adjust the version number to match what you installed).
4. Add another entry: `C:\Users\YourName\AppData\Local\Programs\Python\Python312\Scripts`
5. Click **OK** and restart Command Prompt.

### Virtual environment activation is blocked

```
venv\Scripts\activate : File ... cannot be loaded because running scripts is disabled
```

Open PowerShell **as Administrator** and run:

```powershell
Set-ExecutionPolicy RemoteSigned
```

Then close and reopen your terminal.

### `dlib` will not install

`dlib` compilation can fail if the C++ tools or CMake are not set up correctly.  Try these fixes in order:

**Fix 1 – Try a pre-built wheel**

```cmd
pip install dlib==19.24.2
pip install face_recognition
```

Pre-built wheels for popular Python/Windows versions are often available on PyPI and skip the compilation entirely.

**Fix 2 – Use Conda instead of pip**

Download [Miniconda for Windows](https://docs.conda.io/en/latest/miniconda.html), then:

```cmd
conda create -n storypark python=3.11
conda activate storypark
conda install -c conda-forge dlib
pip install face_recognition
pip install -r requirements.txt
```

When running the pipeline, use the Conda environment instead of the venv:
```cmd
conda activate storypark
python setup.py
python main.py
```

**Fix 3 – Use Windows Subsystem for Linux (WSL 2)**

WSL 2 gives you a full Linux environment on Windows where `dlib` installs without any extra steps.

1. Open PowerShell as Administrator and run:
   ```powershell
   wsl --install
   ```
2. Restart your PC.
3. Open **Ubuntu** from the Start menu and follow the main README (Linux instructions).

### `playwright install chromium` fails or is very slow

Playwright downloads Chromium (~150 MB).  If your antivirus blocks it:

1. Temporarily disable real-time protection.
2. Run `playwright install chromium`.
3. Re-enable protection.

Or manually download Chromium from [playwright.dev/python/docs/browsers](https://playwright.dev/python/docs/browsers).

### Storypark login opens but immediately closes

Set `HEADLESS_BROWSER = False` in `config.py` so you can watch the browser window and see any error messages on-screen.

### Google auth browser window does not open

Ensure you are running from the correct project folder with the virtual environment active, and that `client_secret.json` is present:

```cmd
dir client_secret.json
```

If the file is missing, go back to [Section 9](#9-set-up-google-cloud-credentials).

### `face_encodings.pkl not found`

You need to run the setup wizard first:

```cmd
python setup.py
```

### Where is my Storypark password stored?

Your password is stored in the **Windows Credential Manager** (not in any file).  To see or delete it:

1. Press `Win + S`, search **"Credential Manager"** and open it.
2. Click **Windows Credentials**.
3. Look for an entry named `storypark-scraper`.

### Want to start over and reprocess everything

Delete the state database so the pipeline re-downloads everything:

```cmd
del processed_posts.db
python main.py
```

### The Task Scheduler job runs but does nothing

Open Task Scheduler, find the task, and check the **Last Run Result** column.  A code other than `0x0` means an error occurred.  Right-click the task → **History** to see details.  Also check `pipeline.log` in the project folder.
