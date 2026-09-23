import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { openReaderWindow, readsInApp } from "../open-book";
import {
  api,
  assetUrl,
  Book,
  BookEdit,
  Kind,
  MetaCandidate,
  POPULAR_CATEGORIES,
  Status,
  StatusCounts,
  CategoryCount,
  tagsOf,
} from "../api";
import { Badge, Button, Icon, Spinner, StarRating, cx, statusMeta } from "../ui";
import { groupBySeries, SeriesGroup, Shelf, seriesOf, shelfCover } from "../series";

type SortKey = "title" | "author" | "category" | "status" | "progress" | "rating" | "pages";
type StatusFilter = "all" | Status;
type ViewMode = "list" | "grid";
const PAGE_SIZE = 120;
const LIST_COLUMNS: SortKey[] = ["title", "author", "category", "status", "progress", "rating", "pages"];
const DEFAULT_COLUMN_WIDTHS: Record<SortKey, number> = {
  title: 300,
  author: 160,
  category: 130,
  status: 100,
  progress: 125,
  rating: 110,
  pages: 75,
};
const MIN_COLUMN_WIDTHS: Record<SortKey, number> = {
  title: 140,
  author: 90,
  category: 90,
  status: 85,
  progress: 105,
  rating: 95,
  pages: 65,
};

function columnWidthKey(kind: Kind) {
  return `bv.libraryColumns.${kind}`;
}

function loadColumnWidths(kind: Kind): Record<SortKey, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(columnWidthKey(kind)) ?? "null");
    if (!saved || typeof saved !== "object") return { ...DEFAULT_COLUMN_WIDTHS };
    return Object.fromEntries(
      LIST_COLUMNS.map((key) => {
        const width = saved[key];
        return [key, typeof width === "number" && Number.isFinite(width)
          ? Math.max(MIN_COLUMN_WIDTHS[key], Math.min(width, 1200))
          : DEFAULT_COLUMN_WIDTHS[key]];
      })
    ) as Record<SortKey, number>;
  } catch {
    return { ...DEFAULT_COLUMN_WIDTHS };
  }
}

/** Comics are cover-led, so they open in grid by default; books in list. */
function viewKey(kind: Kind) {
  return `bv.libraryView.${kind}`;
}

function loadViewMode(kind: Kind): ViewMode {
  const saved = localStorage.getItem(viewKey(kind));
  if (saved === "grid" || saved === "list") return saved;
  return kind === "comic" ? "grid" : "list";
}

const STATUS_TABS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "reading", label: "Reading" },
  { id: "finished", label: "Finished" },
];

function progressPct(b: Book): number {
  if (b.status === "finished") return 100;
  if (b.pages && b.pages > 0) return Math.min(100, Math.round((b.current_page / b.pages) * 100));
  return 0;
}

export default function Library({
  reloadToken,
  onReload,
  onOpen,
  kind,
  tag = null,
}: {
  reloadToken: number;
  onReload: () => void;
  /** Hands the book to the system reader; resolves with the updated row. */
  onOpen: (book: Book) => Promise<Book>;
  /** Which half of the library this view shows. */
  kind: Kind;
  /** Sidebar collection selected from a book's comma-separated tags. */
  tag?: string | null;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [category, setCategory] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "title", dir: 1 });
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [view, setView] = useState<ViewMode>(() => loadViewMode(kind));
  const [columnWidths, setColumnWidths] = useState(() => loadColumnWidths(kind));
  const resizing = useRef<{ key: SortKey; startX: number; startWidth: number } | null>(null);
  /** Comics only: the series currently opened, by group key. */
  const [openSeries, setOpenSeries] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  const [serverCounts, setServerCounts] = useState<StatusCounts | null>(null);
  const [serverCategories, setServerCategories] = useState<CategoryCount[]>([]);
  const [page, setPage] = useState(0);
  const deferredSearch = useDeferredValue(search);
  const bookQueryKey =
    kind === "book"
      ? [reloadToken, status, category, deferredSearch, sort.key, sort.dir, tag ?? "", page].join("\u0001")
      : String(reloadToken);

  // Remember the last chosen layout per section, across launches.
  useEffect(() => {
    localStorage.setItem(viewKey(kind), view);
  }, [view, kind]);

  useEffect(() => {
    localStorage.setItem(columnWidthKey(kind), JSON.stringify(columnWidths));
  }, [columnWidths, kind]);

  function startResize(key: SortKey, event: React.PointerEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
    resizing.current = { key, startX: event.clientX, startWidth: columnWidths[key] };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: React.PointerEvent<HTMLSpanElement>) {
    const current = resizing.current;
    if (!current) return;
    const width = Math.max(MIN_COLUMN_WIDTHS[current.key], Math.min(1200, current.startWidth + event.clientX - current.startX));
    setColumnWidths((previous) => ({ ...previous, [current.key]: width }));
  }

  function stopResize() {
    resizing.current = null;
  }

  function nudgeColumn(key: SortKey, direction: -1 | 1) {
    setColumnWidths((previous) => ({
      ...previous,
      [key]: Math.max(MIN_COLUMN_WIDTHS[key], Math.min(1200, previous[key] + direction * 16)),
    }));
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const request =
      kind === "book"
        ? Promise.all([
            api.queryLibrary({
              kind,
              status,
              category,
              tag,
              search: deferredSearch,
              sort: sort.key,
              descending: sort.dir === -1,
              offset: page * PAGE_SIZE,
              limit: PAGE_SIZE,
            }),
            api.listCategories(),
          ]).then(([result, allCategories]) => {
            if (!alive) return;
            setBooks(result.books);
            setTotal(result.total);
            setServerCounts(result.counts);
            setServerCategories(result.categories);
            setCategories(allCategories);
            const lastPage = Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1);
            if (page > lastPage) setPage(lastPage);
          })
        : Promise.all([api.listBooks(), api.listCategories()]).then(([allBooks, allCategories]) => {
            if (!alive) return;
            const comics = allBooks.filter((x) => x.kind === kind);
            setBooks(comics);
            setTotal(comics.length);
            setServerCounts(null);
            setServerCategories([]);
            setCategories(allCategories);
          });
    request
      .catch(() => {})
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [bookQueryKey, kind]);

  useEffect(() => {
    setPage(0);
  }, [status, category, deferredSearch, sort.key, sort.dir, kind, tag]);

  useEffect(() => {
    setSelectedId(null);
    setOpenSeries(null);
  }, [tag]);

  const selected = useMemo(() => books.find((b) => b.id === selectedId) ?? null, [books, selectedId]);

  const upsert = (b: Book) => {
    const old = books.find((x) => x.id === b.id);
    setBooks((prev) => prev.map((x) => (x.id === b.id ? b : x)));
    if (kind === "book" || old?.tags !== b.tags) onReload();
  };

  /**
   * EPUBs open in their own reader window so reading sits alongside the
   * library rather than covering it; other formats go to the OS.
   */
  async function openInReader(book: Book) {
    if (!readsInApp(book)) {
      try {
        upsert(await onOpen(book));
      } catch (e) {
        alert(String(e));
      }
      return;
    }
    // Reading updates progress in its own window; refresh when it closes.
    await openReaderWindow(book, onReload);
  }

  const counts = useMemo(() => {
    if (kind === "book") return new Map(serverCategories.map((c) => [c.name, c.total]));
    const c = new Map<string, number>();
    for (const b of books) {
      const key = b.category && b.category.trim() ? b.category : "Uncategorized";
      c.set(key, (c.get(key) ?? 0) + 1);
    }
    return c;
  }, [books, kind, serverCategories]);

  const filtered = useMemo(() => {
    if (kind === "book") return books;
    const q = search.trim().toLowerCase();
    const rows = books.filter((b) => {
      if (status !== "all" && b.status !== status) return false;
      if (tag && !tagsOf(b.tags).some((t) => t.toLowerCase() === tag.toLowerCase())) return false;
      if (category !== "all") {
        const cat = b.category && b.category.trim() ? b.category : "Uncategorized";
        if (cat !== category) return false;
      }
      if (q) {
        const hay = `${b.title} ${b.author ?? ""} ${b.series ?? ""} ${b.tags ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const dir = sort.dir;
    const val = (b: Book): string | number => {
      switch (sort.key) {
        case "author":
          return (b.author ?? "").toLowerCase();
        case "category":
          return (b.category ?? "").toLowerCase();
        case "status":
          return b.status;
        case "progress":
          return progressPct(b);
        case "rating":
          return b.rating ?? -1;
        case "pages":
          return b.pages ?? -1;
        default:
          // Sorting comics by title alone puts volume 10 ahead of volume 2.
          // Sort by series, then by number, so runs stay in reading order.
          if (kind === "comic") {
            const { name, volume } = seriesOf(b);
            const n = volume == null ? "zzzzzz" : String(volume).padStart(6, "0");
            // Joined with a NUL so a shorter series name always sorts ahead of a
            // longer one beginning with it — "Saga" before "Saga: Extras" — since
            // NUL precedes every printable character. Written as an escape: a raw
            // NUL in the source makes git treat this whole file as binary.
            return `${name.toLowerCase()}\u0000${n}`;
          }
          return b.title.toLowerCase();
      }
    };
    return [...rows].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * dir;
      if (va > vb) return 1 * dir;
      return a.title.localeCompare(b.title);
    });
  }, [books, status, category, search, sort, kind, tag]);

  function toggleSort(key: SortKey) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));
  }

  const categoryOptions = useMemo(() => Array.from(counts.keys()).sort(), [counts]);

  // Comics collapse into series shelves; books stay flat. Grouping runs after
  // filtering, so a search that matches three volumes of a run shows a shelf of
  // three rather than the whole run.
  const shelves = useMemo<Shelf[] | null>(
    () => (kind === "comic" ? groupBySeries(filtered) : null),
    [kind, filtered]
  );

  const current = useMemo<SeriesGroup | null>(() => {
    if (!openSeries || !shelves) return null;
    const g = shelves.find((s) => s.kind === "series" && s.key === openSeries);
    return (g as SeriesGroup) ?? null;
  }, [openSeries, shelves]);

  // Filters can dissolve the series you were looking at — don't strand the view
  // on an empty shelf.
  useEffect(() => {
    if (openSeries && !current) setOpenSeries(null);
  }, [openSeries, current]);

  // Inside a series the grid runs in volume order; the table keeps answering to
  // its own sort headers, so it filters the already-sorted list instead.
  const shelfCount = shelves?.filter((s) => s.kind === "series").length ?? 0;
  const gridRows = current ? current.books : filtered;
  const tableRows = useMemo(() => {
    if (!current) return filtered;
    const ids = new Set(current.books.map((b) => b.id));
    return filtered.filter((b) => ids.has(b.id));
  }, [current, filtered]);
  const resultCount = kind === "book" ? total : filtered.length;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-4">
        {current ? (
          <div className="flex min-w-0 items-center gap-3">
            <button
              onClick={() => setOpenSeries(null)}
              title="Back to all comics"
              className="shrink-0 rounded-lg border border-white/10 bg-white/5 p-2 text-slate-300 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Icon name="chevron" className="h-4 w-4 rotate-180" />
            </button>
            <div className="min-w-0">
              <h1 className="truncate text-2xl font-semibold tracking-tight" title={current.name}>
                {current.name}
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                {current.books.length.toLocaleString()}{" "}
                {current.books.length === 1 ? "volume" : "volumes"}
                {current.finished > 0 && ` · ${current.finished} read`}
              </p>
            </div>
          </div>
        ) : (
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {kind === "comic" ? "Comics" : tag ?? "Books"}
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              {resultCount.toLocaleString()}{" "}
              {kind === "comic"
                ? resultCount === 1
                  ? "issue"
                  : "issues"
                : resultCount === 1
                  ? "book"
                  : "books"}
              {tag && " in this collection"}
              {shelfCount > 0 &&
                ` in ${shelfCount.toLocaleString()} ${shelfCount === 1 ? "series" : "series"}`}
              {status !== "all" && ` · ${status}`}
            </p>
          </div>
        )}
      </header>

      {/* Status tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => {
          const count =
            kind === "book" && serverCounts
              ? serverCounts[t.id]
              : t.id === "all"
                ? books.length
                : books.filter((b) => b.status === t.id).length;
          return (
            <button
              key={t.id}
              onClick={() => setStatus(t.id)}
              className={cx(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                status === t.id
                  ? "border-accent-500/40 bg-accent-500/20 text-white"
                  : "border-white/10 bg-white/5 text-slate-300 hover:bg-white/10"
              )}
            >
              {t.label}
              <span className="ml-1 text-slate-500">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Search + category */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search title, author, series…"
            className="w-full rounded-lg border border-white/10 bg-white/5 py-2.5 pl-10 pr-3 text-sm outline-none placeholder:text-slate-500 focus:border-accent-500/50"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-lg border border-white/10 bg-white/5 px-3 py-2.5 text-sm outline-none focus:border-accent-500/50"
        >
          <option value="all">All categories</option>
          {categoryOptions.map((c) => (
            <option key={c} value={c}>
              {c} ({counts.get(c)})
            </option>
          ))}
        </select>

        {/* Layout toggle */}
        <div className="flex shrink-0 gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5">
          {([
            { id: "list" as ViewMode, icon: "list", label: "List view" },
            { id: "grid" as ViewMode, icon: "grid", label: "Grid view" },
          ]).map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              title={v.label}
              aria-label={v.label}
              aria-pressed={view === v.id}
              className={cx(
                "rounded-md px-2.5 py-2 transition-colors",
                view === v.id ? "bg-accent-600 text-on-accent" : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              )}
            >
              <Icon name={v.icon} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-3 py-10 text-slate-400">
          <Spinner className="h-5 w-5" /> Loading library…
        </div>
      ) : resultCount === 0 ? (
        <p className="py-10 text-center text-sm text-slate-500">
          {books.length === 0
            ? kind === "comic"
              ? "No comics yet — set your comics folder in Settings and scan."
              : "No books yet — set your folder and scan."
            : "Nothing matches these filters."}
        </p>
      ) : view === "grid" ? (
        // Columns are decided by how many covers fit, not by named breakpoints.
        // A fixed ladder stops somewhere — six columns, in this case — and past
        // that every extra pixel of window went into making the covers bigger
        // instead of showing more of them.
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-x-4 gap-y-5">
          {shelves && !current
            ? shelves.map((s) =>
                s.kind === "series" ? (
                  <SeriesCard key={s.key} group={s} onOpen={() => setOpenSeries(s.key)} />
                ) : (
                  <BookCard
                    key={s.book.id}
                    book={s.book}
                    active={s.book.id === selectedId}
                    onClick={() => setSelectedId(s.book.id)}
                    onOpen={() => openInReader(s.book)}
                  />
                )
              )
            : gridRows.map((b) => (
                <BookCard
                  key={b.id}
                  book={b}
                  active={b.id === selectedId}
                  onClick={() => setSelectedId(b.id)}
                  onOpen={() => openInReader(b)}
                />
              ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table
            className="table-fixed min-w-full text-sm"
            style={{ width: LIST_COLUMNS.reduce((sum, key) => sum + columnWidths[key], 0) }}
          >
            <colgroup>
              {LIST_COLUMNS.map((key) => <col key={key} style={{ width: columnWidths[key] }} />)}
            </colgroup>
            <thead>
              <tr className="border-b border-white/10 bg-white/[0.03] text-left text-xs text-slate-400">
                <Th onClick={() => toggleSort("title")} sort={sort} col="title" width={columnWidths.title} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn} className="pl-4">Title</Th>
                <Th onClick={() => toggleSort("author")} sort={sort} col="author" width={columnWidths.author} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn}>Author</Th>
                <Th onClick={() => toggleSort("category")} sort={sort} col="category" width={columnWidths.category} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn}>Category</Th>
                <Th onClick={() => toggleSort("status")} sort={sort} col="status" width={columnWidths.status} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn}>Status</Th>
                <Th onClick={() => toggleSort("progress")} sort={sort} col="progress" width={columnWidths.progress} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn}>Progress</Th>
                <Th onClick={() => toggleSort("rating")} sort={sort} col="rating" width={columnWidths.rating} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn}>Rating</Th>
                <Th onClick={() => toggleSort("pages")} sort={sort} col="pages" width={columnWidths.pages} onResizeStart={startResize} onResizeMove={moveResize} onResizeEnd={stopResize} onNudge={nudgeColumn} className="pr-4 text-right">Pages</Th>
              </tr>
            </thead>
            <tbody>
              {shelves && !current
                ? shelves.map((s, i) =>
                    s.kind === "series" ? (
                      <SeriesRow
                        key={s.key}
                        group={s}
                        striped={i % 2 === 1}
                        onOpen={() => setOpenSeries(s.key)}
                      />
                    ) : (
                      <BookRow
                        key={s.book.id}
                        book={s.book}
                        striped={i % 2 === 1}
                        active={s.book.id === selectedId}
                        onClick={() => setSelectedId(s.book.id)}
                        onOpen={() => openInReader(s.book)}
                      />
                    )
                  )
                : tableRows.map((b, i) => (
                    <BookRow
                      key={b.id}
                      book={b}
                      striped={i % 2 === 1}
                      active={b.id === selectedId}
                      onClick={() => setSelectedId(b.id)}
                      onOpen={() => openInReader(b)}
                    />
                  ))}
            </tbody>
          </table>
        </div>
      )}

      {kind === "book" && total > PAGE_SIZE && (
        <nav className="flex items-center justify-center gap-3" aria-label="Library pages">
          <Button variant="subtle" disabled={page === 0 || loading} onClick={() => setPage((p) => Math.max(0, p - 1))}>
            Previous
          </Button>
          <span className="text-sm tabular-nums text-slate-400">
            Page {page + 1} of {pageCount}
          </span>
          <Button
            variant="subtle"
            disabled={page + 1 >= pageCount || loading}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
          >
            Next
          </Button>
        </nav>
      )}

      {selected && (
        <BookDrawer
          key={selected.id}
          book={selected}
          categories={categories}
          onClose={() => setSelectedId(null)}
          onChange={upsert}
          onOpen={() => openInReader(selected)}
          onOpenExternally={async () => {
            try {
              upsert(await onOpen(selected));
            } catch (e) {
              alert(String(e));
            }
          }}
          onDeleted={(id) => {
            setBooks((prev) => prev.filter((x) => x.id !== id));
            setSelectedId(null);
            onReload();
          }}
        />
      )}
    </div>
  );
}

function Th({
  children,
  onClick,
  sort,
  col,
  width,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onNudge,
  className,
}: {
  children: React.ReactNode;
  onClick: () => void;
  sort: { key: SortKey; dir: 1 | -1 };
  col: SortKey;
  width: number;
  onResizeStart: (key: SortKey, event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizeMove: (event: React.PointerEvent<HTMLSpanElement>) => void;
  onResizeEnd: () => void;
  onNudge: (key: SortKey, direction: -1 | 1) => void;
  className?: string;
}) {
  const active = sort.key === col;
  return (
    <th className={cx("relative select-none overflow-hidden px-3 py-2.5 font-medium", className)}>
      <button onClick={onClick} className={cx("inline-flex items-center gap-1 hover:text-slate-200", active && "text-slate-200")}>
        {children}
        {active && <span className="text-[10px]">{sort.dir === 1 ? "▲" : "▼"}</span>}
      </button>
      <span
        role="separator"
        aria-label={`Resize ${String(children)} column`}
        aria-orientation="vertical"
        aria-valuemin={MIN_COLUMN_WIDTHS[col]}
        aria-valuemax={1200}
        aria-valuenow={width}
        tabIndex={0}
        title={`Drag to resize ${String(children)}; use arrow keys for fine adjustment`}
        onPointerDown={(event) => onResizeStart(col, event)}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onNudge(col, event.key === "ArrowLeft" ? -1 : 1);
        }}
        className="absolute inset-y-0 right-0 z-10 w-2 cursor-col-resize touch-none border-r border-white/10 hover:border-accent-500 focus:border-accent-500 focus:outline-none"
      />
    </th>
  );
}

function BookRow({
  book,
  striped,
  active,
  onClick,
  onOpen,
}: {
  book: Book;
  striped: boolean;
  active: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const pct = progressPct(book);
  const sm = statusMeta(book.status);
  return (
    <tr
      onClick={onClick}
      onDoubleClick={onOpen}
      className={cx(
        "group cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.05]",
        active ? "bg-accent-500/10" : striped ? "bg-white/[0.015]" : ""
      )}
    >
      <td className="py-1.5 pl-4 pr-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-medium text-slate-200" title={book.title}>
            {book.title}
          </div>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">{book.format}</span>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onOpen();
            }}
            aria-label={`Open ${book.title}`}
            title={`Open ${book.title}`}
            className="shrink-0 rounded p-0.5 text-slate-500 opacity-0 hover:text-accent-400 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500 group-hover:opacity-100"
          >
            <Icon name="read" className="h-3.5 w-3.5" />
          </button>
        </div>
      </td>
      <td className="px-3 text-slate-300">
        <span className="line-clamp-1">{book.author ?? "—"}</span>
      </td>
      <td className="px-3 text-slate-400"><div className="truncate">{book.category?.trim() || "—"}</div></td>
      <td className="px-3">
        <Badge tone={sm.tone}>{sm.label}</Badge>
      </td>
      <td className="px-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <div
              className={cx("h-full rounded-full", book.status === "finished" ? "bg-emerald-500" : "bg-accent-500")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="w-8 text-[11px] tabular-nums text-slate-400">{pct}%</span>
        </div>
      </td>
      <td className="px-3">
        {book.rating != null ? <StarRating value={book.rating} size="h-3.5 w-3.5" /> : <span className="text-slate-600">—</span>}
      </td>
      <td className="py-1.5 pl-3 pr-4 text-right tabular-nums text-slate-300">
        {book.pages?.toLocaleString() ?? "—"}
      </td>
    </tr>
  );
}

/** Grid tile: cover plus title, nothing else. Same interactions as a row —
 *  click selects, double-click (or the hover button) opens the reader. */
function BookCard({
  book,
  active,
  onClick,
  onOpen,
}: {
  book: Book;
  active: boolean;
  onClick: () => void;
  onOpen: () => void;
}) {
  const img = assetUrl(book.cover_path);
  return (
    <div className="group cursor-pointer" onClick={onClick} onDoubleClick={onOpen}>
      <div
        className={cx(
          "relative aspect-[2/3] overflow-hidden rounded-cover border bg-slate-800 transition-colors",
          active ? "border-accent-500/60 ring-2 ring-accent-500/25" : "border-white/10 group-hover:border-white/25"
        )}
      >
        {img ? (
          <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="grid h-full w-full place-items-center text-slate-600">
            <Icon name="book" className="h-8 w-8" />
          </div>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          title={`Read in your default ${book.format.toUpperCase()} reader`}
          className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="rounded-full bg-white/15 p-2.5 backdrop-blur">
            <Icon name="read" className="h-5 w-5 text-on-scrim" />
          </span>
        </button>
      </div>
      <div
        className={cx(
          "mt-2 line-clamp-2 text-[13px] font-medium leading-snug",
          active ? "text-white" : "text-slate-300"
        )}
        title={book.title}
      >
        {book.title}
      </div>
    </div>
  );
}

/** Grid tile for a whole run: the first volume's cover, with the rest stacked
 *  behind it. Clicking opens the series rather than a reader. */
function SeriesCard({ group, onOpen }: { group: SeriesGroup; onOpen: () => void }) {
  const lead = shelfCover(group);
  const img = assetUrl(lead?.cover_path ?? null);
  return (
    <div className="group cursor-pointer" onClick={onOpen}>
      <div className="relative aspect-[2/3]">
        {/* The cover sits at the left of the box and two plates fan out behind
            it to the right, so a series reads as a stack at a glance. Everything
            stays inside the tile — no bleeding into the grid gap. */}
        <div className="absolute inset-y-4 left-4 right-0 rounded-cover border border-white/10 bg-slate-600 shadow-lg transition-transform group-hover:translate-x-1" />
        <div className="absolute inset-y-2 left-2 right-2 rounded-cover border border-white/10 bg-slate-500 shadow-lg transition-transform group-hover:translate-x-0.5" />
        <div className="absolute inset-y-0 left-0 right-4 overflow-hidden rounded-cover border border-white/10 bg-slate-800 shadow-xl transition-colors group-hover:border-white/25">
          {img ? (
            <img src={img} alt="" className="h-full w-full object-cover" loading="lazy" />
          ) : (
            <div className="grid h-full w-full place-items-center text-slate-600">
              <Icon name="books" className="h-8 w-8" />
            </div>
          )}
          <span className="absolute right-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-on-scrim backdrop-blur">
            {group.books.length}
          </span>
          <div className="absolute inset-0 grid place-items-center bg-black/55 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex items-center gap-1.5 rounded-full bg-on-scrim/15 px-3 py-1.5 text-xs font-medium text-on-scrim backdrop-blur">
              <Icon name="folder" className="h-4 w-4" /> Open series
            </span>
          </div>
        </div>
      </div>
      <div
        className="mt-2 line-clamp-2 text-[13px] font-medium leading-snug text-slate-300 group-hover:text-white"
        title={group.name}
      >
        {group.name}
      </div>
      <div className="text-[11px] text-slate-500">
        {group.books.length} volumes
        {group.finished > 0 && ` · ${group.finished} read`}
      </div>
    </div>
  );
}

/** Table row for a run. Aggregates what the columns can sensibly aggregate and
 *  leaves the rest blank — a series has no single rating. */
function SeriesRow({
  group,
  striped,
  onOpen,
}: {
  group: SeriesGroup;
  striped: boolean;
  onOpen: () => void;
}) {
  const authors = new Set(group.books.map((b) => b.author).filter(Boolean) as string[]);
  const cats = new Set(group.books.map((b) => b.category?.trim()).filter(Boolean) as string[]);
  const pages = group.books.reduce((n, b) => n + (b.pages ?? 0), 0);
  const pct = Math.round((group.finished / group.books.length) * 100);

  return (
    <tr
      onClick={onOpen}
      className={cx(
        "group cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.05]",
        striped ? "bg-white/[0.015]" : ""
      )}
    >
      <td className="py-1.5 pl-4 pr-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="min-w-0 flex-1 truncate font-medium text-slate-200" title={group.name}>{group.name}</div>
          <span className="shrink-0 text-[10px] text-slate-500">{group.books.length} volumes</span>
        </div>
      </td>
      <td className="px-3 text-slate-300">
        <span className="line-clamp-1">
          {authors.size === 1 ? [...authors][0] : authors.size > 1 ? "Various" : "—"}
        </span>
      </td>
      <td className="px-3 text-slate-400">
        <div className="truncate">{cats.size === 1 ? [...cats][0] : cats.size > 1 ? "Various" : "—"}</div>
      </td>
      <td className="px-3">
        <Badge tone="slate">
          {group.finished === group.books.length ? "Finished" : `${group.finished}/${group.books.length}`}
        </Badge>
      </td>
      <td className="px-3">
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
            <div
              className={cx("h-full rounded-full", pct === 100 ? "bg-emerald-500" : "bg-accent-500")}
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="w-8 text-[11px] tabular-nums text-slate-400">{pct}%</span>
        </div>
      </td>
      <td className="px-3 text-slate-600">
        <Icon name="chevron" className="h-4 w-4 text-slate-500 transition-transform group-hover:translate-x-0.5" />
      </td>
      <td className="py-1.5 pl-3 pr-4 text-right tabular-nums text-slate-300">
        {pages > 0 ? pages.toLocaleString() : "—"}
      </td>
    </tr>
  );
}

// ---------------- detail drawer ----------------

function BookDrawer({
  book,
  categories,
  onClose,
  onChange,
  onDeleted,
  onOpen,
  onOpenExternally,
}: {
  book: Book;
  categories: string[];
  onClose: () => void;
  onChange: (b: Book) => void;
  onDeleted: (id: number) => void;
  onOpen: () => Promise<void>;
  /** Hands the file to the OS instead of the built-in reader. */
  onOpenExternally: () => Promise<void>;
}) {
  const [form, setForm] = useState<BookEdit>(toEdit(book));
  const [savingEdit, setSavingEdit] = useState(false);
  const [opening, setOpening] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [candidates, setCandidates] = useState<MetaCandidate[] | null>(null);
  const [query, setQuery] = useState(`${book.title} ${book.author ?? ""}`.trim());
  const [busyStatus, setBusyStatus] = useState(false);

  const img = assetUrl(book.cover_path);
  const dirty = JSON.stringify(form) !== JSON.stringify(toEdit(book));

  // Categories already in use, followed by popular presets, de-duplicated.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of [...categories, ...POPULAR_CATEGORIES]) {
      const key = c.trim();
      if (key && !seen.has(key.toLowerCase())) {
        seen.add(key.toLowerCase());
        out.push(key);
      }
    }
    return out;
  }, [categories]);

  function set<K extends keyof BookEdit>(key: K, value: BookEdit[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function saveEdit() {
    setSavingEdit(true);
    try {
      const updated = await api.updateBook(book.id, normalize(form));
      onChange(updated);
    } catch (e) {
      alert(String(e));
    } finally {
      setSavingEdit(false);
    }
  }

  async function changeStatus(status: Status) {
    setBusyStatus(true);
    try {
      onChange(await api.setStatus(book.id, status));
    } catch (e) {
      alert(String(e));
    } finally {
      setBusyStatus(false);
    }
  }

  async function changeProgress(page: number) {
    try {
      onChange(await api.setProgress(book.id, page));
    } catch (e) {
      alert(String(e));
    }
  }

  async function changeRating(r: number | null) {
    try {
      onChange(await api.setRating(book.id, r));
    } catch (e) {
      alert(String(e));
    }
  }

  async function runFetch() {
    setFetching(true);
    setCandidates(null);
    try {
      setCandidates(await api.searchMetadata(query));
    } catch (e) {
      alert(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function applyCandidate(c: MetaCandidate) {
    setFetching(true);
    try {
      const updated = await api.applyMetadata(book.id, c);
      onChange(updated);
      setForm(toEdit(updated));
      setCandidates(null);
    } catch (e) {
      alert(String(e));
    } finally {
      setFetching(false);
    }
  }

  async function del() {
    if (!confirm(`Remove "${book.title}" from the library?\n\nThis only removes it from Shelfmark — the file on disk is left untouched.`))
      return;
    try {
      await api.deleteBook(book.id);
      onDeleted(book.id);
    } catch (e) {
      alert(String(e));
    }
  }

  async function openFile() {
    try {
      await revealItemInDir(book.path);
    } catch (e) {
      alert(String(e));
    }
  }

  async function read() {
    setOpening(true);
    try {
      await onOpen();
    } finally {
      setOpening(false);
    }
  }

  async function openExternally() {
    await onOpenExternally();
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bv-fade flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-white/10 bg-slate-950/95 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/10 bg-slate-950/95 px-5 py-4 backdrop-blur">
          <span className="text-sm font-medium text-slate-400">Book details</span>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white">
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-6 p-5">
          {/* Header: cover + title + reading state */}
          <div className="flex gap-4">
            <div className="h-44 w-30 shrink-0 overflow-hidden rounded-cover border border-white/10 bg-slate-800" style={{ width: "8rem" }}>
              {img ? (
                <img src={img} alt={book.title} className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center text-slate-600">
                  <Icon name="book" className="h-8 w-8" />
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold leading-tight">{book.title}</h2>
              <p className="mt-0.5 text-sm text-slate-400">{book.author ?? "Unknown author"}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge tone="slate">{book.format.toUpperCase()}</Badge>
                {book.category?.trim() && <Badge tone="accent">{book.category}</Badge>}
                {tagsOf(book.tags).map((tag) => <Badge key={tag.toLowerCase()} tone="slate">{tag}</Badge>)}
                {book.meta_status === "fetched" && <Badge tone="blue">Open Library</Badge>}
                {book.meta_status === "manual" && <Badge tone="amber">Edited</Badge>}
              </div>
              <div className="mt-3">
                <div className="mb-1 text-xs text-slate-500">Your rating</div>
                <StarRating value={book.rating} onChange={changeRating} size="h-5 w-5" />
              </div>
            </div>
          </div>

          {/* Open in the OS default reader for this format */}
          <div>
            <Button
              variant="primary"
              className="w-full justify-center"
              busy={opening}
              onClick={read}
            >
              {!opening && <Icon name="read" className="h-4 w-4" />}
              {opening ? "Opening…" : "Read now"}
            </Button>
            {book.format.toLowerCase() === "epub" ? (
              <>
                <Button
                  variant="subtle"
                  className="mt-2 w-full justify-center"
                  onClick={openExternally}
                >
                  <Icon name="open" className="h-4 w-4" /> Open in system reader
                </Button>
                <p className="mt-1.5 text-center text-[11px] text-slate-500">
                  Shelfmark's reader opens in its own window and tracks your position as you
                  go. The system reader won't report progress back.
                </p>
              </>
            ) : (
              <p className="mt-1.5 text-center text-[11px] text-slate-500">
                Opens in your default {book.format.toUpperCase()} reader. We'll ask where you got
                to when you come back.
              </p>
            )}
          </div>

          {/* Status segmented control */}
          <div>
            <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Reading status</div>
            <div className="grid grid-cols-3 gap-1 rounded-lg border border-white/10 bg-white/[0.03] p-1">
              {(["unread", "reading", "finished"] as Status[]).map((st) => {
                const active = book.status === st;
                return (
                  <button
                    key={st}
                    disabled={busyStatus}
                    onClick={() => changeStatus(st)}
                    className={cx(
                      "rounded-md py-1.5 text-xs font-medium capitalize transition-colors disabled:opacity-50",
                      active ? "bg-accent-600 text-on-accent" : "text-slate-300 hover:bg-white/5"
                    )}
                  >
                    {st}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Progress */}
          <ProgressControl book={book} onSet={changeProgress} />

          {/* Fetch metadata */}
          <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <Icon name="sparkles" className="h-3.5 w-3.5 text-accent-400" />
              <span className="text-xs font-semibold text-slate-300">Fetch metadata (Open Library)</span>
            </div>
            <div className="flex gap-2">
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && query.trim() && runFetch()}
                placeholder="Title and author…"
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-accent-500/50"
              />
              <Button variant="primary" busy={fetching} onClick={runFetch} disabled={!query.trim()}>
                {!fetching && <Icon name="search" className="h-4 w-4" />} Search
              </Button>
            </div>

            {candidates && (
              <div className="mt-3 space-y-2">
                {candidates.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No matches. Edit the fields below and save to enter the details yourself.
                  </p>
                ) : (
                  candidates.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => applyCandidate(c)}
                      disabled={fetching}
                      className="flex w-full items-center gap-3 rounded-lg border border-white/10 bg-white/[0.03] p-2 text-left transition-colors hover:border-accent-500/40 hover:bg-white/[0.06] disabled:opacity-50"
                    >
                      <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-slate-800">
                        {c.cover_url ? (
                          <img src={c.cover_url} alt="" className="h-full w-full object-cover" />
                        ) : (
                          <div className="grid h-full w-full place-items-center text-slate-600">
                            <Icon name="book" className="h-4 w-4" />
                          </div>
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{c.title}</div>
                        <div className="truncate text-xs text-slate-400">
                          {c.author ?? "Unknown"}
                          {c.year ? ` · ${c.year}` : ""}
                          {c.pages ? ` · ${c.pages} pp` : ""}
                        </div>
                      </div>
                      <Icon name="chevron" className="h-4 w-4 shrink-0 text-slate-500" />
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Editable metadata */}
          <div className="space-y-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Details</div>
            <Field label="Title">
              <input className={inputCls} value={form.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Author">
                <input className={inputCls} value={form.author ?? ""} onChange={(e) => set("author", e.target.value)} />
              </Field>
              <Field label="Series">
                <input className={inputCls} value={form.series ?? ""} onChange={(e) => set("series", e.target.value)} />
              </Field>
            </div>
            <Field label="Category / shelf">
              <CategoryPicker
                value={form.category ?? ""}
                options={categoryOptions}
                onChange={(v) => set("category", v)}
              />
            </Field>
            <Field label="Subjects / genres">
              <input className={inputCls} value={form.subjects ?? ""} onChange={(e) => set("subjects", e.target.value)} />
            </Field>
            <Field label="Tags / collections">
              <input
                className={inputCls}
                value={form.tags ?? ""}
                onChange={(e) => set("tags", e.target.value)}
                placeholder="Research, Favorites, Work"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Publisher">
                <input className={inputCls} value={form.publisher ?? ""} onChange={(e) => set("publisher", e.target.value)} />
              </Field>
              <Field label="Published">
                <input className={inputCls} value={form.published_date ?? ""} onChange={(e) => set("published_date", e.target.value)} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Language">
                <input className={inputCls} value={form.language ?? ""} onChange={(e) => set("language", e.target.value)} />
              </Field>
              <Field label="Pages">
                <input
                  type="number"
                  className={inputCls}
                  value={form.pages ?? ""}
                  onChange={(e) => set("pages", e.target.value ? parseInt(e.target.value) : null)}
                />
              </Field>
            </div>
            <Field label="ISBN">
              <input className={inputCls} value={form.isbn ?? ""} onChange={(e) => set("isbn", e.target.value)} />
            </Field>
            <Field label="Description">
              <textarea
                className={cx(inputCls, "min-h-24 resize-y leading-relaxed")}
                value={form.description ?? ""}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>

            <div className="flex items-center gap-2 pt-1">
              <Button variant="primary" busy={savingEdit} onClick={saveEdit} disabled={!dirty || !form.title.trim()}>
                {!savingEdit && <Icon name="check" className="h-4 w-4" />} Save changes
              </Button>
            </div>
          </div>

          {/* File actions */}
          <div className="flex items-center justify-between border-t border-white/10 pt-4">
            <Button variant="subtle" onClick={openFile}>
              <Icon name="open" className="h-4 w-4" /> Show file
            </Button>
            <Button variant="danger" onClick={del}>
              <Icon name="trash" className="h-4 w-4" /> Remove
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProgressControl({ book, onSet }: { book: Book; onSet: (page: number) => void }) {
  const [page, setPage] = useState(book.current_page);
  useEffect(() => setPage(book.current_page), [book.current_page, book.id]);
  const pages = book.pages ?? 0;
  const pct = pages > 0 ? Math.min(100, Math.round((page / pages) * 100)) : book.status === "finished" ? 100 : 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-semibold uppercase tracking-wide text-slate-500">Progress</span>
        <span className="tabular-nums text-slate-400">
          {pages > 0 ? `page ${page.toLocaleString()} / ${pages.toLocaleString()} · ${pct}%` : `${pct}%`}
        </span>
      </div>
      {pages > 0 ? (
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={pages}
            value={Math.min(page, pages)}
            onChange={(e) => setPage(parseInt(e.target.value))}
            onMouseUp={() => onSet(page)}
            onTouchEnd={() => onSet(page)}
            className="flex-1 accent-accent-500"
          />
          <input
            type="number"
            min={0}
            max={pages}
            value={page}
            onChange={(e) => setPage(parseInt(e.target.value) || 0)}
            onBlur={() => onSet(page)}
            className="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm outline-none focus:border-accent-500/50"
          />
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          No page count yet — add one in Details (or fetch metadata) to track page progress. Use the status
          buttons above to mark this book read.
        </p>
      )}
    </div>
  );
}

/** Dropdown of in-use + popular categories, with a "Custom…" free-text escape. */
function CategoryPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange: (v: string) => void;
}) {
  const inList = value !== "" && options.some((o) => o.toLowerCase() === value.toLowerCase());
  const [custom, setCustom] = useState(value !== "" && !inList);
  useEffect(() => {
    setCustom(value !== "" && !inList);
  }, [value, inList]);

  const selectValue = custom ? "__custom__" : inList ? value : "";

  return (
    <div className="space-y-2">
      <div className="relative">
        <select
          className={cx(inputCls, "appearance-none pr-9")}
          value={selectValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "__custom__") {
              setCustom(true);
            } else {
              setCustom(false);
              onChange(v);
            }
          }}
        >
          <option value="">— None —</option>
          <optgroup label="Categories">
            {options.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </optgroup>
          <option value="__custom__">Custom…</option>
        </select>
        <Icon
          name="chevron"
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 rotate-90 text-slate-500"
        />
      </div>
      {custom && (
        <input
          className={inputCls}
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a category…"
        />
      )}
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm outline-none placeholder:text-slate-600 focus:border-accent-500/50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-slate-500">{label}</span>
      {children}
    </label>
  );
}

function toEdit(b: Book): BookEdit {
  return {
    title: b.title,
    author: b.author,
    series: b.series,
    publisher: b.publisher,
    published_date: b.published_date,
    language: b.language,
    isbn: b.isbn,
    description: b.description,
    category: b.category,
    subjects: b.subjects,
    tags: b.tags,
    pages: b.pages,
    words: b.words,
  };
}

/** Trim strings and turn empty ones into null before sending to the backend. */
function normalize(e: BookEdit): BookEdit {
  const s = (v: string | null) => {
    const t = (v ?? "").trim();
    return t ? t : null;
  };
  return {
    title: e.title.trim(),
    author: s(e.author),
    series: s(e.series),
    publisher: s(e.publisher),
    published_date: s(e.published_date),
    language: s(e.language),
    isbn: s(e.isbn),
    description: s(e.description),
    category: s(e.category),
    subjects: s(e.subjects),
    tags: tagsOf(e.tags).join(", ") || null,
    pages: e.pages && e.pages > 0 ? e.pages : null,
    words: e.words && e.words > 0 ? e.words : null,
  };
}
