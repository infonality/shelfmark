import { useEffect, useRef, useState } from "react";
import { api, pickFolder, Settings } from "../api";
import { ACCENTS, Appearance, AppTheme } from "../appearance";
import { Button, Icon, cx } from "../ui";

export default function SettingsPage({
  settings,
  appearance,
  onAppearance,
  onSaved,
}: {
  settings: Settings | null;
  appearance: Appearance;
  onAppearance: (a: Appearance) => void;
  onSaved: () => Promise<void> | void;
}) {
  const [booksRoot, setBooksRoot] = useState("");
  const [comicsRoot, setComicsRoot] = useState("");
  const [saveState, setSaveState] = useState<"idle" | "pending" | "saving" | "saved">("idle");
  const hydrated = useRef(false);

  useEffect(() => {
    if (settings && !hydrated.current) {
      hydrated.current = true;
      setBooksRoot(settings.books_root ?? "");
      setComicsRoot(settings.comics_root ?? "");
    }
  }, [settings]);

  // Paths save after a short pause. Folder-picker changes use the same path,
  // so typing and browsing cannot diverge into two persistence behaviours.
  useEffect(() => {
    if (!settings) return;
    const next: Settings = {
      books_root: booksRoot.trim(),
      comics_root: comicsRoot.trim(),
      words_per_page: settings.words_per_page || 275,
    };
    if (next.books_root === settings.books_root && next.comics_root === settings.comics_root) {
      return;
    }
    setSaveState("pending");
    const timer = window.setTimeout(async () => {
      setSaveState("saving");
      try {
        await api.saveSettings(next);
        await onSaved();
        setSaveState("saved");
        window.setTimeout(() => setSaveState("idle"), 2000);
      } catch (e) {
        setSaveState("idle");
        alert(String(e));
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [booksRoot, comicsRoot, settings, onSaved]);

  async function browse() {
    const dir = await pickFolder("Choose your books folder");
    if (dir) setBooksRoot(dir);
  }

  async function browseComics() {
    const dir = await pickFolder("Choose your comics folder");
    if (dir) setComicsRoot(dir);
  }

  return (
    <div className="max-w-2xl space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Where your books and comics live.
        </p>
      </header>

      <section className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <div>
          <label className="mb-1.5 block text-sm font-medium">Books folder</label>
          <p className="mb-2 text-xs text-slate-500">
            The folder to scan for EPUB, PDF, and MOBI/AZW files (subfolders included).
          </p>
          <div className="flex gap-2">
            <input
              value={booksRoot}
              onChange={(e) => setBooksRoot(e.target.value)}
              placeholder="e.g. C:\Users\you\Books"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-accent-500/50"
            />
            <Button variant="subtle" onClick={browse}>
              <Icon name="folder" className="h-4 w-4" /> Browse
            </Button>
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Comics folder</label>
          <p className="mb-2 text-xs text-slate-500">
            Scanned for CBZ, CBR and PDF. Comics need their own folder because the file type
            can't tell them apart from books — plenty of comics are PDFs, so whichever folder a
            file sits in decides where it lands.
          </p>
          <div className="flex gap-2">
            <input
              value={comicsRoot}
              onChange={(e) => setComicsRoot(e.target.value)}
              placeholder="e.g. C:\Users\you\Comics"
              className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-accent-500/50"
            />
            <Button variant="subtle" onClick={browseComics}>
              <Icon name="folder" className="h-4 w-4" /> Browse
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2 pt-1 text-xs text-slate-500" aria-live="polite">
          {saveState === "saving" ? (
            <>Saving…</>
          ) : saveState === "pending" ? (
            <>Changes save automatically</>
          ) : saveState === "saved" ? (
            <><Icon name="check" className="h-3.5 w-3.5 text-emerald-400" /> Saved</>
          ) : (
            <>Changes save automatically</>
          )}
        </div>
      </section>

      <section className="space-y-5 rounded-xl border border-white/10 bg-white/[0.02] p-5">
        <div>
          <h2 className="text-sm font-semibold">Appearance</h2>
          <p className="mt-1 text-xs text-slate-500">
            How the app looks. A book's own page — paper, sepia, night — is set in the
            reader's type menu, and isn't affected by this.
          </p>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Theme</label>
          <div className="inline-flex rounded-lg border border-white/10 p-0.5">
            {(
              [
                { id: "dark", label: "Dark", icon: "flame" },
                { id: "light", label: "Light", icon: "sparkles" },
              ] as { id: AppTheme; label: string; icon: string }[]
            ).map((t) => (
              <button
                key={t.id}
                onClick={() => onAppearance({ ...appearance, theme: t.id })}
                className={cx(
                  "flex items-center gap-2 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors",
                  appearance.theme === t.id
                    ? "bg-accent-600/20 text-white ring-1 ring-inset ring-accent-500/30"
                    : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
                )}
              >
                <Icon name={t.icon} className="h-4 w-4" />
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="mb-1.5 block text-sm font-medium">Accent</label>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                onClick={() => onAppearance({ ...appearance, accent: a.id })}
                title={a.label}
                aria-label={a.label}
                aria-pressed={appearance.accent === a.id}
                className={cx(
                  "grid h-8 w-8 place-items-center rounded-full transition-transform hover:scale-110",
                  appearance.accent === a.id
                    ? "ring-2 ring-white/70 ring-offset-2 ring-offset-transparent"
                    : "ring-1 ring-white/15"
                )}
                style={{ background: a.swatch }}
              >
                {appearance.accent === a.id && (
                  <Icon name="check" className="h-4 w-4 text-on-accent" />
                )}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-white/10 bg-white/[0.02] p-5 text-sm text-slate-400">
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Icon name="sparkles" className="h-4 w-4 text-accent-400" /> About metadata
        </h2>
        <p className="leading-relaxed">
          Shelfmark first reads metadata embedded in each file. From a book's detail panel you can also
          fetch richer data (cover, page count, subjects, description) from{" "}
          <span className="text-slate-200">Open Library</span> — a free, open catalogue. Goodreads shut its
          public API in 2020, so Open Library stands in for it. If nothing matches, just type the details in
          yourself and save.
        </p>
      </section>
    </div>
  );
}
