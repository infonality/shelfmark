import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Annotation, api, Book, ComicLocator, ComicSession, ReadingDirection } from "../api";
import { Clock, cx, Icon, Spinner } from "../ui";
import { IS_MAC, TRAFFIC_LIGHT_INSET } from "../platform";

/**
 * Paginated comic reader.
 *
 * A comic is far simpler than an EPUB — every page is one image, and nothing
 * reflows — so this has none of the layout machinery of the book reader. What
 * it does have to take seriously is weight: a couple of hundred pages at
 * several hundred kilobytes each is more than a window should ever hold. Pages
 * are fetched as they are reached and the neighbours are warmed in the
 * background, which is what makes a turn land instantly without keeping the
 * issue in memory.
 *
 * Direction is a reading control, not a data one: the pages keep their order in
 * the archive and only the way you move through them changes. Manga reads right
 * to left, and almost no archive says so itself, so it has to be chosen — and
 * chosen once per run rather than once per volume.
 */

/** How a page is sized against the window. */
type Fit = "width" | "height" | "actual";

const FITS: { id: Fit; label: string; hint: string }[] = [
  { id: "height", label: "Height", hint: "Fill the height and scroll across" },
  { id: "width", label: "Width", hint: "Fill the width and scroll down" },
  { id: "actual", label: "1:1", hint: "Actual size" },
];

const FIT_KEY = "bv.comicFit";
const TWO_UP_KEY = "bv.comicTwoUp";
/** A wheel gesture shouldn't fire a second turn until it settles. */
const WHEEL_COOLDOWN = 260;
/** How many pages ahead to warm. One back covers a change of mind. */
const AHEAD = 2;

function loadFit(): Fit {
  const saved = localStorage.getItem(FIT_KEY);
  // "page" was the old fit-the-whole-page mode. On a portrait scan it produced
  // the same result as fitting the height, so it went; anyone who had it
  // selected lands on the mode that behaves the way theirs did.
  if (saved === "width" || saved === "actual" || saved === "height") return saved;
  return "height";
}

/**
 * URL for a page. Each segment is encoded separately so a name with spaces or
 * non-Latin characters survives the trip, while the slashes that separate
 * folders inside the archive stay as slashes.
 */
function pageUrl(session: ComicSession, index: number): string {
  const entry = session.pages[index];
  if (!entry) return "";
  return session.resource_base + entry.split("/").map(encodeURIComponent).join("/");
}

/**
 * Group pages into what gets shown at once.
 *
 * Two rules keep a spread honest. The cover stands alone, because pairing it
 * puts every later spread one page out of step — the left-hand page should be
 * the one printed on the left. And a page wider than it is tall is a
 * double-page picture scanned as a single image, so it stands alone too;
 * pairing it would put two spreads on screen at once.
 *
 * Which pages are wide isn't known until they load, so `wide` fills in as you
 * read and the grouping settles with it.
 */
export function buildSpreads(count: number, twoUp: boolean, wide: Set<number>): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < count) {
    if (!twoUp || i === 0 || wide.has(i)) {
      out.push([i]);
      i += 1;
      continue;
    }
    if (i + 1 < count && !wide.has(i + 1)) {
      out.push([i, i + 1]);
      i += 2;
      continue;
    }
    out.push([i]);
    i += 1;
  }
  return out;
}

export default function ComicReader({
  book,
  onClose,
  onProgress,
  onOpenExternally,
}: {
  book: Book;
  onClose?: () => void;
  onProgress?: (b: Book) => void;
  onOpenExternally?: () => void;
}) {
  const [session, setSession] = useState<ComicSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [fit, setFit] = useState<Fit>(loadFit);
  const [twoUp, setTwoUp] = useState(() => localStorage.getItem(TWO_UP_KEY) === "1");
  const [direction, setDirection] = useState<ReadingDirection>("ltr");
  const [wide, setWide] = useState<Set<number>>(() => new Set());
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [loadedPages, setLoadedPages] = useState<Set<number>>(() => new Set());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [marksOpen, setMarksOpen] = useState(false);
  const rtl = direction === "rtl";

  const scrollRef = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);
  const count = session?.pages.length ?? 0;

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api
      .comicOpen(book.id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        setDirection(s.direction === "rtl" ? "rtl" : "ltr");
        let start = 0;
        if (s.locator) {
          try {
            const loc = JSON.parse(s.locator) as ComicLocator;
            if (Number.isFinite(loc.page)) start = loc.page;
          } catch {
            /* a corrupt locator just means starting at the first page */
          }
        }
        setPage(Math.min(Math.max(0, start), s.pages.length - 1));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [book.id]);

  useEffect(() => {
    localStorage.setItem(FIT_KEY, fit);
  }, [fit]);
  useEffect(() => {
    localStorage.setItem(TWO_UP_KEY, twoUp ? "1" : "0");
  }, [twoUp]);

  // ---- what's on screen ----
  const spreads = useMemo(() => buildSpreads(count, twoUp, wide), [count, twoUp, wide]);
  const at = useMemo(() => {
    const map = new Map<number, number>();
    spreads.forEach((s, i) => s.forEach((p) => map.set(p, i)));
    return map;
  }, [spreads]);
  const index = at.get(page) ?? 0;
  const shown = useMemo(() => spreads[index] ?? [page], [spreads, index, page]);
  const shownKey = shown.join(",");
  const pair = shown.length > 1;

  /** A page that turns out to be landscape is a double-page picture. */
  const noteSize = useCallback((i: number, el: HTMLImageElement) => {
    if (el.naturalWidth > el.naturalHeight) {
      setWide((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));
    }
  }, []);

  /**
   * Readiness is which pages have loaded, not how many load events have been
   * seen. Counting events cannot work here: the images are keyed by page, so
   * turning on two-page view reuses the element for the page already on screen
   * and its `src` never changes — no second event ever arrives, and a counter
   * waits for it forever behind a blank screen. Asking whether these particular
   * pages have loaded has no such gap, and a page you return to is ready at once.
   */
  const markLoaded = useCallback((i: number) => {
    setLoadedPages((prev) => (prev.has(i) ? prev : new Set(prev).add(i)));
  }, []);
  const done = shown.every((i) => loadedPages.has(i));

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [shownKey]);

  // ---- warm the neighbours ----
  // Decoding a page is the slow part, and the browser will hold these in its
  // own cache (the protocol sends Cache-Control), so a turn is instant. It also
  // learns which pages are wide before you reach them, so a spread doesn't
  // regroup under you.
  useEffect(() => {
    if (!session) return;
    const last = shown[shown.length - 1] ?? 0;
    const first = shown[0] ?? 0;
    const wanted: number[] = [];
    for (let i = 1; i <= AHEAD * (twoUp ? 2 : 1); i++) wanted.push(last + i);
    wanted.push(first - 1);
    for (const i of wanted) {
      if (i < 0 || i >= session.pages.length) continue;
      const img = new Image();
      img.onload = () => {
        noteSize(i, img);
        markLoaded(i);
      };
      img.src = pageUrl(session, i);
    }
  }, [session, shown, twoUp, noteSize, markLoaded]);

  // ---- bookmarks ----
  //
  // A comic has no text, so there is nothing to anchor to inside a page — the
  // page *is* the anchor. That fits the book reader's table without changing
  // it: the spine index carries the page, and the character offsets it also
  // stores simply have nothing to say here.
  const reloadAnnotations = useCallback(() => {
    api.listAnnotations(book.id).then(setAnnotations).catch(() => {});
  }, [book.id]);
  useEffect(reloadAnnotations, [reloadAnnotations]);

  const bookmarks = useMemo(() => {
    const pages = annotations
      .filter((a) => a.kind === "bookmark")
      .map((a) => ({ id: a.id, page: a.spine }));
    return pages.sort((a, b) => a.page - b.page);
  }, [annotations]);

  const markHere = useMemo(
    () => bookmarks.find((b) => b.page === page) ?? null,
    [bookmarks, page]
  );

  /** Bookmark this page, or drop the bookmark that is already on it. */
  const toggleBookmark = useCallback(async () => {
    try {
      if (markHere) {
        await api.deleteAnnotation(markHere.id);
      } else {
        await api.addAnnotation({
          bookId: book.id,
          spine: page,
          // Offsets anchor a passage within a chapter's text. A page has no
          // text and no inside, so there is nothing for them to point at.
          startOff: 0,
          endOff: 0,
          kind: "bookmark",
          color: "yellow",
          text: `Page ${page + 1}`,
        });
      }
      reloadAnnotations();
    } catch (e) {
      alert(String(e));
    }
  }, [markHere, book.id, page, reloadAnnotations]);

  // ---- navigation ----
  const turn = useCallback(
    (dir: 1 | -1) => {
      const next = spreads[index + dir];
      if (next) setPage(next[0]);
    },
    [spreads, index]
  );

  const goTo = useCallback(
    (n: number) => setPage(Math.min(Math.max(0, n), Math.max(0, count - 1))),
    [count]
  );

  /**
   * Flip the direction. It applies to the whole run when there is one: every
   * volume of a series reads the same way, and answering this a hundred times
   * for a hundred volumes would be its own kind of broken.
   */
  const flipDirection = useCallback(async () => {
    const next: ReadingDirection = rtl ? "ltr" : "rtl";
    setDirection(next);
    try {
      await api.setReadingDirection(book.id, next, !!session?.series);
    } catch (e) {
      setDirection(rtl ? "rtl" : "ltr");
      alert(String(e));
    }
  }, [rtl, book.id, session]);

  /**
   * Fullscreen hides the chrome on the way in and brings it back on the way
   * out, since the point of it is the page and nothing else. `i` overrides that
   * either way.
   */
  const setFull = useCallback(async (want: boolean) => {
    try {
      await getCurrentWindow().setFullscreen(want);
      setFullscreen(want);
      setChrome(!want);
    } catch {
      /* a window manager that refuses just leaves us as we were */
    }
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") return;
      switch (e.key) {
        case "Escape":
          // Escape backs out one layer at a time: the bookmark list, then
          // fullscreen, then the window. Closing the reader outright from
          // fullscreen is too big a jump.
          if (marksOpen) setMarksOpen(false);
          else if (fullscreen) setFull(false);
          else onClose?.();
          break;
        case "f":
        case "F":
          e.preventDefault();
          setFull(!fullscreen);
          break;
        case "i":
        case "I":
          e.preventDefault();
          setChrome((c) => !c);
          break;
        case "b":
        case "B":
          e.preventDefault();
          toggleBookmark();
          break;
        case "ArrowRight":
          e.preventDefault();
          turn(rtl ? -1 : 1);
          break;
        case "ArrowLeft":
          e.preventDefault();
          turn(rtl ? 1 : -1);
          break;
        // Space and PageDown mean "onward" in any direction.
        case "PageDown":
        case " ":
          e.preventDefault();
          turn(1);
          break;
        case "PageUp":
          e.preventDefault();
          turn(-1);
          break;
        case "Home":
          e.preventDefault();
          goTo(0);
          break;
        case "End":
          e.preventDefault();
          goTo(count - 1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, goTo, count, onClose, rtl, fullscreen, setFull, toggleBookmark, marksOpen]);

  /**
   * Wheel behaviour depends on the fit. With the whole page visible there is
   * nothing to scroll, so a notch turns. When the page overflows, scrolling
   * comes first and a turn only happens once you're already at the edge —
   * otherwise a long page would skip past its own bottom half.
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4) return;
      const down = e.deltaY > 0;
      const canScroll = el.scrollHeight > el.clientHeight + 1;
      if (canScroll) {
        const atEnd = down
          ? el.scrollTop + el.clientHeight >= el.scrollHeight - 2
          : el.scrollTop <= 1;
        if (!atEnd) return;
      }
      const now = Date.now();
      if (now - lastWheel.current < WHEEL_COOLDOWN) return;
      lastWheel.current = now;
      turn(down ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    return () => el.removeEventListener("wheel", onWheel);
  }, [turn]);

  // ---- persist position ----
  useEffect(() => {
    if (!session || count === 0) return;
    const locator: ComicLocator = { page };
    const t = setTimeout(() => {
      api
        .readerSavePosition(book.id, JSON.stringify(locator), (page + 1) / count)
        .then((b) => onProgress?.(b))
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [book.id, page, count, session, onProgress]);

  const percent = count > 0 ? ((shown[shown.length - 1] ?? page) + 1) / count : 0;
  const label =
    count === 0
      ? "…"
      : pair
        ? `Pages ${shown[0] + 1}–${shown[1] + 1} of ${count}`
        : `Page ${page + 1} of ${count}`;

  const imgClass =
    fit === "width"
      ? cx("h-auto", pair ? "w-1/2" : "w-full")
      : fit === "height"
        ? "h-full w-auto max-w-none"
        : "max-w-none";

  const overflow =
    fit === "width"
      ? "overflow-y-auto overflow-x-hidden"
      : fit === "height"
        ? "overflow-x-auto overflow-y-hidden"
        : "overflow-auto";

  return (
    <div
      className="relative flex h-full flex-col bg-[#0e0e11] text-slate-200"
      onPointerDown={() => setMarksOpen(false)}
    >
      {/* Chrome */}
      {chrome && (
        <header
          data-tauri-drag-region
          className="flex shrink-0 items-center gap-2 px-3 py-2"
          style={{ paddingLeft: 12 + (fullscreen ? 0 : TRAFFIC_LIGHT_INSET) }}
        >
          {onClose && !IS_MAC && !fullscreen && (
            <button
              onClick={onClose}
              title="Close (Esc)"
              className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <Icon name="x" className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1 text-center">
            <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
            <div className="truncate text-[11px] text-white/35">{label}</div>
          </div>

          <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
            {FITS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFit(f.id)}
                title={f.hint}
                className={cx(
                  "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  fit === f.id
                    ? "bg-white/15 text-white"
                    : "text-white/45 hover:bg-white/10 hover:text-white"
                )}
              >
                {f.label}
              </button>
            ))}
          </div>

          <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
            {([
              { on: false, icon: "onePage", hint: "One page at a time" },
              { on: true, icon: "twoPage", hint: "Two pages side by side" },
            ] as const).map((m) => (
              <button
                key={m.icon}
                onClick={() => setTwoUp(m.on)}
                title={m.hint}
                aria-pressed={twoUp === m.on}
                className={cx(
                  "rounded p-1.5 transition-colors",
                  twoUp === m.on
                    ? "bg-white/15 text-white"
                    : "text-white/45 hover:bg-white/10 hover:text-white"
                )}
              >
                <Icon name={m.icon} className="h-4 w-4" />
              </button>
            ))}
          </div>

          <button
            onClick={flipDirection}
            disabled={!session}
            title={
              rtl
                ? `Reading right to left${session?.series ? ` — applies to all of ${session.series}` : ""}. Click for left to right.`
                : `Reading left to right${session?.series ? ` — applies to all of ${session.series}` : ""}. Click for right to left (manga).`
            }
            className={cx(
              "shrink-0 rounded-md border px-2 py-1 text-[11px] font-medium tabular-nums transition-colors",
              rtl
                ? "border-accent-500/40 bg-accent-500/15 text-accent-300"
                : "border-white/10 text-white/45 hover:bg-white/10 hover:text-white"
            )}
          >
            {rtl ? "R → L" : "L → R"}
          </button>

          <div className="relative shrink-0" onPointerDown={(e) => e.stopPropagation()}>
            <button
              onClick={toggleBookmark}
              disabled={count === 0}
              title={markHere ? "Remove bookmark (B)" : "Bookmark this page (B)"}
              aria-pressed={!!markHere}
              className={cx(
                "rounded-md p-2 transition-colors disabled:opacity-25",
                markHere
                  ? "bg-white/15 text-accent-300"
                  : "text-white/50 hover:bg-white/10 hover:text-white"
              )}
            >
              <Icon name="bookmark" className="h-4 w-4" />
            </button>
            {bookmarks.length > 0 && (
              <button
                onClick={() => setMarksOpen((v) => !v)}
                title={`${bookmarks.length} bookmark${bookmarks.length === 1 ? "" : "s"}`}
                className={cx(
                  "ml-0.5 rounded-md px-1.5 py-2 text-[11px] tabular-nums transition-colors",
                  marksOpen
                    ? "bg-white/15 text-white"
                    : "text-white/40 hover:bg-white/10 hover:text-white"
                )}
              >
                {bookmarks.length}
              </button>
            )}
            {marksOpen && bookmarks.length > 0 && (
              <div className="absolute right-0 top-full z-40 mt-1 max-h-80 w-44 overflow-y-auto rounded-lg border border-white/10 bg-slate-900/95 py-1 shadow-2xl backdrop-blur">
                {bookmarks.map((b) => (
                  <div key={b.id} className="group flex items-center">
                    <button
                      onClick={() => {
                        goTo(b.page);
                        setMarksOpen(false);
                      }}
                      className={cx(
                        "flex-1 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-white/10",
                        b.page === page ? "text-accent-300" : "text-slate-300"
                      )}
                    >
                      Page {b.page + 1}
                    </button>
                    <button
                      onClick={() =>
                        api.deleteAnnotation(b.id).then(reloadAnnotations).catch(() => {})
                      }
                      title="Remove"
                      className="mr-1 rounded p-1 text-white/20 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    >
                      <Icon name="trash" className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => setFull(!fullscreen)}
            title={
              fullscreen
                ? "Leave fullscreen (F or Esc) — press I to hide these controls"
                : "Fullscreen (F)"
            }
            className="shrink-0 rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name={fullscreen ? "collapse" : "expand"} className="h-4 w-4" />
          </button>

          {onOpenExternally && !fullscreen && (
            <button
              onClick={onOpenExternally}
              title="Open in your system comic reader"
              className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <Icon name="open" className="h-4 w-4" />
            </button>
          )}

          <Clock className="ml-1 border-l border-white/10 pl-3" />
        </header>
      )}

      {/* The page */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className={cx("h-full w-full", overflow)}>
          {error ? (
            <div className="grid h-full place-items-center p-8">
              <div className="max-w-md text-center">
                <Icon name="warning" className="mx-auto h-8 w-8 text-amber-500" />
                <p className="mt-3 text-sm text-slate-300">{error}</p>
              </div>
            </div>
          ) : !session ? (
            <div className="grid h-full place-items-center text-slate-500">
              <Spinner className="h-6 w-6" />
            </div>
          ) : (
            <>
              {!done && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-slate-600">
                  <Spinner className="h-6 w-6" />
                </div>
              )}
              <div
                className={cx(
                  "flex h-full w-full items-center justify-center",
                  // Right to left puts the earlier page on the right, which is
                  // where it was printed.
                  rtl && pair && "flex-row-reverse",
                  fit === "actual" && "h-auto w-auto items-start justify-start"
                )}
              >
                {shown.map((i) => (
                  <img
                    key={i}
                    src={pageUrl(session, i)}
                    alt={`Page ${i + 1}`}
                    onLoad={(e) => {
                      noteSize(i, e.currentTarget);
                      markLoaded(i);
                    }}
                    // A page that fails still has to stop the spinner, or one
                    // broken image freezes the reader.
                    onError={() => markLoaded(i)}
                    className={cx(
                      imgClass,
                      "select-none",
                      done ? "opacity-100" : "opacity-0"
                    )}
                    draggable={false}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        {/* Click zones, wide enough to hit without thinking and invisible so
            they never sit on top of the art. */}
        {session && (
          <>
            <button
              onClick={() => turn(rtl ? 1 : -1)}
              aria-label={rtl ? "Next page" : "Previous page"}
              className="absolute inset-y-0 left-0 w-[15%] cursor-w-resize opacity-0"
            />
            <button
              onClick={() => turn(rtl ? -1 : 1)}
              aria-label={rtl ? "Previous page" : "Next page"}
              className="absolute inset-y-0 right-0 w-[15%] cursor-e-resize opacity-0"
            />
          </>
        )}
      </div>

      {/* Footer: a scrubber, because two hundred pages is a long way by arrow key. */}
      {chrome && (
        <footer className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-1.5">
          {/* The scrubber, with a tick per bookmark so they are visible from
              anywhere in the issue rather than only from the list. */}
          <div className="relative flex-1">
            <input
              type="range"
              min={0}
              max={Math.max(0, count - 1)}
              value={page}
              onChange={(e) => goTo(Number(e.target.value))}
              disabled={count === 0}
              aria-label="Jump to page"
              style={{ direction: rtl ? "rtl" : "ltr" }}
              className="h-1 w-full cursor-pointer appearance-none rounded-full bg-white/15 accent-accent-500"
            />
            {count > 1 &&
              bookmarks.map((b) => {
                // Ticks follow the scrubber, and the scrubber runs the other
                // way for manga.
                const along = (b.page / (count - 1)) * 100;
                return (
                  <span
                    key={b.id}
                    className="pointer-events-none absolute top-1/2 h-2 w-0.5 -translate-y-1/2 rounded-full bg-accent-400"
                    style={{ left: `${rtl ? 100 - along : along}%` }}
                  />
                );
              })}
          </div>
          <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-white/35">
            {count > 0 ? `${Math.round(percent * 100)}%` : ""}
          </span>
        </footer>
      )}
    </div>
  );
}
