"""
gui.py – Graphical launcher for the Storypark Photo Pipeline.

Start via:
  Windows       →  double-click  run_windows.bat
  Raspberry Pi  →  double-click the desktop icon, or run  ./run_rpi.sh
  Any platform  →  python gui.py

No command-line knowledge required.  The GUI provides:
  • A setup wizard that replaces the command-line setup.py
  • A one-click Sync button that runs the full pipeline
  • A live progress bar and log viewer
  • A Settings button to reconfigure at any time
"""

import logging
import os
import pickle
import queue
import sys
import threading
from datetime import datetime
from pathlib import Path
from tkinter import messagebox, scrolledtext, simpledialog
import tkinter as tk
from tkinter import ttk

# ---------------------------------------------------------------------------
# Make sure we can import project modules from the same directory
# ---------------------------------------------------------------------------
APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

# ---------------------------------------------------------------------------
# Route all logging through a queue so the GUI can display it live
# ---------------------------------------------------------------------------
_log_queue: queue.Queue = queue.Queue(maxsize=2000)


class _QueueHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        try:
            _log_queue.put_nowait(self.format(record))
        except queue.Full:
            pass


_q_handler = _QueueHandler()
_q_handler.setFormatter(
    logging.Formatter("%(asctime)s  %(levelname)-8s  %(message)s",
                      datefmt="%H:%M:%S")
)
logging.getLogger().addHandler(_q_handler)
logging.getLogger().setLevel(logging.INFO)


# ---------------------------------------------------------------------------
# Theme
# ---------------------------------------------------------------------------

def _apply_theme(root: tk.Tk) -> None:
    """Apply a clean cross-platform ttk theme."""
    style = ttk.Style(root)
    for preferred in ("vista", "aqua", "clam", "alt", "default"):
        if preferred in style.theme_names():
            style.theme_use(preferred)
            break

    style.configure("Title.TLabel",  font=("Segoe UI", 17, "bold"))
    style.configure("Sub.TLabel",    font=("Segoe UI", 11))
    style.configure("Small.TLabel",  font=("Segoe UI", 9), foreground="#666666")
    style.configure("Sync.TButton",  font=("Segoe UI", 12, "bold"), padding=(16, 10))
    style.configure("Action.TButton", font=("Segoe UI", 10), padding=(10, 6))
    style.configure("Warn.TLabel",   font=("Segoe UI", 10), foreground="#b45309")


# ---------------------------------------------------------------------------
# Helpers shared between the wizard and the main window
# ---------------------------------------------------------------------------

# Must match the service name used in config.py and setup.py
_KEYRING_SERVICE = "storypark-scraper"


def _write_config(data: dict) -> None:
    """Write config.json from the wizard data dict."""
    from config_manager import save_config  # noqa: PLC0415

    children = [c["name"] for c in data.get("children", [])]
    save_config({
        "storypark_email":      data["storypark_email"],
        "children":             children,
        "daycare_latitude":     data["latitude"],
        "daycare_longitude":    data["longitude"],
        "headless_browser":     data["headless"],
        "max_posts":            data["max_posts"],
    })


# ---------------------------------------------------------------------------
# Log viewer window
# ---------------------------------------------------------------------------

class LogViewer(tk.Toplevel):
    """A detached window that shows the live pipeline log."""

    def __init__(self, parent: tk.Widget) -> None:
        super().__init__(parent)
        self.title("Pipeline Log")
        self.geometry("720x460")
        self.minsize(480, 300)

        mono = "Consolas" if sys.platform == "win32" else "Monospace"
        self._text = scrolledtext.ScrolledText(
            self, state="disabled", wrap="word",
            font=(mono, 9),
            bg="#1a1a2a", fg="#d4d4d4",
        )
        self._text.pack(fill="both", expand=True, padx=6, pady=(6, 0))

        btn_row = ttk.Frame(self, padding=(6, 4, 6, 6))
        btn_row.pack(fill="x")
        ttk.Button(btn_row, text="Clear", command=self._clear,
                   style="Action.TButton").pack(side="left")
        ttk.Button(btn_row, text="Close", command=self.destroy,
                   style="Action.TButton").pack(side="right")

        self._load_existing_log()

    def _load_existing_log(self) -> None:
        log_path = APP_DIR / "pipeline.log"
        if log_path.exists():
            try:
                with open(log_path, encoding="utf-8", errors="replace") as fh:
                    self._append(fh.read())
            except OSError:
                pass

    def _append(self, text: str) -> None:
        self._text.config(state="normal")
        self._text.insert("end", text.rstrip() + "\n")
        self._text.see("end")
        self._text.config(state="disabled")

    def _clear(self) -> None:
        self._text.config(state="normal")
        self._text.delete("1.0", "end")
        self._text.config(state="disabled")

    def append_live(self, text: str) -> None:
        """Append a log line; safe to call from any thread via root.after."""
        self._append(text)


# ---------------------------------------------------------------------------
# Setup Wizard
# ---------------------------------------------------------------------------

class SetupWizard(tk.Toplevel):
    """
    Five-step guided setup wizard.

    Steps:
      1. Storypark credentials
      2. Google Photos authorisation
      3. Select albums for each child  (face encodings built in background)
      4. Daycare GPS coordinates
      5. Options (headless, post limit)
    """

    STEP_TITLES = [
        "Storypark Account",
        "Google Photos",
        "Your Children",
        "Daycare Location",
        "Options",
    ]

    def __init__(self, parent: tk.Widget, on_complete) -> None:
        super().__init__(parent)
        self.title("Storypark Photo Sync – Setup")
        self.resizable(False, False)
        self.grab_set()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        self._on_complete = on_complete
        self._step = 0
        self._bg_q: queue.Queue = queue.Queue()

        # Non-sensitive config collected across wizard steps.
        # NOTE: The Storypark password is intentionally NOT stored here –
        # it is held only in the local variable inside _validate_storypark
        # and passed directly to the OS keychain in _finish().
        self._d: dict = {
            "storypark_email": "",
            "google_session":  None,
            "albums":          [],
            "children":        [],   # [{"name": str, "album_idx": int}]
            "latitude":        0.0,
            "longitude":       0.0,
            "headless":        True,
            "max_posts":       0,
        }
        # Password held separately so it never enters the config dict
        self._pending_pw: str = ""

        # Encoding state (built in background during step 4)
        self._encodings_by_child: dict = {}
        self._encodings_ready = False

        self._build_shell()
        self._show_step()
        self._center()

    # ── Window shell (persistent across steps) ────────────────────────────────

    def _build_shell(self) -> None:
        self._hdr = ttk.Frame(self, padding=(22, 16, 22, 4))
        self._hdr.pack(fill="x")

        self._step_lbl = ttk.Label(self._hdr, text="", style="Small.TLabel")
        self._step_lbl.pack(anchor="w")
        self._title_lbl = ttk.Label(self._hdr, text="", style="Title.TLabel")
        self._title_lbl.pack(anchor="w", pady=(2, 0))

        ttk.Separator(self, orient="horizontal").pack(fill="x", padx=22, pady=6)

        self._body = ttk.Frame(self, padding=(22, 4, 22, 4))
        self._body.pack(fill="both", expand=True)

        ttk.Separator(self, orient="horizontal").pack(fill="x", padx=22, pady=6)

        ftr = ttk.Frame(self, padding=(22, 0, 22, 14))
        ftr.pack(fill="x")
        self._back_btn = ttk.Button(ftr, text="← Back", command=self._go_back,
                                    style="Action.TButton")
        self._back_btn.pack(side="left")
        self._next_btn = ttk.Button(ftr, text="Next →", command=self._go_next,
                                    style="Sync.TButton")
        self._next_btn.pack(side="right")

    def _center(self) -> None:
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        w, h = self.winfo_width(), self.winfo_height()
        self.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

    def _on_close(self) -> None:
        if messagebox.askyesno(
            "Cancel Setup",
            "Cancel setup?\n\nThe pipeline won't work until setup is complete.",
            parent=self,
        ):
            self.destroy()

    def _clear_body(self) -> None:
        for w in self._body.winfo_children():
            w.destroy()

    def _show_step(self) -> None:
        n = len(self.STEP_TITLES)
        self._step_lbl.config(text=f"Step {self._step + 1} of {n}")
        self._title_lbl.config(text=self.STEP_TITLES[self._step])
        self._back_btn.config(state="normal" if self._step > 0 else "disabled")
        self._next_btn.config(
            text="Finish  ✓" if self._step == n - 1 else "Next →"
        )
        self._clear_body()
        [
            self._show_storypark,
            self._show_google,
            self._show_children,
            self._show_gps,
            self._show_options,
        ][self._step]()

    def _go_back(self) -> None:
        if self._step > 0:
            self._step -= 1
            self._show_step()

    def _go_next(self) -> None:
        validators = [
            self._validate_storypark,
            self._validate_google,
            self._validate_children,
            self._validate_gps,
            self._finish,
        ]
        validators[self._step]()

    # ── Step 1: Storypark credentials ─────────────────────────────────────────

    def _show_storypark(self) -> None:
        f = self._body
        ttk.Label(f, text="Enter your Storypark login details.",
                  style="Sub.TLabel").pack(anchor="w", pady=(0, 10))

        ttk.Label(f, text="Email address").pack(anchor="w")
        self._email_var = tk.StringVar(value=self._d["storypark_email"])
        ttk.Entry(f, textvariable=self._email_var, width=42).pack(
            anchor="w", pady=(2, 8)
        )

        ttk.Label(f, text="Password").pack(anchor="w")
        self._pw_var = tk.StringVar()
        ttk.Entry(f, textvariable=self._pw_var, show="●", width=42).pack(
            anchor="w", pady=(2, 0)
        )

        ttk.Label(
            f,
            text="Your password is stored securely in the operating system's "
                 "keychain\n– it is never saved to any file.",
            style="Small.TLabel",
        ).pack(anchor="w", pady=(8, 0))

    def _validate_storypark(self) -> None:
        email = self._email_var.get().strip()
        pw = self._pw_var.get()
        if "@" not in email:
            messagebox.showerror("Invalid Email",
                                 "Please enter a valid email address.", parent=self)
            return
        if not pw:
            messagebox.showerror("Missing Password",
                                 "Please enter your Storypark password.", parent=self)
            return
        self._d["storypark_email"] = email
        # Hold password separately – it never enters the config dict.
        # It is passed directly to the OS keychain in _finish().
        self._pending_pw = pw
        self._step += 1
        self._show_step()

    # ── Step 2: Google Photos OAuth ───────────────────────────────────────────

    def _show_google(self) -> None:
        f = self._body
        ttk.Label(
            f,
            text="Click the button below to connect your Google Photos account.\n"
                 "A browser window will open – sign in and click Allow.",
            style="Sub.TLabel",
        ).pack(anchor="w", pady=(0, 12))

        self._g_status = tk.StringVar(
            value="✅  Already connected" if self._d["google_session"] else ""
        )
        self._g_btn = ttk.Button(
            f, text="🔗  Connect Google Photos",
            command=self._do_google_auth, style="Sync.TButton",
        )
        self._g_btn.pack(anchor="w")

        ttk.Label(f, textvariable=self._g_status,
                  style="Sub.TLabel").pack(anchor="w", pady=(10, 0))

        if not Path(APP_DIR / "client_secret.json").exists():
            ttk.Label(
                f,
                text="⚠  client_secret.json not found in the project folder.\n"
                     "   See the README for instructions on creating it.",
                style="Warn.TLabel",
            ).pack(anchor="w", pady=(10, 0))

    def _do_google_auth(self) -> None:
        self._g_btn.config(state="disabled")
        self._g_status.set("🔄  Opening browser – please sign in…")

        def worker() -> None:
            try:
                import google_photos as gp
                creds = gp.get_credentials()
                session = gp.make_session(creds)
                albums = gp.list_albums(session)
                self._bg_q.put(("google_ok", session, albums))
            except Exception as exc:
                self._bg_q.put(("google_err", str(exc)))

        threading.Thread(target=worker, daemon=True).start()
        self._poll_google()

    def _poll_google(self) -> None:
        try:
            msg = self._bg_q.get_nowait()
        except queue.Empty:
            self.after(200, self._poll_google)
            return

        if msg[0] == "google_ok":
            _, session, albums = msg
            self._d["google_session"] = session
            self._d["albums"] = albums
            self._g_status.set(f"✅  Connected – {len(albums)} album(s) found")
        else:
            self._g_btn.config(state="normal")
            self._g_status.set(f"❌  Error: {msg[1]}")
            messagebox.showerror("Google Auth Failed", msg[1], parent=self)

    def _validate_google(self) -> None:
        if not self._d["google_session"]:
            messagebox.showerror(
                "Not Connected",
                "Please connect your Google Photos account first.",
                parent=self,
            )
            return
        self._step += 1
        self._show_step()

    # ── Step 3: Children + albums ─────────────────────────────────────────────

    def _show_children(self) -> None:
        f = self._body
        ttk.Label(
            f,
            text="Select a Google Photos album for each child.\n"
                 "Choose an album with lots of clear, close-up photos of their face.",
            style="Sub.TLabel",
        ).pack(anchor="w", pady=(0, 10))

        count_row = ttk.Frame(f)
        count_row.pack(anchor="w", pady=(0, 8))
        ttk.Label(count_row, text="Number of children:").pack(side="left")
        self._child_count = ttk.Spinbox(count_row, from_=1, to=10, width=4)
        self._child_count.pack(side="left", padx=6)
        self._child_count.set(max(1, len(self._d["children"])))
        ttk.Button(
            count_row, text="Update rows",
            command=self._rebuild_child_rows, style="Action.TButton",
        ).pack(side="left")

        self._child_rows_frame = ttk.Frame(f)
        self._child_rows_frame.pack(fill="x")
        self._child_row_vars: list[tuple[tk.StringVar, tk.StringVar]] = []
        self._rebuild_child_rows()

    def _rebuild_child_rows(self) -> None:
        for w in self._child_rows_frame.winfo_children():
            w.destroy()
        self._child_row_vars = []

        try:
            n = int(self._child_count.get())
        except ValueError:
            n = 1

        album_names = [
            a.get("title", f"Album {i + 1}")
            for i, a in enumerate(self._d["albums"])
        ]

        ttk.Label(self._child_rows_frame,
                  text="  Name                Album with their photos",
                  style="Small.TLabel").pack(anchor="w", pady=(0, 2))

        for i in range(n):
            row = ttk.Frame(self._child_rows_frame)
            row.pack(fill="x", pady=3)

            name_var = tk.StringVar(
                value=self._d["children"][i]["name"]
                if i < len(self._d["children"]) else ""
            )
            ttk.Entry(row, textvariable=name_var, width=18).pack(
                side="left", padx=(0, 8)
            )

            album_var = tk.StringVar()
            if i < len(self._d["children"]) and album_names:
                idx = self._d["children"][i].get("album_idx", 0)
                album_var.set(
                    album_names[idx] if idx < len(album_names) else album_names[0]
                )
            elif album_names:
                album_var.set(album_names[0])

            ttk.Combobox(
                row, textvariable=album_var,
                values=album_names, state="readonly", width=36,
            ).pack(side="left")

            self._child_row_vars.append((name_var, album_var))

    def _validate_children(self) -> None:
        album_names = [a.get("title", "") for a in self._d["albums"]]
        children: list[dict] = []
        for name_var, album_var in self._child_row_vars:
            name = name_var.get().strip()
            if not name:
                messagebox.showerror("Missing Name",
                    "Please enter a name for every child.", parent=self)
                return
            album_title = album_var.get()
            idx = album_names.index(album_title) if album_title in album_names else 0
            children.append({"name": name, "album_idx": idx})

        self._d["children"] = children
        self._step += 1
        self._show_step()
        # Kick off face encoding build while user fills in GPS
        self._start_encoding_build()

    # ── Step 4: Daycare GPS (encodings build in background) ───────────────────

    def _start_encoding_build(self) -> None:
        self._encodings_ready = False
        self._encodings_by_child = {}

        def worker() -> None:
            import face_recognition
            import tempfile
            import google_photos as gp

            session = self._d["google_session"]
            albums = self._d["albums"]
            result: dict = {}

            for child in self._d["children"]:
                name = child["name"]
                album = albums[child["album_idx"]]
                sample_dir = Path(tempfile.mkdtemp(prefix="storypark_enc_"))
                encodings: list = []
                try:
                    items = gp.list_media_in_album(session, album["id"], max_items=30)
                    for item in items:
                        if not item.get("mimeType", "").startswith("image/"):
                            continue
                        local = gp.download_media_item(session, item, str(sample_dir))
                        if not local:
                            continue
                        try:
                            photo = face_recognition.load_image_file(local)
                            encodings.extend(face_recognition.face_encodings(photo))
                        except Exception:
                            pass
                        finally:
                            try:
                                os.remove(local)
                            except OSError:
                                pass
                        if len(encodings) >= 10:
                            break
                finally:
                    try:
                        sample_dir.rmdir()
                    except OSError:
                        pass
                result[name] = encodings
                self._bg_q.put(("enc_progress", name, len(encodings)))

            self._bg_q.put(("enc_done", result))

        threading.Thread(target=worker, daemon=True).start()
        self._poll_encodings()

    def _poll_encodings(self) -> None:
        try:
            msg = self._bg_q.get_nowait()
            if msg[0] == "enc_progress":
                _, name, n = msg
                logging.info("Face encoding: %s – %d encoding(s) so far", name, n)
            elif msg[0] == "enc_done":
                self._encodings_by_child = msg[1]
                self._encodings_ready = True
                self._update_enc_label()
                return
        except queue.Empty:
            pass
        self.after(400, self._poll_encodings)

    def _show_gps(self) -> None:
        f = self._body
        ttk.Label(
            f,
            text="Enter the GPS coordinates of the daycare.\n"
                 "Every matched photo will be stamped with this location.",
            style="Sub.TLabel",
        ).pack(anchor="w", pady=(0, 10))

        ttk.Label(
            f,
            text="How to find the coordinates:\n"
                 "  1. Open  maps.google.com\n"
                 "  2. Find the daycare\n"
                 "  3. Right-click it → 'What's here?'\n"
                 "  4. Copy the numbers at the bottom of the screen",
            style="Small.TLabel",
        ).pack(anchor="w", pady=(0, 10))

        grid = ttk.Frame(f)
        grid.pack(anchor="w")

        ttk.Label(grid, text="Latitude:").grid(
            row=0, column=0, sticky="w", padx=(0, 8), pady=4
        )
        self._lat = tk.StringVar(
            value="" if not self._d["latitude"] else str(self._d["latitude"])
        )
        ttk.Entry(grid, textvariable=self._lat, width=18).grid(
            row=0, column=1, sticky="w"
        )
        ttk.Label(grid, text="  e.g. -33.8688",
                  style="Small.TLabel").grid(row=0, column=2, sticky="w")

        ttk.Label(grid, text="Longitude:").grid(
            row=1, column=0, sticky="w", padx=(0, 8), pady=4
        )
        self._lon = tk.StringVar(
            value="" if not self._d["longitude"] else str(self._d["longitude"])
        )
        ttk.Entry(grid, textvariable=self._lon, width=18).grid(
            row=1, column=1, sticky="w"
        )
        ttk.Label(grid, text="  e.g. 151.2093",
                  style="Small.TLabel").grid(row=1, column=2, sticky="w")

        self._enc_lbl = ttk.Label(f, style="Small.TLabel")
        self._enc_lbl.pack(anchor="w", pady=(14, 0))
        self._update_enc_label()

    def _update_enc_label(self) -> None:
        if not hasattr(self, "_enc_lbl"):
            return
        if self._encodings_ready:
            parts = [
                f"{n} ({len(self._encodings_by_child[n])})"
                for n in self._encodings_by_child
            ]
            self._enc_lbl.config(
                text="✅  Face data ready: " + ", ".join(parts)
            )
        else:
            self._enc_lbl.config(
                text="⏳  Building face recognition data in the background…"
            )
            self.after(600, self._update_enc_label)

    def _validate_gps(self) -> None:
        try:
            lat = float(self._lat.get().strip())
            lon = float(self._lon.get().strip())
        except ValueError:
            messagebox.showerror(
                "Invalid Coordinates",
                "Please enter decimal numbers.\n"
                "Example: latitude -33.8688  longitude 151.2093",
                parent=self,
            )
            return
        if not -90 <= lat <= 90:
            messagebox.showerror("Invalid Latitude",
                                 "Latitude must be between -90 and 90.", parent=self)
            return
        if not -180 <= lon <= 180:
            messagebox.showerror("Invalid Longitude",
                                 "Longitude must be between -180 and 180.", parent=self)
            return
        self._d["latitude"] = lat
        self._d["longitude"] = lon
        self._step += 1
        self._show_step()

    # ── Step 5: Options ───────────────────────────────────────────────────────

    def _show_options(self) -> None:
        f = self._body
        ttk.Label(f, text="Almost done! Choose your preferred options.",
                  style="Sub.TLabel").pack(anchor="w", pady=(0, 12))

        self._headless_var = tk.BooleanVar(value=self._d["headless"])
        ttk.Checkbutton(
            f,
            text="Run browser in the background (recommended)",
            variable=self._headless_var,
        ).pack(anchor="w", pady=3)

        posts_row = ttk.Frame(f)
        posts_row.pack(anchor="w", pady=(10, 0))
        ttk.Label(posts_row, text="Max posts per run:").pack(side="left")
        self._max_posts_var = tk.StringVar(value=str(self._d["max_posts"]))
        ttk.Spinbox(posts_row, from_=0, to=9999,
                    textvariable=self._max_posts_var, width=7).pack(
            side="left", padx=6
        )
        ttk.Label(posts_row, text="(0 = unlimited)",
                  style="Small.TLabel").pack(side="left")

        ttk.Label(
            f,
            text="Tip: set to 10 for your first test run, then change to 0\n"
                 "for the full historical sync.",
            style="Small.TLabel",
        ).pack(anchor="w", pady=(6, 0))

    # ── Finish ────────────────────────────────────────────────────────────────

    def _finish(self) -> None:
        if not self._encodings_ready:
            messagebox.showinfo(
                "Still Building",
                "Face recognition data is still being built from your Google Photos.\n"
                "Please wait a moment and try again.",
                parent=self,
            )
            return

        if not self._encodings_by_child:
            messagebox.showerror(
                "No Face Data",
                "No faces were found in the selected albums.\n\n"
                "Go back and choose albums with clearer photos of each child's face.",
                parent=self,
            )
            return

        self._d["headless"] = self._headless_var.get()
        try:
            self._d["max_posts"] = int(self._max_posts_var.get() or "0")
        except ValueError:
            self._d["max_posts"] = 0

        # Save face encodings
        enc_path = APP_DIR / "face_encodings.pkl"
        with open(enc_path, "wb") as fh:
            pickle.dump(self._encodings_by_child, fh)

        # Save Storypark password to OS keychain and immediately clear
        # the in-memory copy so it doesn't linger longer than necessary.
        try:
            import keyring  # noqa: PLC0415
            keyring.set_password(
                _KEYRING_SERVICE,
                self._d["storypark_email"],
                self._pending_pw,
            )
        except Exception as exc:
            messagebox.showwarning(
                "Keychain Warning",
                f"Could not save to keychain: {exc}\n\n"
                "You may be asked for your password on each run.",
                parent=self,
            )
        finally:
            self._pending_pw = ""  # wipe regardless of keychain success

        # Write config.py
        _write_config(self._d)

        messagebox.showinfo(
            "Setup Complete",
            "Setup is complete!\n\n"
            f"Children configured: {', '.join(c['name'] for c in self._d['children'])}\n\n"
            "Click  ▶ Sync Photos Now  to start syncing.",
            parent=self,
        )
        self.destroy()
        self._on_complete()


# ---------------------------------------------------------------------------
# Main window
# ---------------------------------------------------------------------------

class MainWindow:
    """
    The main application dashboard shown after setup is complete.

    Shows:
      • Setup status and list of configured children
      • Sync button (runs pipeline in a background thread)
      • Settings button (re-opens the wizard)
      • Log viewer button
      • Progress bar and status message during sync
    """

    def __init__(self, root: tk.Tk) -> None:
        self.root = root
        self.root.title("Storypark Photo Sync")
        self.root.resizable(False, False)
        _apply_theme(root)

        self._syncing = False
        self._sync_result_q: queue.Queue = queue.Queue()
        self._log_viewer: LogViewer | None = None

        self._status_text = tk.StringVar(value="")
        self._progress_pct = tk.DoubleVar(value=0.0)
        self._progress_msg = tk.StringVar(value="")

        self._build_ui()
        self._refresh_status()
        self._poll_log_queue()
        self._center()

    def _center(self) -> None:
        self.root.update_idletasks()
        sw, sh = self.root.winfo_screenwidth(), self.root.winfo_screenheight()
        w, h = self.root.winfo_width(), self.root.winfo_height()
        self.root.geometry(f"+{(sw - w) // 2}+{(sh - h) // 2}")

    # ── UI ────────────────────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        # Header
        hdr = ttk.Frame(self.root, padding=(24, 18, 24, 6))
        hdr.pack(fill="x")
        ttk.Label(hdr, text="📸  Storypark Photo Sync",
                  style="Title.TLabel").pack(anchor="w")
        ttk.Label(
            hdr,
            text="Automatically saves your children's Storypark photos to Google Photos.",
            style="Small.TLabel",
        ).pack(anchor="w", pady=(2, 0))

        ttk.Separator(self.root, orient="horizontal").pack(fill="x", padx=24)

        # Status card
        card = ttk.LabelFrame(self.root, text="Status", padding=12)
        card.pack(fill="x", padx=24, pady=10)

        self._status_icon_lbl = ttk.Label(card, text="", style="Sub.TLabel")
        self._status_icon_lbl.grid(row=0, column=0, padx=(0, 6), sticky="w")
        ttk.Label(card, textvariable=self._status_text,
                  style="Sub.TLabel").grid(row=0, column=1, sticky="w")

        self._children_lbl = ttk.Label(card, text="", style="Small.TLabel")
        self._children_lbl.grid(row=1, column=0, columnspan=2, sticky="w", pady=(4, 0))

        self._last_run_lbl = ttk.Label(card, text="", style="Small.TLabel")
        self._last_run_lbl.grid(row=2, column=0, columnspan=2, sticky="w")

        # Buttons
        btn_area = ttk.Frame(self.root, padding=(24, 4, 24, 8))
        btn_area.pack(fill="x")

        self._sync_btn = ttk.Button(
            btn_area, text="▶  Sync Photos Now",
            command=self._on_sync, style="Sync.TButton",
        )
        self._sync_btn.pack(fill="x", pady=(0, 8))

        sub = ttk.Frame(btn_area)
        sub.pack(fill="x")
        sub.columnconfigure((0, 1), weight=1)
        ttk.Button(sub, text="⚙  Settings",
                   command=self._on_settings,
                   style="Action.TButton").grid(row=0, column=0, sticky="ew",
                                                padx=(0, 4))
        ttk.Button(sub, text="📋  View Log",
                   command=self._on_view_log,
                   style="Action.TButton").grid(row=0, column=1, sticky="ew",
                                                padx=(4, 0))

        # Progress section
        prog = ttk.LabelFrame(self.root, text="Progress", padding=10)
        prog.pack(fill="x", padx=24, pady=(4, 18))

        self._prog_bar = ttk.Progressbar(
            prog, variable=self._progress_pct, maximum=100, length=360
        )
        self._prog_bar.pack(fill="x", pady=(0, 4))
        ttk.Label(prog, textvariable=self._progress_msg,
                  style="Small.TLabel").pack(anchor="w")

    # ── Status ────────────────────────────────────────────────────────────────

    def _refresh_status(self) -> None:
        enc_path = APP_DIR / "face_encodings.pkl"
        if enc_path.exists():
            self._status_icon_lbl.config(text="✅")
            self._status_text.set("Ready to sync")
            try:
                from config import CHILDREN  # noqa: PLC0415
                children_str = (
                    "Children: " + ", ".join(CHILDREN)
                    if CHILDREN
                    else "No children configured – open Settings"
                )
            except Exception:
                children_str = ""
            self._children_lbl.config(text=children_str)
            last = self._last_run_timestamp()
            self._last_run_lbl.config(
                text=f"Last sync: {last}"
                if last
                else "Last sync: Never  (click Sync to start)"
            )
            self._sync_btn.config(state="normal")
        else:
            self._status_icon_lbl.config(text="⚠️")
            self._status_text.set("Setup required")
            self._children_lbl.config(
                text="Click  ⚙ Settings  to complete first-time setup"
            )
            self._last_run_lbl.config(text="")
            self._sync_btn.config(state="disabled")

    def _last_run_timestamp(self) -> str:
        log_path = APP_DIR / "pipeline.log"
        if not log_path.exists():
            return ""
        try:
            with open(log_path, encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()
            for line in reversed(lines):
                if "All done" in line or "uploaded to Google Photos" in line:
                    parts = line.split()
                    if len(parts) >= 2:
                        return f"{parts[0]} {parts[1]}"
        except OSError:
            pass
        return ""

    # ── Sync ──────────────────────────────────────────────────────────────────

    def _on_sync(self) -> None:
        if self._syncing:
            return
        # Reload config on the main thread (safe) so any changes made
        # via the Settings wizard since startup are picked up.
        try:
            import importlib  # noqa: PLC0415
            import config as cfg_module  # noqa: PLC0415
            importlib.reload(cfg_module)
        except Exception:
            pass  # non-fatal; use whatever config is already loaded

        self._syncing = True
        self._sync_btn.config(state="disabled", text="⏸  Syncing…")
        self._progress_pct.set(0)
        self._progress_msg.set("Starting pipeline…")

        threading.Thread(target=self._pipeline_thread, daemon=True).start()
        self._poll_sync()

    def _pipeline_thread(self) -> None:
        try:
            import main as pipeline  # noqa: PLC0415
            summary = pipeline.run_pipeline(
                progress_callback=self._on_progress
            )
            self._sync_result_q.put(("ok", summary))
        except Exception as exc:
            logging.exception("Pipeline error")
            self._sync_result_q.put(("err", str(exc)))

    def _on_progress(self, step: str, message: str, percent: int) -> None:
        """Called from pipeline thread – schedule UI update on main thread."""
        self.root.after(
            0,
            lambda s=step, m=message, p=percent: self._update_progress(s, m, p),
        )

    def _update_progress(self, step: str, message: str, percent: int) -> None:
        self._progress_pct.set(percent)
        self._progress_msg.set(message)

    def _poll_sync(self) -> None:
        try:
            result = self._sync_result_q.get_nowait()
        except queue.Empty:
            self.root.after(200, self._poll_sync)
            return

        self._syncing = False
        self._sync_btn.config(state="normal", text="▶  Sync Photos Now")

        if result[0] == "ok":
            summary = result[1]
            quota_msg = summary.get("quota_message")
            if quota_msg:
                # Quota was hit during upload – show a friendly warning
                msg = (
                    f"Partial sync – {summary['uploaded']} photo(s) uploaded "
                    f"before quota limit.\n{quota_msg}"
                )
                self._progress_pct.set(100)
                self._progress_msg.set(msg)
                self._refresh_status()
                messagebox.showwarning(
                    "Google Photos Limit",
                    quota_msg,
                    parent=self.root,
                )
            else:
                msg = (
                    f"Sync complete ✅\n"
                    f"Scraped: {summary['scraped']}  "
                    f"Matched: {summary['matched']}  "
                    f"Uploaded: {summary['uploaded']}"
                )
                self._progress_pct.set(100)
                self._progress_msg.set(msg)
                self._refresh_status()
        else:
            self._progress_msg.set(f"❌  Error – see log for details")
            messagebox.showerror(
                "Sync Failed",
                f"An error occurred during the sync:\n\n{result[1]}\n\n"
                "Click  📋 View Log  for full details.",
                parent=self.root,
            )

    # ── Settings / Log ────────────────────────────────────────────────────────

    def _on_settings(self) -> None:
        SetupWizard(self.root, on_complete=self._refresh_status)

    def _on_view_log(self) -> None:
        if self._log_viewer and self._log_viewer.winfo_exists():
            self._log_viewer.lift()
        else:
            self._log_viewer = LogViewer(self.root)

    # ── Live log polling ──────────────────────────────────────────────────────

    def _poll_log_queue(self) -> None:
        while True:
            try:
                line = _log_queue.get_nowait()
                if self._log_viewer and self._log_viewer.winfo_exists():
                    self._log_viewer.append_live(line)
            except queue.Empty:
                break
        self.root.after(150, self._poll_log_queue)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    root = tk.Tk()
    root.minsize(420, 380)
    _apply_theme(root)
    MainWindow(root)
    root.mainloop()


if __name__ == "__main__":
    main()
