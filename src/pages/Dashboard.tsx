import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, assetUrl, Book, DashboardStats, formatCompact } from "../api";
import { openReaderWindow, readsInApp } from "../open-book";
import { Button, Icon, Spinner, StarRating, cx } from "../ui";
import type { View } from "../App";

export default function Dashboard({
  reloadToken,
  goto,
  onScan,
  onOpen,
  onReload,
  scanning,
  configured,
}: {
  reloadToken: number;
  goto: (v: View) => void;
  onScan: () => void;
  /** Hand a book the built-in reader can't show to the OS. */
  onOpen: (b: Book) => Promise<Book>;
  onReload: () => void;
  scanning: boolean;
  configured: boolean;
}) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  /** Clicking a book here opens it, exactly as it does in the library. */
  const open = useCallback(
    async (book: Book) => {
      if (!readsInApp(book)) {
        try {
          await onOpen(book);
        } catch (e) {
          alert(String(e));
        }
        return;
      }
      await openReaderWindow(book, onReload);
    },
    [onOpen, onReload]
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .dashboardStats()
      .then((s) => alive && setStats(s))
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [reloadToken]);

  const maxCat = stats ? Math.max(1, ...stats.categories.map((c) => c.total)) : 1;

  return (
    <div className="space-y-8">
      {loading && !stats ? (
        <div className="flex items-center gap-3 text-slate-400">
          <Spinner className="h-5 w-5" /> Loading…
        </div>
      ) : !configured ? (
        <EmptyState
          title="Let’s set things up"
          body="Point Shelfmark at the folder that holds your books (EPUB, PDF, MOBI) and, if you have them, a second folder for comics (CBZ, CBR, PDF). Then scan to build your library."
          action={<Button variant="primary" onClick={() => goto("settings")}>Open Settings</Button>}
        />
      ) : stats && stats.total_books + stats.total_comics === 0 ? (
        <EmptyState
          title="Nothing indexed yet"
          body="Add books or comics to your folders, then run a scan to index them and pull their metadata."
          action={
            <Button variant="primary" busy={scanning} onClick={onScan}>
              <Icon name="scan" className="h-4 w-4" /> Scan Books
            </Button>
          }
        />
      ) : stats ? (
        <>
          {/* Headline stats */}
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label="Books read" value={stats.books_read.toLocaleString()} icon="check" tone="green" />
            <StatCard label="Comics read" value={stats.comics_read.toLocaleString()} icon="comics" tone="amber" />
            <StatCard label="Pages read" value={formatCompact(stats.pages_read)} icon="pages" tone="accent" />
            <StatCard
              label="Currently reading"
              value={stats.currently_reading.toLocaleString()}
              icon="book"
              tone="blue"
            />
          </div>

          {/* Secondary line */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <MiniStat label="Total books" value={stats.total_books.toLocaleString()} />
            <MiniStat label="Total comics" value={stats.total_comics.toLocaleString()} />
            <MiniStat label="Unread" value={stats.unread.toLocaleString()} />
            <MiniStat label="Finished" value={stats.finished.toLocaleString()} />
          </div>

          {/* Currently reading */}
          {stats.in_progress.length > 0 && (
            <section>
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-semibold text-slate-300">Continue reading</h2>
                {stats.currently_reading > stats.in_progress.length && (
                  <span className="text-xs text-slate-500">
                    Recent {stats.in_progress.length} of {stats.currently_reading.toLocaleString()}
                  </span>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {stats.in_progress.map((b) => (
                  <ReadingRow key={b.id} book={b} onOpen={() => open(b)} />
                ))}
              </div>
            </section>
          )}

          {/* Category breakdown */}
          {stats.categories.length > 0 && (
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-300">By category</h2>
                <Button variant="ghost" onClick={() => goto("library")}>
                  Browse library <Icon name="chevron" className="h-4 w-4" />
                </Button>
              </div>
              <div className="overflow-hidden rounded-xl border border-white/10">
                {stats.categories.map((c, i) => (
                  <div
                    key={c.name}
                    className={cx("flex items-center gap-4 px-4 py-3", i % 2 === 0 ? "bg-white/[0.02]" : "")}
                  >
                    <div className="w-40 shrink-0 truncate text-sm font-medium">{c.name}</div>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-accent-500 to-amber-500"
                        style={{ width: `${(c.total / maxCat) * 100}%` }}
                      />
                    </div>
                    <div className="w-28 shrink-0 text-right text-xs text-slate-400">
                      {c.finished}/{c.total} read
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Recently finished */}
          {stats.recent_finished.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-slate-300">Recently finished</h2>
              <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 md:grid-cols-6">
                {stats.recent_finished.map((b) => (
                  <FinishedCard key={b.id} book={b} onOpen={() => open(b)} />
                ))}
              </div>
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: string;
  tone: "accent" | "green" | "amber" | "blue";
}) {
  const tones = {
    accent: "from-accent-500/20 to-accent-500/5 text-accent-300",
    green: "from-emerald-500/20 to-emerald-500/5 text-emerald-300",
    amber: "from-amber-500/20 to-amber-500/5 text-amber-300",
    blue: "from-sky-500/20 to-sky-500/5 text-sky-300",
  }[tone];
  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-slate-400">{label}</span>
        <div className={cx("grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br", tones)}>
          <Icon name={icon} className="h-4 w-4" />
        </div>
      </div>
      <div className="mt-3 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3">
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-slate-500">{label}</div>
    </div>
  );
}

function ReadingRow({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const pct = book.pages && book.pages > 0 ? Math.round((book.current_page / book.pages) * 100) : 0;
  const img = assetUrl(book.cover_path);
  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3 text-left transition-colors hover:bg-white/[0.06]"
    >
      <div className="h-16 w-11 shrink-0 overflow-hidden rounded bg-slate-800">
        {img ? (
          <img src={img} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600">
            <Icon name="book" className="h-5 w-5" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{book.title}</div>
        <div className="truncate text-[11px] text-slate-500">{book.author ?? "Unknown author"}</div>
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-accent-500" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[11px] tabular-nums text-slate-400">{pct}%</span>
        </div>
      </div>
    </button>
  );
}

function FinishedCard({ book, onOpen }: { book: Book; onOpen: () => void }) {
  const img = assetUrl(book.cover_path);
  return (
    <button onClick={onOpen} className="group text-left" title={book.title}>
      <div className="relative aspect-[2/3] w-full overflow-hidden rounded-cover border border-white/10 bg-gradient-to-br from-slate-800 to-slate-900">
        {img ? (
          <img src={img} alt={book.title} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-2 text-center text-[10px] text-slate-500">
            {book.title}
          </div>
        )}
      </div>
      <div className="mt-1.5 truncate text-xs font-medium">{book.title}</div>
      {book.rating != null && (
        <div className="mt-0.5">
          <StarRating value={book.rating} size="h-3 w-3" />
        </div>
      )}
    </button>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-white/15 bg-white/[0.02] px-8 py-14 text-center">
      <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-accent-500/15 text-accent-300">
        <Icon name="book" className="h-7 w-7" />
      </div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{body}</p>
      <div className="mt-6 flex justify-center">{action}</div>
    </div>
  );
}
