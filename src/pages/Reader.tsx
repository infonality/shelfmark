import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Annotation,
  api,
  Book,
  Chapter,
  Locator,
  ReaderSession,
  SearchHit,
} from "../api";
import {
  clearMarks,
  elementForFragment,
  HIGHLIGHT_COLORS,
  markRange,
  offsetsForOccurrence,
  offsetsForSelection,
  pageForElement,
  pageForRange,
  rangeForOffsets,
} from "../reader-dom";
import {
  applyLayoutStyle,
  buildDocument,
  clearOffset,
  countPages,
  Geometry,
  geometryFor,
  internalTarget,
  Landing,
  reveal,
  SEEK_COLOR,
  settle,
  showPage,
} from "../reader-layout";
import { Clock, cx, Icon, Spinner } from "../ui";
import { IS_MAC, TRAFFIC_LIGHT_INSET } from "../platform";
import {
  DEFAULT_PREFS,
  FONT_LABELS,
  FontChoice,
  loadPrefs,
  ReaderPrefs,
  savePrefs,
  Theme,
  THEMES,
} from "../reader-prefs";

/**
 * Paginated EPUB reader, modelled on the presentation Books uses on macOS:
 * a warm paper page inset from the window, generous margins, a two-page
 * spread with a spine gutter on wide windows, and chrome that stays out of
 * the way until you reach for it.
 *
 * Chapter markup is untrusted HTML from wherever the file came from, so it
 * renders inside a sandboxed iframe. `allow-same-origin` is what lets this
 * component reach in to lay out columns and measure pages.
 *
 * SECURITY — read before touching the `sandbox` attribute. The sandbox lists
 * `allow-scripts`, which on its own alongside `allow-same-origin` would be a
 * hole big enough to hand a book `window.__TAURI__`. It is safe only because
 * three separate things stop a script running, none of which is the sandbox:
 * `reader.rs` strips `<script>`, `on*=` handlers and `javascript:` URLs before
 * the markup ever arrives; the chapter document carries `script-src 'none'` in
 * its own CSP (see `CHAPTER_CSP`); and a `srcdoc` frame inherits the app's CSP,
 * which is `script-src 'self'`. Remove any of those and this becomes unsafe.
 *
 * The flag has to be there because WebKit dispatches no DOM events at all into
 * a frame whose scripting is disabled — not wheel, not keydown, not click, not
 * contextmenu. Every listener below is installed by *this* window on the
 * chapter's document, and on macOS all of them were silently dead: pages would
 * not turn, links did nothing, the highlight menu never opened, and `settle`
 * waited out its full timeout on every chapter because image `load` never
 * fired. Blink dispatches them regardless, which is why Windows looked fine.
 * The sandbox keeps every other restriction — no forms, no popups, and no
 * navigating the app window out from under itself.
 *
 * Laying out and measuring lives in `reader-layout`; this file is the state
 * around it. Two rules keep that state honest:
 *
 *  - `layout()` never changes identity. It reads everything through refs, so
 *    nothing that merely turns a page can invalidate an effect and set off
 *    another relayout — which is what made page turns feel expensive.
 *  - Where to land is a `Landing` tagged with the spine index it belongs to,
 *    held in a ref until the chapter it names has actually settled. A relayout
 *    for anything else can't consume it, and a jump can't be lost to one.
 */

/** Wheel delta that adds up to one page turn. */
const WHEEL_THRESHOLD = 45;
/** Fastest a continuous wheel gesture may turn pages. */
const WHEEL_COOLDOWN = 110;
/** A wheel gesture that pauses this long starts accumulating afresh. */
const WHEEL_GESTURE_GAP = 400;

type Menu = {
  x: number;
  y: number;
  selection: string;
  /** Offsets of the selection, when there is one. */
  range: { start: number; end: number } | null;
} | null;

type Panel = "toc" | "search" | "notes" | null;

export default function Reader({
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
  const [session, setSession] = useState<ReaderSession | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  const [panel, setPanel] = useState<Panel>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  // The search result to keep flagged. It persists across relayouts — marks are
  // cleared and redrawn every layout, so consuming it on the first pass would
  // make the flag vanish as soon as fonts settled and triggered a second one.
  const flash = useRef<{ text: string; occurrence: number } | null>(null);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [cols, setCols] = useState<1 | 2>(1);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);

  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  /**
   * Where the next layout should land, and which chapter that instruction is
   * about. The spine tag is what stops a relayout triggered by something else —
   * a panel opening, an annotation being drawn — from consuming a jump that was
   * meant for a chapter still in flight.
   */
  const landingRef = useRef<{ spine: number; to: Landing } | null>(null);
  /**
   * Geometry the current layout was measured against. Turning a page scrolls by
   * exactly this width rather than re-measuring the frame, so a page turn can
   * never disagree with the layout it is scrolling through.
   */
  const geomRef = useRef<Geometry | null>(null);

  // Mirrors, so `layout` and the listeners bound inside the frame can read the
  // current values without being rebuilt whenever one of them changes.
  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const chapterRef = useRef<number | null>(null);
  const sessionRef = useRef<ReaderSession | null>(null);
  const annotationsRef = useRef<Annotation[]>([]);
  const prefsRef = useRef(prefs);
  pageRef.current = page;
  pagesRef.current = pages;
  chapterRef.current = chapter?.index ?? null;
  sessionRef.current = session;
  annotationsRef.current = annotations;
  prefsRef.current = prefs;

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api
      .readerOpen(book.id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
        let start = 0;
        let to: Landing = { kind: "page", page: 0 };
        if (s.locator) {
          try {
            const loc = JSON.parse(s.locator) as Locator;
            start = Math.min(Math.max(0, loc.spine), s.spine.length - 1);
            to = { kind: "ratio", ratio: loc.ratio };
          } catch {
            /* a corrupt locator just means starting from the beginning */
          }
        }
        landingRef.current = { spine: start, to };
        return api.readerChapter(book.id, start).then((c) => alive && setChapter(c));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [book.id]);

  const reloadAnnotations = useCallback(() => {
    api.listAnnotations(book.id).then(setAnnotations).catch(() => {});
  }, [book.id]);

  useEffect(reloadAnnotations, [reloadAnnotations]);

  const charsBefore = useMemo(() => {
    const out: number[] = [];
    let sum = 0;
    for (const s of session?.spine ?? []) {
      out.push(sum);
      sum += s.chars;
    }
    return out;
  }, [session]);

  const percentAt = useCallback(
    (spine: number, ratio: number) => {
      if (!session || session.total_chars === 0) return 0;
      const before = charsBefore[spine] ?? 0;
      const within = (session.spine[spine]?.chars ?? 0) * ratio;
      return Math.min(1, (before + within) / session.total_chars);
    },
    [session, charsBefore]
  );

  // ---- lay out into columns ----
  /**
   * Impose the layout, measure it, and put the reader where they should be.
   *
   * `final` says the document has stopped moving — fonts and images are in —
   * and is the only thing that clears a pending landing. Until then a landing
   * is re-applied on every pass, so an image that arrives late and changes the
   * page count can't strand a jump halfway down the chapter.
   *
   * Identity is deliberately stable: nothing in the dependency array. Everything
   * it reads comes from a ref.
   */
  const layout = useCallback((final = false) => {
    const frame = frameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.body) return;

    const box = frame.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return;

    const geom = geometryFor(box.width, box.height, prefsRef.current);
    geomRef.current = geom;
    applyLayoutStyle(doc, geom, prefsRef.current);
    // Measure with the content at rest, so every rect below is a document
    // position and the landing resolvers need no offset arithmetic.
    clearOffset(doc);

    // Highlights are redrawn from scratch each layout: marks split text nodes,
    // so leaving old ones in place would corrupt subsequent offsets.
    clearMarks(doc, "data-bv-hl");
    clearMarks(doc, "data-bv-seek");
    const spine = chapterRef.current;
    if (spine !== null) {
      for (const a of annotationsRef.current) {
        if (a.spine !== spine || a.kind !== "highlight") continue;
        const r = rangeForOffsets(doc, a.start_off, a.end_off);
        if (r) {
          markRange(doc, r, "data-bv-hl", String(a.id), HIGHLIGHT_COLORS[a.color] ?? HIGHLIGHT_COLORS.yellow);
        }
      }
    }
    if (flash.current) {
      const found = offsetsForOccurrence(doc, flash.current.text, flash.current.occurrence);
      const r = found && rangeForOffsets(doc, found.start, found.end);
      if (r) markRange(doc, r, "data-bv-seek", "1", SEEK_COLOR);
    }

    const total = countPages(doc.body.scrollWidth, geom.w);

    const land = landingRef.current;
    let target: number;
    if (land && land.spine === spine) {
      target = resolveLanding(doc, land.to, geom.w, total);
      if (final) landingRef.current = null;
    } else {
      // Nothing pending: hold the reader's place across the reflow. When the
      // page count is unchanged this is exact.
      target = pagesRef.current > 1 ? Math.round((pageRef.current / pagesRef.current) * total) : 0;
    }
    target = Math.min(Math.max(0, target), total - 1);

    // The refs lead the state: a second turn can arrive before React has
    // re-rendered, and it has to see the page it is turning from.
    pageRef.current = target;
    pagesRef.current = total;
    setPage(target);
    setPages(total);
    setCols(geom.cols);
    showPage(doc, target, geom.w);
    reveal(doc);
  }, []);

  // ---- wire the frame per chapter ----
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !chapter || !session) return;
    let live = true;

    const onLoad = () => {
      const doc = frame.contentDocument;
      if (!doc || !live) return;

      // Links move within the book rather than navigating the frame away — a
      // navigation would replace the document we hold the layout on.
      doc.addEventListener("click", (e) => {
        setMenu(null);
        const a = (e.target as HTMLElement)?.closest?.("a");
        if (!a) return;
        e.preventDefault();
        const raw = a.getAttribute("href") ?? "";
        const target = internalTarget(session, chapter, raw, (a as HTMLAnchorElement).href);
        // Anything pointing outside the archive is left alone: following it
        // would mean fetching from the network inside a frame showing
        // untrusted markup.
        if (target) {
          goToRef.current(
            target.spine,
            target.fragment ? { kind: "fragment", id: target.fragment } : { kind: "page", page: 0 }
          );
        }
      });

      // Our own menu, not WebView2's reload/inspect one.
      doc.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const rect = frame.getBoundingClientRect();
        const sel = offsetsForSelection(doc);
        setMenu({
          x: rect.left + (e as MouseEvent).clientX,
          y: rect.top + (e as MouseEvent).clientY,
          selection: sel?.text.trim() ?? "",
          range: sel ? { start: sel.start, end: sel.end } : null,
        });
      });

      // Wheel and keys have to be bound on the frame's own document: once it
      // has focus the parent window stops seeing those events. They go through
      // refs because this handler runs once per chapter, while `turn` changes
      // on every page.
      doc.addEventListener("wheel", (e) => wheelRef.current(e as WheelEvent), { passive: true });
      doc.addEventListener("keydown", (e) => keyRef.current(e as KeyboardEvent));

      // First pass positions the chapter; the second corrects it once the
      // things that change its measurements have arrived.
      layout();
      settle(doc).then(() => {
        // A load already in flight when the chapter changed still fires, and
        // its settle would otherwise mark the *next* chapter's landing as
        // final before that chapter had finished measuring.
        if (!live || frame.contentDocument !== doc) return;
        layout(true);
        // A frame that never got a usable size — a panel mid-animation, say —
        // must not be left sitting behind the veil.
        reveal(doc);
      });
    };

    frame.addEventListener("load", onLoad);
    frame.srcdoc = buildDocument(chapter, session.resource_base);
    return () => {
      live = false;
      frame.removeEventListener("load", onLoad);
    };
  }, [chapter, session, layout]);

  // Redraw marks when an annotation is added or removed.
  useEffect(() => {
    if (chapterRef.current !== null) layout();
  }, [annotations, layout]);

  // Changing type or spacing reflows the text; `layout` holds the place by
  // ratio on its own when there is nothing pending.
  useEffect(() => {
    savePrefs(prefs);
    layout();
  }, [prefs, layout]);

  // Only a real size change is worth a relayout. `observe` delivers one
  // callback on registration with the size the element already had, and this
  // effect is torn down and re-registered whenever the reader re-renders, so
  // without the comparison a page turn would trigger a full relayout.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let last = `${host.clientWidth}x${host.clientHeight}`;
    const ro = new ResizeObserver(() => {
      const now = `${host.clientWidth}x${host.clientHeight}`;
      if (now === last) return;
      last = now;
      layout();
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [layout]);

  // ---- navigation ----
  const goToChapter = useCallback(
    async (index: number, to: Landing = { kind: "page", page: 0 }) => {
      const s = sessionRef.current;
      if (!s || index < 0 || index >= s.spine.length) return;
      landingRef.current = { spine: index, to };
      setPanel(null);
      // A contents entry pointing into the chapter already open only needs the
      // landing applied. Refetching would reload the frame and lose the
      // rendered position for no gain. It waits a frame because closing the
      // panel widens the page, and resolving a fragment against the old width
      // would put the reader a page out.
      if (chapterRef.current === index) {
        requestAnimationFrame(() => layout(true));
        return;
      }
      try {
        setChapter(await api.readerChapter(book.id, index));
      } catch (e) {
        setError(String(e));
      }
    },
    [book.id, layout]
  );

  const turn = useCallback(
    (dir: 1 | -1) => {
      const frame = frameRef.current;
      const doc = frame?.contentDocument;
      const spine = chapterRef.current;
      if (!frame || !doc || spine === null) return;
      setMenu(null);
      flash.current = null;
      // A turn is the reader overriding whatever we were about to land on.
      landingRef.current = null;

      const next = pageRef.current + dir;
      if (next < 0) return void goToChapter(spine - 1, { kind: "end" });
      if (next >= pagesRef.current) return void goToChapter(spine + 1, { kind: "page", page: 0 });

      pageRef.current = next;
      setPage(next);
      showPage(doc, next, geomRef.current?.w ?? frame.getBoundingClientRect().width);
    },
    [goToChapter]
  );

  // Latest handlers, reachable from listeners bound once per chapter inside
  // the frame's document.
  const turnRef = useRef(turn);
  const goToRef = useRef(goToChapter);
  turnRef.current = turn;
  goToRef.current = goToChapter;

  /**
   * Fullscreen hides the chrome on the way in and brings it back on the way
   * out, as the other two readers do. This version kept the header up on the
   * argument that a book is read long enough to want the chapter and the
   * progress in view — but that is a preference, and I is now there to settle
   * it either way rather than the reader deciding for you.
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

  /**
   * One page per wheel gesture's worth of movement.
   *
   * A fixed cooldown per event, which is what this used to do, throws away most
   * of a trackpad's small deltas and makes scrolling feel like it is ignoring
   * you. Accumulating instead means a mouse notch still turns exactly one page
   * while a trackpad responds as soon as the reader has actually pushed a
   * page's worth.
   */
  const wheelAccum = useRef(0);
  const wheelAt = useRef(0);
  const lastTurn = useRef(0);
  const onWheel = useCallback(
    (e: WheelEvent) => {
      const dy = e.deltaY;
      if (Math.abs(dy) < 1) return;
      const now = Date.now();
      if (now - wheelAt.current > WHEEL_GESTURE_GAP) wheelAccum.current = 0;
      if (Math.sign(dy) !== Math.sign(wheelAccum.current)) wheelAccum.current = 0;
      wheelAt.current = now;
      wheelAccum.current += dy;
      if (Math.abs(wheelAccum.current) < WHEEL_THRESHOLD) return;
      if (now - lastTurn.current < WHEEL_COOLDOWN) return;
      lastTurn.current = now;
      wheelAccum.current = 0;
      turnRef.current(dy > 0 ? 1 : -1);
    },
    []
  );
  const wheelRef = useRef(onWheel);
  wheelRef.current = onWheel;

  // Wheel over the chrome (outside the frame) turns pages too.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    host.addEventListener("wheel", handler, { passive: true });
    return () => host.removeEventListener("wheel", handler);
  }, []);

  /**
   * The reader's keys, for both the window and the frame's own document — once
   * the frame has focus the window stops seeing anything typed into it, and two
   * copies of this would drift apart.
   */
  const onKey = useCallback(
    (e: KeyboardEvent) => {
      // Space is a page turn everywhere except in the search field, where it is
      // a space. Letters likewise: `c` typed into a query must not open the
      // contents. Escape still gets out of the field, rather than being
      // swallowed by it.
      const el = e.target as HTMLElement | null;
      if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA") {
        if (e.key === "Escape") {
          e.preventDefault();
          setPanel(null);
        }
        return;
      }
      // A shortcut is the bare key. Ctrl+C is a copy and Ctrl+F is whatever the
      // reader asked their system for — neither is ours to take.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Both the character and the physical key count. A layout that puts
      // something else on that key, or an input method part-way through a
      // composition — which reports the character as "Process" — would
      // otherwise make the letter shortcuts unreachable.
      const is = (letter: string, code: string) =>
        e.key === letter || e.key === letter.toUpperCase() || e.code === code;

      if (e.key === "Escape") {
        // One layer at a time — the menu, then fullscreen, then the window.
        // Closing the book outright from fullscreen is too big a jump for one
        // key.
        if (menu) setMenu(null);
        else if (fullscreen) setFull(false);
        else onClose?.();
        return;
      }
      if (is("f", "KeyF")) {
        e.preventDefault();
        setFull(!fullscreen);
        return;
      }
      if (is("i", "KeyI")) {
        e.preventDefault();
        setChrome((c) => !c);
        return;
      }
      if (is("c", "KeyC")) {
        e.preventDefault();
        setPanel((p) => (p === "toc" ? null : "toc"));
        return;
      }
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        turn(1);
        return;
      }
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        turn(-1);
      }
    },
    [turn, onClose, menu, fullscreen, setFull]
  );
  const keyRef = useRef(onKey);
  keyRef.current = onKey;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // ---- persist position ----
  const percent = chapter ? percentAt(chapter.index, pages > 1 ? page / pages : 0) : 0;

  useEffect(() => {
    if (!chapter || !session) return;
    const ratio = pages > 1 ? page / pages : 0;
    const locator: Locator = { spine: chapter.index, ratio };
    const t = setTimeout(() => {
      api
        .readerSavePosition(book.id, JSON.stringify(locator), percentAt(chapter.index, ratio))
        .then((b) => onProgress?.(b))
        .catch(() => {});
    }, 1200);
    return () => clearTimeout(t);
  }, [book.id, chapter, page, pages, session, percentAt, onProgress]);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    try {
      setHits(await api.readerSearch(book.id, q));
    } catch (e) {
      alert(String(e));
    } finally {
      setSearching(false);
    }
  }, [book.id, query]);

  /** Jump to a result, then locate the exact phrase once the page renders. */
  const gotoHit = useCallback(
    (hit: SearchHit) => {
      flash.current = { text: query.trim(), occurrence: hit.occurrence };
      goToChapter(hit.spine, { kind: "flash" });
    },
    [query, goToChapter]
  );

  const addAnnotation = useCallback(
    async (kind: "highlight" | "bookmark", color = "yellow") => {
      if (!chapter) return;
      const doc = frameRef.current?.contentDocument;
      let range = menu?.range ?? null;
      let text = menu?.selection ?? "";
      // A bookmark with nothing selected marks the top of the current page.
      if (!range && kind === "bookmark" && doc) {
        const chars = chapter.chars || 1;
        const at = Math.round((pages > 1 ? page / pages : 0) * chars);
        range = { start: at, end: at + 1 };
        text = `Page ${page + 1}`;
      }
      if (!range) return;
      try {
        await api.addAnnotation({
          bookId: book.id,
          spine: chapter.index,
          startOff: range.start,
          endOff: range.end,
          kind,
          color,
          text: text.slice(0, 500),
        });
        reloadAnnotations();
      } catch (e) {
        alert(String(e));
      }
      setMenu(null);
    },
    [book.id, chapter, menu, page, pages, reloadAnnotations]
  );

  const removeAnnotation = useCallback(
    async (id: number) => {
      try {
        await api.deleteAnnotation(id);
        reloadAnnotations();
      } catch (e) {
        alert(String(e));
      }
    },
    [reloadAnnotations]
  );

  // Which contents entry the reader is inside. Several entries can share a
  // spine index when a book hangs its chapters off fragments, so the last one
  // at or before the current position is the one to flag — otherwise every
  // entry in the document would light up at once.
  const currentTocIndex = useMemo(() => {
    if (!session || !chapter) return -1;
    let best = -1;
    session.toc.forEach((t, i) => {
      if (t.spine_index !== null && t.spine_index <= chapter.index) best = i;
    });
    return best;
  }, [session, chapter]);

  const chapterLabel = useMemo(
    () => (chapter ? labelForSpine(session, chapter.index) : ""),
    [session, chapter]
  );

  return (
    <div
      className="relative flex h-full flex-col text-slate-200"
      style={{ background: THEMES[prefs.theme].chrome }}
      onClick={() => {
        setMenu(null);
        setPrefsOpen(false);
      }}
    >
      {/* Chrome */}
      {chrome && (
      <header
        data-tauri-drag-region
        className="flex shrink-0 items-center gap-2 px-3 py-2"
        style={{ paddingLeft: 12 + (fullscreen ? 0 : TRAFFIC_LIGHT_INSET) }}
      >
        {/* macOS already provides a close button in the traffic lights. */}
        {onClose && !IS_MAC && !fullscreen && (
          <button
            onClick={onClose}
            title="Close (Esc)"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        )}
        <button
          onClick={() => setPanel((p) => (p === "toc" ? null : "toc"))}
          title="Contents (C)"
          className={cx(
            "rounded-md p-2 transition-colors",
            panel === "toc" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="list" className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
          <div className="truncate text-[11px] text-white/35">{chapterLabel}</div>
        </div>
        <button
          onClick={() => setPanel((p) => (p === "search" ? null : "search"))}
          title="Search in book"
          className={cx(
            "rounded-md p-2 transition-colors",
            panel === "search" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="search" className="h-4 w-4" />
        </button>
        <button
          onClick={() => setPanel((p) => (p === "notes" ? null : "notes"))}
          title="Highlights & bookmarks"
          className={cx(
            "relative rounded-md p-2 transition-colors",
            panel === "notes" ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="bookmark" className="h-4 w-4" />
          {annotations.length > 0 && (
            <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-400" />
          )}
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setPrefsOpen((v) => !v);
          }}
          title="Type and appearance"
          className={cx(
            "rounded-md p-2 transition-colors",
            prefsOpen ? "bg-white/15 text-white" : "text-white/50 hover:bg-white/10 hover:text-white"
          )}
        >
          <Icon name="type" className="h-4 w-4" />
        </button>
        <button
          onClick={() => setFull(!fullscreen)}
          title={
            fullscreen
              ? "Leave fullscreen (F or Esc) — press I to bring these controls back"
              : "Fullscreen (F)"
          }
          className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
        >
          <Icon name={fullscreen ? "collapse" : "expand"} className="h-4 w-4" />
        </button>
        {onOpenExternally && !fullscreen && (
          <button
            onClick={onOpenExternally}
            title="Open in your system EPUB reader"
            className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
          >
            <Icon name="open" className="h-4 w-4" />
          </button>
        )}
        <div className="w-12 shrink-0 text-right text-[11px] tabular-nums text-white/40">
          {Math.round(percent * 100)}%
        </div>
        <Clock className="ml-1 border-l border-white/10 pl-3" />
      </header>
      )}

      <div className="relative flex min-h-0 flex-1">
        {panel === "toc" && (
          <nav className="w-72 shrink-0 overflow-y-auto border-r border-white/10 py-2">
            {session?.toc.length ? (
              session.toc.map((t, i) => (
                <button
                  key={i}
                  disabled={t.spine_index === null}
                  onClick={() =>
                    t.spine_index !== null &&
                    goToChapter(
                      t.spine_index,
                      // Anthologies and single-file books hang their whole
                      // contents off fragments of one document, so an entry
                      // that names one has to be followed to it.
                      t.fragment ? { kind: "fragment", id: t.fragment } : { kind: "page", page: 0 }
                    )
                  }
                  style={{ paddingLeft: 14 + t.depth * 14 }}
                  className={cx(
                    "block w-full truncate py-1.5 pr-3 text-left text-[13px] transition-colors",
                    i === currentTocIndex
                      ? "bg-white/15 text-white"
                      : "text-white/45 hover:bg-white/5 hover:text-white/80",
                    t.spine_index === null && "opacity-40"
                  )}
                  title={t.label}
                >
                  {t.label}
                </button>
              ))
            ) : (
              <p className="px-4 py-2 text-xs text-white/35">No contents in this book.</p>
            )}
          </nav>
        )}

        {panel === "search" && (
          <aside className="flex w-80 shrink-0 flex-col border-r border-white/10">
            <div className="p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && runSearch()}
                placeholder="Search this book…"
                className="w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-accent-500/50"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {searching ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-white/40">
                  <Spinner className="h-3.5 w-3.5" /> Searching…
                </div>
              ) : hits === null ? (
                <p className="px-3 py-2 text-[11px] leading-relaxed text-white/30">
                  Searches the whole book. Press Enter to run.
                </p>
              ) : hits.length === 0 ? (
                <p className="px-3 py-2 text-[11px] text-white/30">No matches.</p>
              ) : (
                <>
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-white/25">
                    {hits.length} match{hits.length === 1 ? "" : "es"}
                  </div>
                  {hits.map((h, i) => (
                    <button
                      key={i}
                      onClick={() => gotoHit(h)}
                      className="block w-full border-b border-white/5 px-3 py-2 text-left transition-colors hover:bg-white/5"
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/25">
                        {labelForSpine(session, h.spine)}
                      </div>
                      <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-white/60">
                        {h.snippet}
                      </div>
                    </button>
                  ))}
                </>
              )}
            </div>
          </aside>
        )}

        {panel === "notes" && (
          <aside className="w-80 shrink-0 overflow-y-auto border-r border-white/10">
            {annotations.length === 0 ? (
              <p className="px-3 py-3 text-[11px] leading-relaxed text-white/30">
                Select text and right-click to highlight it. Bookmarks work the same way,
                or mark the current page from the menu with nothing selected.
              </p>
            ) : (
              annotations.map((a) => (
                <div key={a.id} className="group border-b border-white/5 px-3 py-2">
                  <div className="flex items-start gap-2">
                    <span
                      className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        background:
                          a.kind === "bookmark"
                            ? "rgba(255,255,255,.35)"
                            : HIGHLIGHT_COLORS[a.color] ?? HIGHLIGHT_COLORS.yellow,
                      }}
                    />
                    <button
                      onClick={() => {
                        flash.current = null;
                        goToChapter(a.spine, {
                          kind: "offsets",
                          start: a.start_off,
                          end: a.end_off,
                        });
                      }}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/25">
                        {labelForSpine(session, a.spine)}
                      </div>
                      <div className="mt-0.5 line-clamp-3 text-[12px] leading-snug text-white/60">
                        {a.text || "(no text)"}
                      </div>
                    </button>
                    <button
                      onClick={() => removeAnnotation(a.id)}
                      title="Delete"
                      className="rounded p-1 text-white/20 opacity-0 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    >
                      <Icon name="trash" className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </aside>
        )}

        {/* The paper. With the chrome hidden it fills the window instead of
            sitting inset on the dark surround — the inset is what makes it read
            as a page on a desk, and with nothing else on screen it just reads
            as a border. */}
        <div className={cx("relative min-w-0 flex-1", chrome && "px-6 pb-3")}>
          <div
            ref={hostRef}
            className={cx(
              "relative h-full w-full overflow-hidden",
              chrome && "rounded-md shadow-[0_10px_40px_rgba(0,0,0,.45)]"
            )}
            style={{ background: THEMES[prefs.theme].bg }}
          >
            {error ? (
              <div className="grid h-full place-items-center p-8">
                <div className="max-w-md text-center">
                  <Icon name="warning" className="mx-auto h-8 w-8 text-amber-600" />
                  <p className="mt-3 text-sm text-slate-700">{error}</p>
                </div>
              </div>
            ) : !chapter ? (
              <div className="grid h-full place-items-center text-slate-400">
                <Spinner className="h-6 w-6" />
              </div>
            ) : (
              <>
                <iframe
                  ref={frameRef}
                  title={book.title}
                  // `allow-scripts` does NOT mean the book may execute: scripts
                  // are blocked three ways over. See the security note above —
                  // without the flag, WebKit delivers no events in here at all.
                  sandbox="allow-same-origin allow-scripts"
                  className="h-full w-full border-0"
                />
                {/* Spine between the two pages of a spread. */}
                {cols === 2 && (
                  <div className="pointer-events-none absolute inset-y-8 left-1/2 w-px -translate-x-1/2 bg-black/[0.07]" />
                )}
              </>
            )}

            <button
              onClick={() => turn(-1)}
              aria-label="Previous page"
              className="absolute inset-y-0 left-0 w-[12%] cursor-w-resize opacity-0"
            />
            <button
              onClick={() => turn(1)}
              aria-label="Next page"
              className="absolute inset-y-0 right-0 w-[12%] cursor-e-resize opacity-0"
            />
          </div>
        </div>
      </div>

      {/* Footer */}
      {chrome && (
      <footer className="flex shrink-0 items-center gap-3 px-6 pb-2 pt-1">
        <div className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-white/40 transition-all"
            style={{ width: `${percent * 100}%` }}
          />
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-white/35">
          {page + 1} of {pages}
        </span>
      </footer>
      )}

      {prefsOpen && (
        <PrefsPanel prefs={prefs} onChange={setPrefs} onClose={() => setPrefsOpen(false)} />
      )}

      {menu && (
        <ContextMenu
          menu={menu}
          hasToc={!!session?.toc.length}
          onCopy={() => navigator.clipboard.writeText(menu.selection).catch(() => {})}
          onContents={() => setPanel("toc")}
          onTurn={turn}
          onExternal={onOpenExternally}
          onHighlight={(c) => addAnnotation("highlight", c)}
          onBookmark={() => addAnnotation("bookmark")}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/**
 * Turn a landing instruction into a page number in the laid-out document.
 *
 * Everything is resolved against the layout as it stands right now, which is
 * why this runs after the marks are drawn rather than before: a search result
 * is found by looking for the mark that was just made for it.
 */
function resolveLanding(doc: Document, to: Landing, w: number, total: number): number {
  switch (to.kind) {
    case "page":
      return to.page;
    case "ratio":
      return Math.round(to.ratio * total);
    case "end":
      return total - 1;
    case "fragment": {
      const el = elementForFragment(doc, to.id);
      // A fragment that names nothing in the document is not worth guessing at;
      // the chapter start is at least somewhere the reader asked to be.
      return el ? pageForElement(doc, el, w) : 0;
    }
    case "offsets": {
      const r = rangeForOffsets(doc, to.start, to.end);
      return r ? pageForRange(r, w) : 0;
    }
    case "flash": {
      const el = doc.querySelector("[data-bv-seek]");
      return el ? pageForElement(doc, el, w) : 0;
    }
  }
}

/** Nearest table-of-contents label at or before a spine index. */
function labelForSpine(session: ReaderSession | null, spine: number): string {
  if (!session) return `Section ${spine + 1}`;
  const hit = [...session.toc]
    .filter((t) => t.spine_index !== null && t.spine_index <= spine)
    .pop();
  return hit?.label ?? `Section ${spine + 1}`;
}

/** Type and appearance, in the spirit of Books' "Aa" popover. */
function PrefsPanel({
  prefs,
  onChange,
  onClose,
}: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) =>
    onChange({ ...prefs, [k]: v });

  const themes: { id: Theme; label: string }[] = [
    { id: "paper", label: "Paper" },
    { id: "white", label: "White" },
    { id: "sepia", label: "Sepia" },
    { id: "night", label: "Night" },
  ];

  return (
    <div
      className="absolute right-3 top-12 z-40 w-72 rounded-xl border border-white/10 bg-slate-900/95 p-3 shadow-2xl backdrop-blur"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Type &amp; appearance
        </span>
        <button
          onClick={onClose}
          className="rounded p-1 text-slate-500 hover:bg-white/10 hover:text-white"
        >
          <Icon name="x" className="h-3 w-3" />
        </button>
      </div>

      {/* Theme */}
      <div className="mb-3 grid grid-cols-4 gap-1.5">
        {themes.map((t) => (
          <button
            key={t.id}
            onClick={() => set("theme", t.id)}
            className={cx(
              "rounded-lg border py-2 text-[11px] font-medium transition-colors",
              prefs.theme === t.id ? "border-accent-500/70" : "border-white/10 hover:border-white/25"
            )}
            style={{ background: THEMES[t.id].bg, color: THEMES[t.id].fg }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Typeface — "Publisher's font" is the Original equivalent. */}
      <label className="mb-1 block text-[11px] text-slate-500">Typeface</label>
      <select
        value={prefs.font}
        onChange={(e) => set("font", e.target.value as FontChoice)}
        className="mb-1 w-full rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 text-sm outline-none focus:border-accent-500/50"
      >
        {(Object.keys(FONT_LABELS) as FontChoice[]).map((f) => (
          <option key={f} value={f}>
            {FONT_LABELS[f]}
          </option>
        ))}
      </select>
      <p className="mb-3 text-[10px] leading-snug text-slate-500">
        {prefs.font === "publisher"
          ? "Using the book's own typeface and embedded fonts."
          : "Overriding the publisher's typeface."}
      </p>

      <Stepper
        label="Text size"
        value={`${prefs.size}px`}
        onDown={() => set("size", Math.max(13, prefs.size - 1))}
        onUp={() => set("size", Math.min(32, prefs.size + 1))}
      />
      <Stepper
        label="Line spacing"
        value={prefs.lineHeight.toFixed(2)}
        onDown={() => set("lineHeight", Math.max(1.2, +(prefs.lineHeight - 0.1).toFixed(2)))}
        onUp={() => set("lineHeight", Math.min(2.4, +(prefs.lineHeight + 0.1).toFixed(2)))}
      />
      <Stepper
        label="Margins"
        value={`${prefs.margin}px`}
        onDown={() => set("margin", Math.max(16, prefs.margin - 8))}
        onUp={() => set("margin", Math.min(140, prefs.margin + 8))}
      />

      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-slate-300">
        <input
          type="checkbox"
          checked={prefs.justify}
          onChange={(e) => set("justify", e.target.checked)}
          className="accent-accent-500"
        />
        Justify text
      </label>

      <button
        onClick={() => onChange(DEFAULT_PREFS)}
        className="mt-3 w-full rounded-lg border border-white/10 py-1.5 text-[11px] text-slate-400 hover:bg-white/5 hover:text-white"
      >
        Reset to defaults
      </button>
    </div>
  );
}

function Stepper({
  label,
  value,
  onDown,
  onUp,
}: {
  label: string;
  value: string;
  onDown: () => void;
  onUp: () => void;
}) {
  return (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="flex-1 text-[12px] text-slate-400">{label}</span>
      <span className="w-12 text-right text-[11px] tabular-nums text-slate-500">{value}</span>
      <button
        onClick={onDown}
        className="rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/10"
      >
        −
      </button>
      <button
        onClick={onUp}
        className="rounded-md border border-white/10 px-2 py-1 text-slate-300 hover:bg-white/10"
      >
        +
      </button>
    </div>
  );
}

/** Replaces the WebView2 reload/inspect menu with reader actions. */
function ContextMenu({
  menu,
  hasToc,
  onCopy,
  onContents,
  onTurn,
  onExternal,
  onHighlight,
  onBookmark,
  onDismiss,
}: {
  menu: NonNullable<Menu>;
  hasToc: boolean;
  onCopy: () => void;
  onContents: () => void;
  onTurn: (d: 1 | -1) => void;
  onExternal?: () => void;
  onHighlight: (color: string) => void;
  onBookmark: () => void;
  onDismiss: () => void;
}) {
  const items: { label: string; icon: string; run: () => void; show: boolean }[] = [
    { label: "Copy", icon: "check", run: onCopy, show: !!menu.selection },
    {
      label: menu.selection ? "Bookmark this passage" : "Bookmark this page",
      icon: "bookmark",
      run: onBookmark,
      show: true,
    },
    { label: "Next page", icon: "chevron", run: () => onTurn(1), show: true },
    { label: "Previous page", icon: "chevron", run: () => onTurn(-1), show: true },
    { label: "Contents", icon: "list", run: onContents, show: hasToc },
    {
      label: "Open in system reader",
      icon: "open",
      run: () => onExternal?.(),
      show: !!onExternal,
    },
  ].filter((i) => i.show);

  return (
    <div
      className="fixed z-50 min-w-52 overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 py-1 shadow-2xl backdrop-blur"
      style={{ left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 200) }}
      onClick={(e) => e.stopPropagation()}
    >
      {menu.selection && (
        <div className="truncate border-b border-white/10 px-3 py-1.5 text-[11px] italic text-slate-500">
          “{menu.selection.slice(0, 40)}
          {menu.selection.length > 40 ? "…" : ""}”
        </div>
      )}
      {menu.range && (
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
          <span className="mr-auto text-[11px] text-slate-500">Highlight</span>
          {Object.entries(HIGHLIGHT_COLORS).map(([name, css]) => (
            <button
              key={name}
              title={name}
              onClick={() => {
                onHighlight(name);
                onDismiss();
              }}
              className="h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110"
              style={{ background: css }}
            />
          ))}
        </div>
      )}
      {items.map((i) => (
        <button
          key={i.label}
          onClick={() => {
            i.run();
            onDismiss();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon
            name={i.icon}
            className={cx("h-3.5 w-3.5 opacity-60", i.label === "Previous page" && "rotate-180")}
          />
          {i.label}
        </button>
      ))}
    </div>
  );
}

