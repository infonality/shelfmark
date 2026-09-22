import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./index.css";
import { api, Book, Kind, pickLibraryFiles, ProgressEvent, Settings } from "./api";
import { Appearance, applyAppearance, loadAppearance, saveAppearance } from "./appearance";
import { Button, cx, Icon, Logo, Spinner } from "./ui";
import { TITLE_BAR_HEIGHT } from "./platform";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import Settings_ from "./pages/Settings";

export type View = "dashboard" | "library" | "comics" | "settings";

const NAV: { id: View; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "dashboard" },
  { id: "library", label: "Books", icon: "books" },
  { id: "comics", label: "Comics", icon: "comics" },
  { id: "settings", label: "Settings", icon: "settings" },
];

export default function App() {
  const [view, setView] = useState<View>("dashboard");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [tags, setTags] = useState<string[]>([]);
  const [collection, setCollection] = useState<string | null>(null);
  // main.tsx has already applied this before the first paint; holding it in
  // state is what lets the Settings controls re-render against it.
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  const changeAppearance = useCallback((next: Appearance) => {
    setAppearance(next);
    saveAppearance(next);
    applyAppearance(next);
  }, []);

  // WebView2's own menu offers reload and inspect, which mean nothing in a
  // desktop app. Text fields keep theirs, since cut/copy/paste is genuinely
  // useful there.
  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [contenteditable='true']")) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await api.getSettings();
    setSettings(s);
    return s;
  }, []);

  useEffect(() => {
    loadSettings().then((s) => {
      if (!s.books_root) setView("settings");
    });
  }, [loadSettings]);

  useEffect(() => {
    api.listTags().then(setTags).catch(() => {});
  }, [reloadToken]);

  useEffect(() => {
    if (collection && !tags.some((tag) => tag.toLowerCase() === collection.toLowerCase())) {
      setCollection(null);
    }
  }, [tags, collection]);

  // Global progress listener for the scan job.
  useEffect(() => {
    const handle = (p: ProgressEvent) => {
      setProgress(p);
      if (p.done) {
        reload();
        setTimeout(() => setProgress((cur) => (cur?.done ? null : cur)), 3000);
      }
    };
    const a = listen<ProgressEvent>("scan-progress", (e) => handle(e.payload));
    return () => {
      a.then((f) => f());
    };
  }, [reload]);

  // Launch a book in whatever reader the OS uses for that file type. We don't
  // chase the reader for a position afterwards — an external app can't report
  // one, and interrupting the user to ask was worse than not knowing. Totals
  // move when a book is marked finished instead.
  const openBook = useCallback(async (book: Book): Promise<Book> => {
    return api.openBook(book.id);
  }, []);

  const configured = !!(settings?.books_root || settings?.comics_root);

  const doScan = useCallback(async () => {
    setScanning(true);
    try {
      await api.scanLibrary();
    } catch (e) {
      alert(String(e));
    } finally {
      setScanning(false);
      reload();
    }
  }, [reload]);

  const importFiles = useCallback(
    async (paths: string[], kind: Kind) => {
      if (!paths.length) return;
      setImporting(true);
      try {
        const result = await api.importFiles(paths, kind);
        if (result.copied === 0 && result.scan.added === 0 && result.skipped > 0) {
          alert("No new supported files were copied. Existing or unsupported files were skipped.");
        }
        setView(kind === "comic" ? "comics" : "library");
        if (kind === "book") setCollection(null);
        reload();
      } catch (e) {
        alert(String(e));
      } finally {
        setImporting(false);
      }
    },
    [reload]
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") setDragActive(true);
        if (payload.type === "leave") setDragActive(false);
        if (payload.type === "drop") {
          setDragActive(false);
          const kind: Kind = view === "comics" ? "comic" : "book";
          void importFiles(payload.paths, kind);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [importFiles, view]);

  const saveSettings = useCallback(async () => {
    await loadSettings();
    reload();
  }, [loadSettings, reload]);

  const importKind: Kind = view === "comics" ? "comic" : "book";
  const importConfigured = importKind === "comic" ? !!settings?.comics_root : !!settings?.books_root;

  const chooseImport = useCallback(async () => {
    const paths = await pickLibraryFiles(importKind);
    await importFiles(paths, importKind);
  }, [importFiles, importKind]);

  return (
    <div className="flex h-full w-full text-slate-200">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/10 bg-sidebar backdrop-blur">
        <div
          data-tauri-drag-region
          className="flex items-center gap-2.5 px-5 py-5"
          style={{ paddingTop: 20 + TITLE_BAR_HEIGHT }}
        >
          <Logo className="h-9 w-9 shrink-0 rounded-lg shadow-lg shadow-violet-950/40" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-semibold leading-tight">Shelfmark</span>
              <span
                className="rounded bg-white/10 px-1 py-px text-[10px] font-medium tabular-nums leading-none text-slate-400"
                title={`Shelfmark ${__APP_VERSION__}`}
              >
                {__APP_VERSION__}
              </span>
            </div>
            <div className="text-[11px] text-slate-500">Digital Library</div>
          </div>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-2">
          {NAV.map((n) => (
            <div key={n.id}>
              <button
                onClick={() => {
                  setView(n.id);
                  if (n.id === "library") setCollection(null);
                }}
                className={cx(
                  "flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  view === n.id && (n.id !== "library" || !collection)
                    ? "bg-accent-600/20 text-white ring-1 ring-inset ring-accent-500/30"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                )}
              >
                <Icon name={n.icon} className="h-[18px] w-[18px]" />
                {n.label}
              </button>
              {n.id === "library" && tags.length > 0 && (
                <div className="mb-1 ml-6 mt-1 space-y-0.5 border-l border-white/10 pl-2">
                  {tags.map((tag) => (
                    <button
                      key={tag.toLowerCase()}
                      onClick={() => {
                        setCollection(tag);
                        setView("library");
                      }}
                      title={tag}
                      className={cx(
                        "block w-full truncate rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        view === "library" && collection?.toLowerCase() === tag.toLowerCase()
                          ? "bg-accent-500/15 text-accent-300"
                          : "text-slate-500 hover:bg-white/5 hover:text-slate-300"
                      )}
                    >
                      {tag}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </nav>

        <div className="px-3 pb-4">
          <Button
            variant="subtle"
            className="mb-2 w-full justify-center"
            busy={importing}
            onClick={chooseImport}
            disabled={!importConfigured}
          >
            {!importing && <Icon name="plus" className="h-4 w-4" />}
            {importing ? "Importing…" : `Import ${importKind === "comic" ? "Comics" : "Books"}`}
          </Button>
          <Button
            variant="primary"
            className="w-full justify-center"
            busy={scanning}
            onClick={doScan}
            disabled={!configured}
          >
            {!scanning && <Icon name="scan" className="h-4 w-4" />}
            {scanning ? "Scanning…" : "Scan Books"}
          </Button>
          {!configured && (
            <p className="mt-2 px-1 text-[11px] leading-snug text-slate-500">
              Set a books or comics folder in Settings to get started.
            </p>
          )}
        </div>
      </aside>

      {/* Main */}
      <main className="relative flex-1 overflow-y-auto">
        {/* No width cap: a maximised window on a wide monitor was showing the
            library in the middle half of the screen with empty gutters either
            side. Pages that want a narrower measure — Settings, which is a
            form — set their own. */}
        <div className="px-8 py-8">
          {view === "dashboard" && (
            <Dashboard
              reloadToken={reloadToken}
              goto={setView}
              onScan={doScan}
              onOpen={openBook}
              onReload={reload}
              scanning={scanning}
              configured={configured}
            />
          )}
          {view === "library" && (
            <Library reloadToken={reloadToken} onReload={reload} onOpen={openBook} kind="book" tag={collection} />
          )}
          {view === "comics" && (
            <Library reloadToken={reloadToken} onReload={reload} onOpen={openBook} kind="comic" />
          )}
          {view === "settings" && (
            <Settings_
              settings={settings}
              appearance={appearance}
              onAppearance={changeAppearance}
              onSaved={saveSettings}
            />
          )}
        </div>
      </main>

      {/* Scan progress */}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-3">
        {progress && <ProgressToast p={progress} />}
      </div>

      {dragActive && (
        <div className="pointer-events-none fixed inset-0 z-[100] grid place-items-center bg-slate-950/75 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-accent-400 bg-slate-900/90 px-12 py-10 text-center shadow-2xl">
            <Icon name="plus" className="mx-auto h-8 w-8 text-accent-300" />
            <div className="mt-3 text-lg font-semibold">Drop to import {importKind === "comic" ? "comics" : "books"}</div>
            <div className="mt-1 text-sm text-slate-400">Files will be copied into the current library folder.</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ProgressToast({ p }: { p: ProgressEvent }) {
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : p.done ? 100 : 0;
  return (
    <div className="bv-fade pointer-events-auto rounded-xl border border-white/10 bg-slate-900/90 p-4 shadow-2xl backdrop-blur">
      <div className="mb-2 flex items-center gap-2">
        {p.done ? (
          <Icon name="check" className="h-4 w-4 text-emerald-400" />
        ) : (
          <Spinner className="h-4 w-4 text-accent-400" />
        )}
        <span className="text-sm font-medium capitalize">{p.job}</span>
        {p.total > 0 && (
          <span className="ml-auto text-xs text-slate-400">
            {p.current}/{p.total}
          </span>
        )}
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={cx("h-full rounded-full transition-all", p.done ? "bg-emerald-500" : "bg-accent-500")}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-2 truncate text-xs text-slate-400">{p.message}</p>
    </div>
  );
}
