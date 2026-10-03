"""Tkinter desktop interface for EPUB Finder."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
from queue import Empty, SimpleQueue
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from .index import Hit, SearchIndex


APP_DIR = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "share")) / "EpubFinder"
PALETTES = {
    "light": {
        "canvas": "#f3f6f8", "surface": "#ffffff", "ink": "#172631",
        "muted": "#566879", "line": "#d7e0e5", "accent": "#146b70",
        "accent_hover": "#0d565b", "accent_text": "#ffffff", "header": "#e7eff0",
        "selected": "#d8edef", "selected_text": "#123c40", "match": "#ffe59a",
        "match_text": "#4a3407", "input": "#ffffff", "button": "#e8eef1",
    },
    "dark": {
        "canvas": "#151c22", "surface": "#202b33", "ink": "#ecf3f4",
        "muted": "#a9bac1", "line": "#3b4c55", "accent": "#62c1bc",
        "accent_hover": "#83d4ce", "accent_text": "#102b2d", "header": "#293841",
        "selected": "#245158", "selected_text": "#f1fbfb", "match": "#9f7122",
        "match_text": "#fff7d9", "input": "#26343d", "button": "#33434c",
    },
}


class App(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("EPUB Finder")
        self.geometry("1180x780")
        self.minsize(900, 620)
        self.index = SearchIndex(APP_DIR / "index.sqlite3")
        self.pool = ThreadPoolExecutor(max_workers=1)
        self.events: SimpleQueue[tuple] = SimpleQueue()
        self.hits: dict[str, Hit] = {}
        self.search_generation = 0
        self.search_timer: str | None = None
        self.busy = False
        self.folder = tk.StringVar()
        self.query = tk.StringVar()
        self.theme = "light"
        self.status = tk.StringVar(value="Select a folder containing EPUB files to begin")
        self.summary = tk.StringVar(value="No search results yet")
        self._build()
        self._apply_theme()
        self._load_settings()
        self.query.trace_add("write", self._query_changed)
        self.folder.trace_add("write", self._folder_changed)
        self.after(80, self._drain_events)
        self.protocol("WM_DELETE_WINDOW", self._close)

    def _apply_theme(self) -> None:
        c = PALETTES[self.theme]
        style = ttk.Style(self)
        style.theme_use("clam")
        self.configure(bg=c["canvas"])
        style.configure("TFrame", background=c["canvas"])
        style.configure("Surface.TFrame", background=c["surface"])
        style.configure("TLabel", background=c["canvas"], foreground=c["ink"], font=("Segoe UI", 10))
        style.configure("Title.TLabel", background=c["canvas"], foreground=c["ink"], font=("Segoe UI Semibold", 19))
        style.configure("Section.TLabel", background=c["canvas"], foreground=c["ink"], font=("Segoe UI Semibold", 11))
        style.configure("Muted.TLabel", background=c["canvas"], foreground=c["muted"], font=("Segoe UI", 9))
        style.configure("SurfaceTitle.TLabel", background=c["surface"], foreground=c["ink"], font=("Segoe UI Semibold", 10))
        style.configure("SurfaceMuted.TLabel", background=c["surface"], foreground=c["muted"], font=("Segoe UI", 9))
        style.configure("TButton", font=("Segoe UI", 10), padding=(13, 8), background=c["button"], foreground=c["ink"], bordercolor=c["line"], relief="flat")
        style.map("TButton", background=[("active", c["header"]), ("disabled", c["canvas"])], foreground=[("disabled", c["muted"])])
        style.configure("Accent.TButton", background=c["accent"], foreground=c["accent_text"], bordercolor=c["accent"], relief="flat")
        style.map("Accent.TButton", background=[("active", c["accent_hover"]), ("disabled", c["button"])], foreground=[("disabled", c["muted"])])
        style.configure("TEntry", fieldbackground=c["input"], foreground=c["ink"], bordercolor=c["line"], insertcolor=c["ink"], padding=7)
        style.map("TEntry", fieldbackground=[("disabled", c["header"])], foreground=[("disabled", c["muted"])])
        style.configure("Treeview", font=("Segoe UI", 10), rowheight=34, background=c["surface"], fieldbackground=c["surface"], foreground=c["ink"], borderwidth=0)
        style.configure("Treeview.Heading", font=("Segoe UI Semibold", 10), background=c["header"], foreground=c["ink"], padding=(9, 9), relief="flat")
        style.map("Treeview", background=[("selected", c["selected"])], foreground=[("selected", c["selected_text"])])
        style.map("Treeview.Heading", background=[("active", c["header"])])
        style.configure("TScrollbar", background=c["button"], troughcolor=c["surface"], arrowcolor=c["muted"], bordercolor=c["surface"])
        style.configure("Horizontal.TProgressbar", background=c["accent"], troughcolor=c["line"], bordercolor=c["line"])
        self.panes.configure(background=c["canvas"], sashwidth=8)
        self.preview.configure(highlightbackground=c["line"], bg=c["surface"])
        self.detail.configure(bg=c["surface"], fg=c["ink"], insertbackground=c["ink"], selectbackground=c["selected"], selectforeground=c["selected_text"])
        self.detail.tag_configure("match", background=c["match"], foreground=c["match_text"])
        self.theme_button.configure(text="Light theme" if self.theme == "dark" else "Dark theme")

    def _toggle_theme(self) -> None:
        self.theme = "dark" if self.theme == "light" else "light"
        self._apply_theme()
        self._save_settings()

    def _build(self) -> None:
        top = ttk.Frame(self, padding=(24, 18, 24, 10))
        top.pack(fill="x")
        top.columnconfigure(0, weight=1)
        ttk.Label(top, text="EPUB Finder", style="Title.TLabel").grid(row=0, column=0, sticky="w")
        self.theme_button = ttk.Button(top, command=self._toggle_theme)
        self.theme_button.grid(row=0, column=1, sticky="e")
        ttk.Label(top, text="Search your library and read every match in context.", style="Muted.TLabel").grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 0))

        controls = ttk.Frame(self, padding=(24, 12, 24, 8))
        controls.pack(fill="x")
        ttk.Label(controls, text="Library folder", style="Section.TLabel").grid(row=0, column=0, sticky="w", pady=(0, 7))
        self.folder_entry = ttk.Entry(controls, textvariable=self.folder, font=("Microsoft YaHei UI", 10))
        self.folder_entry.grid(row=1, column=0, sticky="ew", padx=(0, 8))
        self.folder_entry.bind("<Return>", lambda _event: self._scan())
        ttk.Button(controls, text="Choose Folder", command=self._choose_folder).grid(row=1, column=1, padx=(0, 8))
        self.scan_button = ttk.Button(controls, text="Update Index", style="Accent.TButton", command=self._scan)
        self.scan_button.grid(row=1, column=2)
        controls.columnconfigure(0, weight=1)

        search = ttk.Frame(self, padding=(24, 4, 24, 16))
        search.pack(fill="x")
        ttk.Label(search, text="Search text", style="Section.TLabel").pack(anchor="w", pady=(0, 7))
        self.search_entry = ttk.Entry(search, textvariable=self.query, font=("Microsoft YaHei UI", 12))
        self.search_entry.pack(fill="x")
        self.search_entry.bind("<Return>", lambda _event: self._search_now())
        ttk.Label(search, text="Case-insensitive text matching · Includes subfolders", style="Muted.TLabel").pack(anchor="w", pady=(7, 0))

        self.panes = tk.PanedWindow(self, orient="vertical", bd=0, relief="flat", sashrelief="flat", sashwidth=8, showhandle=False)
        self.panes.pack(fill="both", expand=True, padx=24)
        results = ttk.Frame(self.panes)
        results.columnconfigure(0, weight=1)
        results.rowconfigure(1, weight=1)
        results_header = ttk.Frame(results, padding=(0, 0, 0, 8))
        results_header.grid(row=0, column=0, columnspan=2, sticky="ew")
        ttk.Label(results_header, text="Search results", style="Section.TLabel").pack(side="left")
        ttk.Label(results_header, textvariable=self.summary, style="Muted.TLabel").pack(side="right")
        cols = ("book", "chapter", "location", "excerpt")
        self.tree = ttk.Treeview(results, columns=cols, show="headings", selectmode="browse")
        for col, title, width in (("book", "Book", 190), ("chapter", "Chapter", 155), ("location", "Location", 180), ("excerpt", "Context", 530)):
            self.tree.heading(col, text=title)
            self.tree.column(col, width=width, minwidth=80, stretch=col == "excerpt")
        self.tree.grid(row=1, column=0, sticky="nsew")
        results_scroll = ttk.Scrollbar(results, orient="vertical", command=self.tree.yview)
        results_scroll.grid(row=1, column=1, sticky="ns")
        self.tree.configure(yscrollcommand=results_scroll.set)
        self.tree.bind("<<TreeviewSelect>>", self._select_hit)
        self.panes.add(results, minsize=140, stretch="always")

        preview_section = ttk.Frame(self.panes)
        preview_section.columnconfigure(0, weight=1)
        preview_section.rowconfigure(1, weight=1)
        ttk.Label(preview_section, text="Chapter preview", style="Section.TLabel").grid(row=0, column=0, sticky="w", pady=(3, 8))
        self.preview = tk.Frame(preview_section, highlightthickness=1)
        self.preview.grid(row=1, column=0, sticky="nsew")
        self.preview.columnconfigure(0, weight=1)
        self.preview.rowconfigure(2, weight=1)
        self.detail_title = ttk.Label(self.preview, text="Select a result to preview its chapter", style="SurfaceTitle.TLabel", padding=(14, 10, 14, 4))
        self.detail_title.grid(row=0, column=0, sticky="ew")
        self.detail_path = ttk.Label(self.preview, text="", style="SurfaceMuted.TLabel", padding=(14, 0, 14, 6), wraplength=1000, justify="left")
        self.detail_path.grid(row=1, column=0, sticky="ew")
        self.preview.bind("<Configure>", lambda event: self.detail_path.configure(wraplength=max(event.width - 42, 300)))
        self.detail = tk.Text(self.preview, wrap="word", font=("Segoe UI", 11), relief="flat", padx=14, pady=8, spacing3=7)
        self.detail.grid(row=2, column=0, sticky="nsew")
        detail_scroll = ttk.Scrollbar(self.preview, orient="vertical", command=self.detail.yview)
        detail_scroll.grid(row=2, column=1, sticky="ns")
        self.detail.configure(yscrollcommand=detail_scroll.set, state="disabled")
        self.panes.add(preview_section, minsize=150, stretch="always")
        self.after_idle(self._set_initial_split)

        footer = ttk.Frame(self, padding=(24, 10, 24, 14))
        footer.pack(fill="x")
        self.progress = ttk.Progressbar(footer, mode="determinate", length=150)
        self.progress.pack(side="right")
        ttk.Label(footer, textvariable=self.status, style="Muted.TLabel").pack(side="left")

    def _set_initial_split(self) -> None:
        if self.panes.winfo_exists():
            self.panes.sash_place(0, 0, int(self.panes.winfo_height() * 0.55))

    def _folder_changed(self, *_args: object) -> None:
        self.search_generation += 1
        self._show_hits([], False)

    def _root_path(self) -> Path | None:
        value = self.folder.get().strip().strip('"')
        path = Path(value).expanduser() if value else None
        if path and path.is_dir():
            return path.resolve()
        messagebox.showwarning("Folder unavailable", "Choose an existing folder.", parent=self)
        return None

    def _choose_folder(self) -> None:
        value = filedialog.askdirectory(parent=self, title="Choose an EPUB folder", initialdir=self.folder.get() or str(Path.home()))
        if value:
            self.folder.set(value)
            self._save_settings()
            self._scan()

    def _scan(self) -> None:
        root = self._root_path()
        if root is None or self.busy:
            return
        self._save_settings()
        self.busy = True
        self.scan_button.configure(state="disabled")
        self.status.set("Scanning EPUB files…")
        self.progress.configure(value=0, maximum=1)

        def run() -> None:
            try:
                updated, errors = self.index.scan(root, lambda n, total, name: self.events.put(("progress", n, total, name)))
                count = self.index.count_books(root)
                self.events.put(("scan_done", root, count, updated, errors))
            except Exception as exc:
                self.events.put(("scan_error", str(exc)))

        self.pool.submit(run)

    def _query_changed(self, *_args: object) -> None:
        if self.search_timer:
            self.after_cancel(self.search_timer)
        self.search_timer = self.after(280, self._search_now)

    def _search_now(self) -> None:
        self.search_timer = None
        self.search_generation += 1
        generation = self.search_generation
        query = self.query.get().strip()
        root = Path(self.folder.get()).expanduser()
        if not query or not root.is_dir():
            self._show_hits([], False)
            return
        self.status.set("Searching…")

        def run() -> None:
            try:
                hits, truncated = self.index.search(root, query)
                self.events.put(("results", generation, hits, truncated))
            except Exception as exc:
                self.events.put(("search_error", generation, str(exc)))

        self.pool.submit(run)

    def _drain_events(self) -> None:
        try:
            while True:
                event = self.events.get_nowait()
                kind = event[0]
                if kind == "progress":
                    _, n, total, name = event
                    self.progress.configure(maximum=max(total, 1), value=n)
                    self.status.set(f"Scanning {n}/{total}: {name}")
                elif kind == "scan_done":
                    _, root, count, updated, errors = event
                    self.busy = False
                    self.scan_button.configure(state="normal")
                    self.status.set(f"Indexed {count} EPUB files; updated {updated}" + (f"; failed {len(errors)}" if errors else ""))
                    if errors:
                        messagebox.showwarning("Some files could not be indexed", "\n".join(errors[:12]) + ("\n…" if len(errors) > 12 else ""), parent=self)
                    if Path(self.folder.get()).resolve() == root and self.query.get().strip():
                        self._search_now()
                elif kind == "scan_error":
                    self.busy = False
                    self.scan_button.configure(state="normal")
                    self.status.set("Scan failed")
                    messagebox.showerror("Scan failed", event[1], parent=self)
                elif kind == "results" and event[1] == self.search_generation:
                    self._show_hits(event[2], event[3])
                    self.status.set("Search complete")
                elif kind == "search_error" and event[1] == self.search_generation:
                    self.status.set("Search failed")
                    messagebox.showerror("Search failed", event[2], parent=self)
        except Empty:
            pass
        self.after(80, self._drain_events)

    def _show_hits(self, hits: list[Hit], truncated: bool) -> None:
        self.tree.delete(*self.tree.get_children())
        self.hits.clear()
        self.detail_title.configure(text="Select a result to preview its chapter")
        self.detail_path.configure(text="")
        self.detail.configure(state="normal")
        self.detail.delete("1.0", "end")
        self.detail.configure(state="disabled")
        for hit in hits:
            iid = self.tree.insert("", "end", values=(hit.book, hit.chapter, f"Paragraph {hit.paragraph_number} · char {hit.offset}", hit.excerpt))
            self.hits[iid] = hit
        self.summary.set(f"Showing first {len(hits)} results" if truncated else f"{len(hits)} results")

    def _select_hit(self, _event: object) -> None:
        selection = self.tree.selection()
        if not selection or selection[0] not in self.hits:
            return
        hit = self.hits[selection[0]]
        paragraphs = self.index.chapter_text(hit.book_id, hit.chapter_number)
        self.detail_title.configure(text=f"{hit.book}  /  {hit.chapter}  /  Paragraph {hit.paragraph_number}  /  Character {hit.offset}")
        self.detail_path.configure(text=f"File: {hit.path}    EPUB entry: {hit.href}")
        self.detail.configure(state="normal")
        self.detail.delete("1.0", "end")
        for paragraph in paragraphs:
            self.detail.insert("end", paragraph + "\n\n")
        start = f"{hit.paragraph_number * 2 - 1}.{hit.offset - 1}"
        end = f"{start}+{hit.match_end - hit.match_start}c"
        self.detail.tag_add("match", start, end)
        self.detail.see(start)
        self.detail.configure(state="disabled")

    def _load_settings(self) -> None:
        try:
            settings = json.loads((APP_DIR / "settings.json").read_text(encoding="utf-8"))
            self.theme = settings.get("theme") if settings.get("theme") in PALETTES else "light"
            self._apply_theme()
            value = settings.get("folder", "")
            if value and Path(value).is_dir():
                self.folder.set(value)
                self._scan()
        except (OSError, ValueError, TypeError):
            pass

    def _save_settings(self) -> None:
        APP_DIR.mkdir(parents=True, exist_ok=True)
        (APP_DIR / "settings.json").write_text(
            json.dumps({"folder": self.folder.get(), "theme": self.theme}, ensure_ascii=False),
            encoding="utf-8",
        )

    def _close(self) -> None:
        self.pool.shutdown(wait=False, cancel_futures=True)
        self.destroy()


def main() -> None:
    App().mainloop()
