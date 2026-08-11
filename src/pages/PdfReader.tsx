import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Annotation, api, Book, ComicLocator, PdfHit, PdfSession, TextRun } from "../api";
import {
  buildSpreads,
  PAGE_GAP,
  pageAtOffset,
  pageUrl,
  renderWidth,
  runPrefixes,
  runSlices,
  snapToDevice,
  stackLayout,
  textBetween,
  textLength,
  visibleRange,
} from "../pdf-layout";
import { HIGHLIGHT_COLORS } from "../reader-dom";
import { cx, Icon, Spinner } from "../ui";
import { IS_MAC, TRAFFIC_LIGHT_INSET } from "../platform";

/**
 * PDF reader.
 *
 * A PDF is neither of the other two things this app reads. An EPUB is markup
 * the browser lays out; a comic is a bag of images with no structure. A PDF is
 * fixed-layout pages that have to be rasterised one at a time — closer to the
 * comic reader — but it is read like a book: hundreds of pages, scrolled
 * through, returned to.
 *
 * That difference shows up in two places.
 *
 * Every page's size is known before anything is rendered, straight from the
 * page tree. So the document's full height is known up front, the scrollbar
 * means something the moment it appears, and nothing shifts as pages arrive.
 * The comic reader can't do this — it has to learn a page's shape by loading
 * it — and that asymmetry is why its spread grouping settles as you read while
 * this one is right immediately.
 *
 * And it scrolls as well as pages. Scrolling is what a long reference document
 * wants and paging is what the rest of the app does, so both are here. Scrolled
 * mode only ever renders the pages you can see plus a screen either side; a
 * five-hundred-page book would otherwise be five hundred bitmaps.
 */

type Mode = "scroll" | "paged";
/** What zoom 1 means. Zoom multiplies whichever of these is chosen. */
type Fit = "width" | "height";

const MODE_KEY = "bv.pdfMode";
const FIT_KEY = "bv.pdfFit";
const ZOOM_KEY = "bv.pdfZoom";

type Panel = "contents" | "search" | null;

/** Colour key for the mark on a search result — not one of the palette. */
const SEEK = "seek";

/**
 * What a mark is painted in. The highlight palette, plus a colour for a search
 * hit that is deliberately none of them: a result you jumped to should not look
 * like something you highlighted earlier.
 */
const MARK_COLORS: Record<string, string> = {
  ...HIGHLIGHT_COLORS,
  [SEEK]: "rgba(249, 115, 22, .5)",
};

/** How many screens either side of the viewport to keep rendered. */
const OVERSCAN = 1;
/** A wheel gesture shouldn't fire a second turn until it settles. */
const WHEEL_COOLDOWN = 260;
/** Pages to warm either side of a spread, when paging. */
const AHEAD = 2;

const ZOOMS = [0.5, 0.67, 0.8, 1, 1.25, 1.5, 2, 3];

function loadMode(): Mode {
  return localStorage.getItem(MODE_KEY) === "paged" ? "paged" : "scroll";
}
function loadFit(): Fit {
  return localStorage.getItem(FIT_KEY) === "height" ? "height" : "width";
}
function loadZoom(): number {
  const saved = Number(localStorage.getItem(ZOOM_KEY));
  return ZOOMS.includes(saved) ? saved : 1;
}

export default function PdfReader({
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
  const [session, setSession] = useState<PdfSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [mode, setMode] = useState<Mode>(loadMode);
  const [fit, setFit] = useState<Fit>(loadFit);
  const [zoom, setZoom] = useState<number>(loadZoom);
  const [twoUp, setTwoUp] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [loaded, setLoaded] = useState<Set<string>>(() => new Set());
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  /** Which side panel is open, if any. They share the column. */
  const [panel, setPanel] = useState<Panel>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PdfHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  /**
   * The hit to keep marked, so a result you jumped to is visible on the page
   * rather than leaving you to find it yourself.
   */
  const [flash, setFlash] = useState<PdfHit | null>(null);
  /**
   * Selectable text, by page. Fetched as pages come into view rather than with
   * the session: a page costs a few milliseconds to extract, which is nothing
   * on its own and half a minute across a book nobody has scrolled through.
   */
  const [runs, setRuns] = useState<Map<number, TextRun[]>>(() => new Map());
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [menu, setMenu] = useState<PdfMenu>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * The element holding each visible page's runs, so a selection can be asked
   * which characters of which page it covers. Registered by the text layers
   * themselves and dropped as pages scroll out.
   */
  const runHosts = useRef(new Map<number, HTMLElement>());
  const registerRuns = useCallback((p: number, el: HTMLElement | null) => {
    if (el) runHosts.current.set(p, el);
    else runHosts.current.delete(p);
  }, []);
  const lastWheel = useRef(0);
  /**
   * Set while the reader is moving the scroll position itself, so the scroll
   * handler doesn't take its own jump as the reader having navigated and
   * overwrite the page it was jumping to.
   */
  const seeking = useRef(false);

  const sizes = session?.pages ?? [];
  const count = sizes.length;
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  // ---- load ----
  useEffect(() => {
    let alive = true;
    api
      .pdfOpen(book.id)
      .then((s) => {
        if (!alive) return;
        setSession(s);
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

  useEffect(() => localStorage.setItem(MODE_KEY, mode), [mode]);
  useEffect(() => localStorage.setItem(FIT_KEY, fit), [fit]);
  useEffect(() => localStorage.setItem(ZOOM_KEY, String(zoom)), [zoom]);

  // ---- measure the viewport ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      // `clientWidth` rounds to whole css pixels, and at a fractional display
      // scale the content width isn't whole — 2560 device pixels at 150% is
      // 1706.67css. Rounding that throws away the third of a pixel and puts
      // every page slightly off the device grid, which is exactly the
      // resampling the rest of the sizing works to avoid. It shows up
      // fullscreen because that is when the viewport is the whole screen and
      // no longer happens to divide evenly.
      //
      // `getBoundingClientRect` keeps the fraction but includes the scrollbar,
      // which has to come off by hand.
      const rect = el.getBoundingClientRect();
      const scrollbar = el.offsetWidth - el.clientWidth;
      setBox({ w: Math.max(0, rect.width - scrollbar), h: rect.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session, mode]);

  const markLoaded = useCallback((key: string) => {
    setLoaded((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }, []);

  // ---- how wide a page is drawn ----
  const spreads = useMemo(() => buildSpreads(sizes, twoUp), [sizes, twoUp]);
  const at = useMemo(() => {
    const map = new Map<number, number>();
    spreads.forEach((s, i) => s.forEach((p) => map.set(p, i)));
    return map;
  }, [spreads]);
  const index = at.get(page) ?? 0;
  const shown = useMemo(() => spreads[index] ?? [page], [spreads, index, page]);
  const pair = shown.length > 1;

  /**
   * How wide the page wants to be, before it is made to line up with the
   * pixel grid.
   *
   * Scrolling always fits the width and lets zoom take it from there — fitting
   * the height while scrolling vertically would put exactly one page on screen,
   * which is paging with extra steps.
   */
  const wantWidth = useMemo(() => {
    if (box.w < 2) return 0;
    if (mode === "scroll") return Math.max(80, (box.w - 32) * zoom);
    const avail = pair ? (box.w - PAGE_GAP) / 2 : box.w;
    if (fit === "width") return Math.max(80, avail * zoom);
    // Fitting the height needs the page's own proportions to get back to a
    // width. The first page on screen speaks for the spread.
    const size = sizes[shown[0]] ?? { w: 1, h: 1.4142 };
    const ratio = size.w > 0 && size.h > 0 ? size.w / size.h : 0.707;
    return Math.max(80, box.h * zoom * ratio);
  }, [mode, box, zoom, fit, pair, sizes, shown]);

  /**
   * The bitmap width in device pixels, and the css width that maps onto it
   * exactly.
   *
   * The css width is derived *from* the render width rather than alongside it.
   * Computing the two independently is how the first version stayed soft: a
   * page asked for at 1237.6css was rendered 1238 device pixels wide and then
   * drawn into a box of a slightly different size, and a bitmap that doesn't
   * land on the pixel grid is resampled rather than blitted. Deriving one from
   * the other makes disagreeing impossible.
   */
  const width = useMemo(() => renderWidth(wantWidth, dpr), [wantWidth, dpr]);
  const pageWidth = wantWidth > 0 ? width / Math.max(1, dpr) : 0;

  // The scrolled stack fills the viewport at minimum, so a page narrower than
  // the window is centred by its own offset and a wider one simply scrolls.
  const stackWidth = Math.max(box.w, pageWidth);
  const pageLeft = Math.max(0, snapToDevice((stackWidth - pageWidth) / 2, dpr));
  const layout = useMemo(
    () => stackLayout(sizes, pageWidth, PAGE_GAP, dpr),
    [sizes, pageWidth, dpr]
  );

  // ---- scrolling ----
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    if (seeking.current) return;
    setPage(pageAtOffset(layout.tops, el.scrollTop + 8));
  }, [layout.tops]);

  /** Put a page at the top of the viewport without it counting as navigation. */
  const scrollToPage = useCallback(
    (n: number) => {
      const el = scrollRef.current;
      if (!el || mode !== "scroll") return;
      const top = layout.tops[n];
      if (top === undefined) return;
      seeking.current = true;
      el.scrollTo({ top });
      setScrollTop(top);
      // Released after the scroll event this triggers has been and gone.
      requestAnimationFrame(() => {
        seeking.current = false;
      });
    },
    [layout.tops, mode]
  );

  const goTo = useCallback(
    (n: number) => {
      const clamped = Math.min(Math.max(0, n), Math.max(0, count - 1));
      setPage(clamped);
      scrollToPage(clamped);
    },
    [count, scrollToPage]
  );

  const turn = useCallback(
    (dir: 1 | -1) => {
      if (mode === "paged") {
        const next = spreads[index + dir];
        if (next) setPage(next[0]);
        return;
      }
      const el = scrollRef.current;
      if (!el) return;
      // Scrolled, a "turn" is a screenful, which is what Space and PageDown
      // mean in every other document you read this way.
      el.scrollBy({ top: dir * Math.max(80, el.clientHeight * 0.92) });
    },
    [mode, spreads, index]
  );

  // Restore the saved page once the layout it has to be measured against
  // exists. Until pageWidth is known every page starts at zero.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !session || mode !== "scroll" || pageWidth < 2) return;
    restored.current = true;
    scrollToPage(page);
  }, [session, mode, pageWidth, page, scrollToPage]);

  // Changing mode should leave you where you were reading, not at the top.
  useEffect(() => {
    if (mode === "scroll" && restored.current) scrollToPage(page);
    // Only when the mode itself changes: following `page` here would fight the
    // scroll handler on every wheel notch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  /**
   * Anything that changes how wide a page is drawn — zooming, opening the
   * contents, resizing the window — moves every page's offset with it. Without
   * re-anchoring, the scroll position keeps its pixel value and means a
   * different page: zoom in near the end of a long book and you land back in
   * the middle of it.
   */
  const pageRef = useRef(page);
  pageRef.current = page;
  const lastWidth = useRef(0);
  useEffect(() => {
    if (mode !== "scroll" || pageWidth < 2) return;
    const had = lastWidth.current;
    if (had === pageWidth) return;
    lastWidth.current = pageWidth;
    // The first measurement is the initial layout, which the restore above
    // owns; stepping on it here would send a reopened book back to page one.
    if (had !== 0) scrollToPage(pageRef.current);
  }, [pageWidth, mode, scrollToPage]);

  // ---- what to render ----
  const [first, last] = useMemo(
    () =>
      mode === "scroll"
        ? visibleRange(layout.tops, scrollTop, box.h, OVERSCAN)
        : [0, -1],
    [mode, layout, scrollTop, box.h]
  );

  // Warm the pages either side of a spread when paging. Scrolled mode needs
  // none of this: its overscan already renders a screen beyond the edges.
  useEffect(() => {
    if (!session || mode !== "paged" || width < 1) return;
    const wanted = [shown[0] - 1];
    for (let i = 1; i <= AHEAD * (twoUp ? 2 : 1); i++) {
      wanted.push((shown[shown.length - 1] ?? 0) + i);
    }
    for (const i of wanted) {
      if (i < 0 || i >= count) continue;
      const img = new Image();
      img.onload = () => markLoaded(`${i}@${width}`);
      img.src = pageUrl(session, i, width);
    }
  }, [session, mode, shown, twoUp, count, width, markLoaded]);

  const ready = shown.every((i) => loaded.has(`${i}@${width}`));

  /** Pages currently on screen, whichever way the reader is moving. */
  const onScreen = useMemo(() => {
    if (mode !== "scroll") return shown;
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  }, [mode, shown, first, last]);

  // Fetch the text for what's on screen. A page that fails is recorded as
  // empty rather than left absent, or it would be asked for again on every
  // render for as long as it stayed in view.
  useEffect(() => {
    let alive = true;
    for (const i of onScreen) {
      if (i < 0 || i >= count || runs.has(i)) continue;
      api
        .pdfText(book.id, i)
        .then((r) => {
          if (alive) setRuns((prev) => (prev.has(i) ? prev : new Map(prev).set(i, r)));
        })
        .catch(() => {
          if (alive) setRuns((prev) => (prev.has(i) ? prev : new Map(prev).set(i, [])));
        });
    }
    return () => {
      alive = false;
    };
  }, [onScreen, count, runs, book.id]);

  /** Points to CSS pixels for one page — the text layer's whole job. */
  const scaleFor = useCallback(
    (i: number) => {
      const w = sizes[i]?.w ?? 0;
      return w > 0 ? pageWidth / w : 0;
    },
    [sizes, pageWidth]
  );

  // ---- highlights ----
  const reloadAnnotations = useCallback(() => {
    api.listAnnotations(book.id).then(setAnnotations).catch(() => {});
  }, [book.id]);
  useEffect(reloadAnnotations, [reloadAnnotations]);

  /**
   * Highlights grouped by the page they sit on. Stored as character ranges in
   * the page's text, the same way the book reader stores them — the page takes
   * the place of the spine index — so they survive zoom, a resize, and being
   * reopened on another machine.
   */
  const highlightsByPage = useMemo(() => {
    const map = new Map<number, PageHighlight[]>();
    for (const a of annotations) {
      if (a.kind !== "highlight") continue;
      const list = map.get(a.spine) ?? [];
      list.push({ id: a.id, start: a.start_off, end: a.end_off, color: a.color });
      map.set(a.spine, list);
    }
    return map;
  }, [annotations]);

  const noHighlights = useMemo(() => [] as PageHighlight[], []);

  /**
   * What the selection covers, page by page, read now rather than later.
   *
   * This has to happen while the menu is opening. Pressing the mouse down on
   * the menu collapses the document selection, so by the time a colour has
   * been clicked there is nothing left to ask — the highlight silently did
   * nothing. The book reader's menu already carried its offsets for exactly
   * this reason; this one learned it the hard way.
   *
   * One entry per page: a selection dragged across a page break is one
   * gesture but two pages of text, and an offset only means anything against
   * the page it came from.
   */
  const captureSelection = useCallback((): SelectedSpan[] => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return [];
    const range = selection.getRangeAt(0);
    const out: SelectedSpan[] = [];
    for (const [p, host] of runHosts.current) {
      const pageRuns = runs.get(p);
      if (!pageRuns?.length) continue;
      const span = selectionOnPage(host, pageRuns, range);
      if (!span) continue;
      out.push({
        page: p,
        ...span,
        text: textBetween(pageRuns, runPrefixes(pageRuns), span.start, span.end),
      });
    }
    return out.sort((a, b) => a.page - b.page);
  }, [runs]);

  const highlight = useCallback(
    async (spans: SelectedSpan[], color: string) => {
      if (spans.length === 0) return;
      try {
        for (const s of spans) {
          await api.addAnnotation({
            bookId: book.id,
            spine: s.page,
            startOff: s.start,
            endOff: s.end,
            kind: "highlight",
            color,
            text: s.text.slice(0, 500),
          });
        }
        window.getSelection()?.removeAllRanges();
        reloadAnnotations();
      } catch (e) {
        alert(String(e));
      }
    },
    [book.id, reloadAnnotations]
  );

  const removeHighlight = useCallback(
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

  /**
   * Our own menu rather than WebView2's reload-and-inspect one, offering the
   * colours when there is a selection and removal when the click landed on a
   * highlight already there.
   */
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const spans = captureSelection();
      const hasSelection = spans.length > 0;

      let hit: number | null = null;
      const wrapper = (e.target as HTMLElement).closest?.("[data-page]") as HTMLElement | null;
      const clicked = wrapper ? Number(wrapper.dataset.page) : NaN;
      const pageRuns = Number.isFinite(clicked) ? runs.get(clicked) : undefined;
      const host = Number.isFinite(clicked) ? runHosts.current.get(clicked) : undefined;
      if (!hasSelection && host && pageRuns?.length) {
        const offset = offsetAtPoint(host, pageRuns, e.clientX, e.clientY);
        if (offset !== null) {
          // Whichever highlight covers the character under the cursor. Asking
          // the text rather than the rectangles means this keeps working
          // however the page is scaled.
          const found = (highlightsByPage.get(clicked) ?? []).find(
            (h) => offset >= h.start && offset < h.end
          );
          hit = found?.id ?? null;
        }
      }
      if (!hasSelection && hit === null) return;
      setMenu({ x: e.clientX, y: e.clientY, spans, hit });
    },
    [runs, highlightsByPage, captureSelection]
  );

  // ---- find in document ----
  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (q.length < 2) return;
    setSearching(true);
    setFlash(null);
    try {
      setHits(await api.pdfSearch(book.id, q));
    } catch (e) {
      alert(String(e));
    } finally {
      setSearching(false);
    }
  }, [book.id, query]);

  // A mark belongs to the result list that produced it. Closing the panel
  // leaves an orange smear on the page with nothing to explain it.
  useEffect(() => {
    if (panel !== "search") setFlash(null);
  }, [panel]);

  /** Jump to a hit and mark it, since a page of prose hides a phrase well. */
  const gotoHit = useCallback(
    (hit: PdfHit) => {
      setFlash(hit);
      goTo(hit.page);
    },
    [goTo]
  );

  /**
   * What each page draws: its stored highlights, plus the search mark when the
   * flashed hit is on it. The mark rides the same machinery as a highlight
   * because it is the same thing — a character range turned into rectangles.
   */
  const marksFor = useCallback(
    (p: number): PageHighlight[] => {
      const stored = highlightsByPage.get(p);
      if (!flash || flash.page !== p) return stored ?? noHighlights;
      const mark: PageHighlight = { id: -1, start: flash.start, end: flash.end, color: SEEK };
      return stored ? [...stored, mark] : [mark];
    },
    [highlightsByPage, flash, noHighlights]
  );

  /** Which outline entry the reader is inside: the last one at or before it. */
  const currentOutline = useMemo(() => {
    let best = -1;
    (session?.outline ?? []).forEach((t, i) => {
      if (t.page !== null && t.page <= page) best = i;
    });
    return best;
  }, [session, page]);

  // ---- zoom ----
  const stepZoom = useCallback((dir: 1 | -1) => {
    setZoom((z) => {
      const i = ZOOMS.indexOf(z);
      const next = i < 0 ? 3 : Math.min(ZOOMS.length - 1, Math.max(0, i + dir));
      return ZOOMS[next];
    });
  }, []);

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
      // Ctrl+F is the one chord worth taking: it means find in this document
      // everywhere else, and a reader that ignored it would be the odd one out.
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.code === "KeyF")) {
        e.preventDefault();
        setPanel("search");
        return;
      }
      // Every other shortcut is the bare key; Ctrl and friends belong to
      // whoever else wants them.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const is = (letter: string, code: string) =>
        e.key === letter || e.key === letter.toUpperCase() || e.code === code;

      if (e.key === "Escape") {
        // One layer at a time: the menu, then a panel, then fullscreen, then
        // the window.
        if (menu) setMenu(null);
        else if (panel) setPanel(null);
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
      // Same key as the book reader's contents, because it is the same thing.
      if (is("c", "KeyC")) {
        e.preventDefault();
        setPanel((p) => (p === "contents" ? null : "contents"));
        return;
      }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        stepZoom(1);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        stepZoom(-1);
        return;
      }
      if (e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        turn(1);
        return;
      }
      if (e.key === "PageUp") {
        e.preventDefault();
        turn(-1);
        return;
      }
      if (e.key === "Home") {
        e.preventDefault();
        goTo(0);
        return;
      }
      if (e.key === "End") {
        e.preventDefault();
        goTo(count - 1);
        return;
      }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const dir = e.key === "ArrowRight" ? 1 : -1;
        e.preventDefault();
        // Arrows step pages when paging and nudge the view when scrolling.
        if (mode === "paged") turn(dir);
        else scrollRef.current?.scrollBy({ top: dir * 120 });
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (mode === "scroll") return; // the container scrolls itself
        e.preventDefault();
        turn(e.key === "ArrowDown" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, goTo, count, onClose, fullscreen, setFull, mode, stepZoom, menu, panel]);

  /** Paging by wheel, once the page itself has nothing left to scroll. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || mode !== "paged") return;
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) < 4) return;
      const down = e.deltaY > 0;
      if (el.scrollHeight > el.clientHeight + 1) {
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
  }, [turn, mode]);

  // Paging resets the scroll each time, or a page you had scrolled down stays
  // scrolled down when the next one arrives.
  useEffect(() => {
    if (mode === "paged") scrollRef.current?.scrollTo({ top: 0, left: 0 });
  }, [mode, index]);

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

  const label =
    count === 0
      ? "…"
      : pair && mode === "paged"
        ? `Pages ${shown[0] + 1}–${shown[1] + 1} of ${count}`
        : `Page ${page + 1} of ${count}`;

  return (
    <div className="relative flex h-full flex-col bg-[#0e0e11] text-slate-200">
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
          <button
            onClick={() => setPanel((p) => (p === "contents" ? null : "contents"))}
            disabled={!session?.outline.length}
            title={
              session && !session.outline.length
                ? "This PDF has no table of contents"
                : "Contents (C)"
            }
            className={cx(
              "shrink-0 rounded-md p-2 transition-colors disabled:opacity-25",
              panel === "contents"
                ? "bg-white/15 text-white"
                : "text-white/50 hover:bg-white/10 hover:text-white"
            )}
          >
            <Icon name="list" className="h-4 w-4" />
          </button>
          <button
            onClick={() => setPanel((p) => (p === "search" ? null : "search"))}
            title="Find in document (Ctrl+F)"
            className={cx(
              "shrink-0 rounded-md p-2 transition-colors",
              panel === "search"
                ? "bg-white/15 text-white"
                : "text-white/50 hover:bg-white/10 hover:text-white"
            )}
          >
            <Icon name="search" className="h-4 w-4" />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div className="truncate text-[13px] font-medium text-white/80">{book.title}</div>
            <div className="truncate text-[11px] text-white/35">{label}</div>
          </div>

          {/* Scroll or page */}
          <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
            {([
              { id: "scroll", label: "Scroll", hint: "Scroll continuously through the document" },
              { id: "paged", label: "Pages", hint: "One page (or spread) at a time" },
            ] as const).map((m) => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                title={m.hint}
                aria-pressed={mode === m.id}
                className={cx(
                  "rounded px-2 py-1 text-[11px] font-medium transition-colors",
                  mode === m.id
                    ? "bg-white/15 text-white"
                    : "text-white/45 hover:bg-white/10 hover:text-white"
                )}
              >
                {m.label}
              </button>
            ))}
          </div>

          {/* Fit, which only means anything when paging */}
          {mode === "paged" && (
            <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
              {([
                { id: "width", label: "Width", hint: "Fill the width" },
                { id: "height", label: "Height", hint: "Fit the whole page" },
              ] as const).map((f) => (
                <button
                  key={f.id}
                  onClick={() => setFit(f.id)}
                  title={f.hint}
                  aria-pressed={fit === f.id}
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
          )}

          {mode === "paged" && (
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
          )}

          {/* Zoom */}
          <div className="flex shrink-0 items-center rounded-md border border-white/10 p-0.5">
            <button
              onClick={() => stepZoom(-1)}
              disabled={zoom <= ZOOMS[0]}
              title="Zoom out (−)"
              className="rounded px-2 py-1 text-[13px] leading-none text-white/45 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              −
            </button>
            <button
              onClick={() => setZoom(1)}
              // The tooltip carries the numbers behind the picture. Whether a
              // page is sharp comes down to the bitmap being exactly as wide as
              // the box it is drawn into, and that is invisible from the
              // outside — this is the only way to see it without a debugger.
              title={`Back to fit — drawn ${Math.round(pageWidth)}css at ${width}px, screen ${dpr}x`}
              className="w-11 rounded px-1 py-1 text-[11px] tabular-nums text-white/60 transition-colors hover:bg-white/10 hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              onClick={() => stepZoom(1)}
              disabled={zoom >= ZOOMS[ZOOMS.length - 1]}
              title="Zoom in (+)"
              className="rounded px-2 py-1 text-[13px] leading-none text-white/45 transition-colors hover:bg-white/10 hover:text-white disabled:opacity-30"
            >
              +
            </button>
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
              title="Open in your system PDF viewer"
              className="rounded-md p-2 text-white/50 hover:bg-white/10 hover:text-white"
            >
              <Icon name="open" className="h-4 w-4" />
            </button>
          )}
        </header>
      )}

      <div className="flex min-h-0 flex-1">
        {panel === "search" && (
          <aside className="flex w-80 shrink-0 flex-col border-r border-white/10">
            <div className="p-2">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") runSearch();
                  if (e.key === "Escape") setPanel(null);
                }}
                placeholder="Find in document…"
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
                  Searches every page. Press Enter to run.
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
                      className={cx(
                        "block w-full border-b border-white/5 px-3 py-2 text-left transition-colors hover:bg-white/5",
                        flash === h && "bg-white/10"
                      )}
                    >
                      <div className="text-[10px] uppercase tracking-wide text-white/25">
                        Page {h.page + 1}
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

        {panel === "contents" && (
          <nav className="w-72 shrink-0 overflow-y-auto border-r border-white/10 py-2">
            {session?.outline.length ? (
              session.outline.map((t, i) => (
                <button
                  key={i}
                  disabled={t.page === null}
                  onClick={() => t.page !== null && goTo(t.page)}
                  style={{ paddingLeft: 14 + t.depth * 14 }}
                  title={t.label}
                  className={cx(
                    "block w-full truncate py-1.5 pr-3 text-left text-[13px] transition-colors",
                    i === currentOutline
                      ? "bg-white/15 text-white"
                      : "text-white/45 hover:bg-white/5 hover:text-white/80",
                    t.page === null && "opacity-40"
                  )}
                >
                  {t.label}
                </button>
              ))
            ) : (
              <p className="px-4 py-2 text-xs text-white/35">
                This PDF carries no table of contents.
              </p>
            )}
          </nav>
        )}

        <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={mode === "scroll" ? onScroll : undefined}
          onContextMenu={onContextMenu}
          onPointerDown={() => setMenu(null)}
          className="h-full w-full overflow-auto"
        >
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
          ) : mode === "scroll" ? (
            // The stack is its true height from the start, with only the
            // visible slice actually rendered inside it.
            //
            // It is also never narrower than the viewport, and pages are
            // offset within it rather than centred by margin. Centring a child
            // that overflows its scroll container puts half the overflow to
            // the left of scroll position zero, where it can't be reached —
            // zoom in and the left edge of every page would be unreachable.
            <div className="relative" style={{ height: layout.total, width: stackWidth }}>
              {sizes.map((_, i) =>
                i < first || i > last ? null : (
                  <div
                    key={i}
                    data-page={i}
                    className="absolute"
                    style={{
                      top: layout.tops[i],
                      left: pageLeft,
                      width: pageWidth,
                      height: layout.heights[i],
                    }}
                  >
                    {/* A placeholder keeps the page's shape while its bitmap is
                        on the way, so scrolling fast shows paper rather than
                        holes. */}
                    {!loaded.has(`${i}@${width}`) && (
                      <div className="absolute inset-0 bg-white/5" />
                    )}
                    <img
                      src={pageUrl(session, i, width)}
                      alt={`Page ${i + 1}`}
                      onLoad={() => markLoaded(`${i}@${width}`)}
                      onError={() => markLoaded(`${i}@${width}`)}
                      draggable={false}
                      // Width only. Forcing the height too means the box and
                      // the bitmap round separately and disagree by a fraction
                      // of a pixel, and the browser scales rather than blits.
                      // Letting the height follow the bitmap's own proportions
                      // keeps it exactly 1:1.
                      style={{ width: pageWidth }}
                      className={cx(
                        "absolute left-0 top-0 h-auto max-w-none select-none bg-white shadow-[0_2px_12px_rgba(0,0,0,.5)] transition-opacity",
                        loaded.has(`${i}@${width}`) ? "opacity-100" : "opacity-0"
                      )}
                    />
                    <TextLayer
                      page={i}
                      runs={runs.get(i) ?? []}
                      scale={scaleFor(i)}
                      highlights={marksFor(i)}
                      register={registerRuns}
                    />
                  </div>
                )
              )}
            </div>
          ) : (
            <>
              {!ready && (
                <div className="pointer-events-none absolute inset-0 grid place-items-center text-slate-600">
                  <Spinner className="h-6 w-6" />
                </div>
              )}
              <div
                className={cx(
                  // `w-max` with a full-width minimum for the same reason the
                  // scrolled stack sets its own width: a zoomed page has to be
                  // able to overflow without losing its left edge.
                  // Centred both ways, whatever the fit. A page smaller than
                  // the window sits in the middle of it with even margins
                  // rather than pinned to a corner.
                  //
                  // Centring used to be turned off for fit-width, on the
                  // worry that a page taller than the window would be centred
                  // into its own overflow and have its top pushed out of
                  // reach. It can't: `min-h-full` lets the row grow to the
                  // page, so there is no spare space to centre into and the
                  // page starts at the top on its own.
                  "flex min-h-full w-max min-w-full items-center justify-center"
                )}
                style={{ gap: pair ? PAGE_GAP : 0 }}
              >
                {shown.map((i) => {
                  const size = sizes[i];
                  const height =
                    size && size.w > 0
                      ? snapToDevice(pageWidth * (size.h / size.w), dpr)
                      : 0;
                  return (
                    <div
                      key={i}
                      data-page={i}
                      className="relative shrink-0"
                      style={{ width: pageWidth, height }}
                    >
                      <img
                        src={pageUrl(session, i, width)}
                        alt={`Page ${i + 1}`}
                        onLoad={() => markLoaded(`${i}@${width}`)}
                        onError={() => markLoaded(`${i}@${width}`)}
                        draggable={false}
                        // Width only, so the bitmap keeps its own proportions
                        // and is blitted rather than scaled.
                        style={{ width: pageWidth }}
                        className={cx(
                          "absolute left-0 top-0 h-auto max-w-none select-none bg-white",
                          ready ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <TextLayer
                        page={i}
                        runs={runs.get(i) ?? []}
                        scale={scaleFor(i)}
                        highlights={marksFor(i)}
                        register={registerRuns}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Click zones, only when paging — scrolled, a click is a click. */}
        {session && mode === "paged" && (
          <>
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
          </>
        )}
        </div>
      </div>

      {menu && (
        <HighlightMenu
          menu={menu}
          onHighlight={highlight}
          onRemove={removeHighlight}
          onCopy={() =>
            navigator.clipboard
              .writeText(menu.spans.map((s) => s.text).join("\n"))
              .catch(() => {})
          }
          onDismiss={() => setMenu(null)}
        />
      )}

      {chrome && (
        <footer className="flex shrink-0 items-center gap-3 px-5 pb-2 pt-1.5">
          <input
            type="range"
            min={0}
            max={Math.max(0, count - 1)}
            value={page}
            onChange={(e) => goTo(Number(e.target.value))}
            disabled={count === 0}
            aria-label="Jump to page"
            className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-white/15 accent-accent-500"
          />
          <span className="w-20 shrink-0 text-right text-[11px] tabular-nums text-white/35">
            {count > 0 ? `${Math.round(((page + 1) / count) * 100)}%` : ""}
          </span>
        </footer>
      )}
    </div>
  );
}

/**
 * The invisible text over a rendered page, which is what makes a PDF
 * selectable at all.
 *
 * The bitmap is a picture of the words; these are the words. Laying them out
 * where they were printed lets the browser's own selection do the work — drag,
 * double-click, copy, all of it — instead of the reader inventing a selection
 * model of its own.
 *
 * Two details matter. Positions arrive in points and are scaled to whatever
 * size the page is drawn at, so selection stays aligned through zoom. And each
 * run is squeezed horizontally to the width it actually occupied: the original
 * font is not on this machine, so the substitute renders at some other width,
 * and without the correction the highlight drifts further from the glyphs the
 * further along the line you drag.
 */
export function TextLayer({
  page,
  runs,
  scale,
  highlights,
  register,
}: {
  page: number;
  runs: TextRun[];
  scale: number;
  highlights: PageHighlight[];
  register: (page: number, el: HTMLElement | null) => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const runsRef = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<Mark[]>([]);

  /**
   * Registered through the ref itself rather than an effect.
   *
   * An effect cannot do this job. Its dependencies would be the page and the
   * register function, both stable, so it runs exactly once — on the first
   * render, when the page's text has not arrived yet and this component
   * returns null before rendering anything. It would register nothing, and
   * never run again to correct itself once the text landed. React calls a ref
   * callback when the element actually appears, which is the moment that
   * matters.
   */
  const attachRuns = useCallback(
    (el: HTMLDivElement | null) => {
      runsRef.current = el;
      register(page, el);
    },
    [page, register]
  );

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const host = runsRef.current;
    if (!layer || !host) return;
    const spans = Array.from(host.children) as HTMLElement[];

    // Written, read and written again in three passes rather than one pass of
    // three steps. A page carries hundreds of runs, and interleaving a style
    // write with a geometry read forces the browser to re-lay-out the whole
    // layer between every pair of them.
    for (const span of spans) span.style.transform = "none";
    const measured = spans.map((span) => span.getBoundingClientRect().width);
    spans.forEach((span, i) => {
      const want = Number(span.dataset.w);
      const got = measured[i];
      if (want > 0 && got > 0) span.style.transform = `scaleX(${want / got})`;
    });

    // Highlights are measured from the laid-out runs rather than stored as
    // rectangles, so they follow the text through zoom, a resize, or a
    // different window entirely. Line boxes come from the range itself, which
    // is what makes a highlight spanning three lines three rectangles rather
    // than one block over the paragraph.
    const origin = layer.getBoundingClientRect();
    const prefix = runPrefixes(runs);
    const out: Mark[] = [];
    for (const hl of highlights) {
      for (const slice of runSlices(runs, prefix, hl.start, hl.end)) {
        const node = spans[slice.run]?.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const length = node.textContent?.length ?? 0;
        const range = document.createRange();
        range.setStart(node, Math.min(slice.from, length));
        range.setEnd(node, Math.min(slice.to, length));
        for (const rect of Array.from(range.getClientRects())) {
          if (rect.width < 0.5 || rect.height < 0.5) continue;
          out.push({
            id: hl.id,
            color: hl.color,
            x: rect.left - origin.left,
            y: rect.top - origin.top,
            w: rect.width,
            h: rect.height,
          });
        }
      }
    }
    setMarks(out);
  }, [runs, scale, highlights]);

  if (scale <= 0 || runs.length === 0) return null;

  return (
    // The layer itself is transparent to the mouse so that clicks landing in
    // the margins still reach the page-turn zones underneath; only the runs
    // themselves take the pointer.
    <div
      ref={layerRef}
      className="pdf-text-layer pointer-events-none absolute inset-0 select-text"
    >
      {/* Under the runs, so a highlight tints the page rather than burying the
          words, and multiply keeps the printed ink readable through it. */}
      <div className="absolute inset-0" aria-hidden>
        {marks.map((m, i) => (
          <div
            key={i}
            className="absolute"
            style={{
              left: m.x,
              top: m.y,
              width: m.w,
              height: m.h,
              background: MARK_COLORS[m.color] ?? MARK_COLORS.yellow,
              mixBlendMode: "multiply",
            }}
          />
        ))}
      </div>
      <div ref={attachRuns} className="absolute inset-0">
        {runs.map((r, i) => (
          <span
            key={i}
            data-w={r.w * scale}
            // `select-text` on each run rather than only on the layer: it is the
            // runs that get selected, and stating it here survives whatever a
            // future global rule decides about everything else.
            className="pointer-events-auto absolute cursor-text select-text text-transparent"
            style={{
              left: r.x * scale,
              top: r.y * scale,
              fontSize: Math.max(1, r.h * scale),
              lineHeight: 1,
              whiteSpace: "pre",
              transformOrigin: "left top",
            }}
          >
            {r.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A highlight reduced to what the text layer needs to draw it. */
interface PageHighlight {
  id: number;
  start: number;
  end: number;
  color: string;
}

/** One rectangle of a drawn highlight, relative to the page. */
interface Mark {
  id: number;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which character of a page's text a run element and offset correspond to.
 *
 * Returns null when the node belongs to some other page, which is how a
 * selection dragged across a page boundary is recognised.
 */
function offsetIn(
  host: HTMLElement,
  prefix: number[],
  node: Node,
  offset: number
): number | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as HTMLElement);
  if (!el || !host.contains(el)) return null;
  const index = Array.prototype.indexOf.call(host.children, el);
  if (index < 0) return null;
  return (prefix[index] ?? 0) + offset;
}

/**
 * The part of one page that the current selection covers.
 *
 * A selection can start on one page and end three pages later, so each page is
 * asked separately what it contributes. An end that falls outside this page
 * means the selection ran past it, and the page is covered to its edge.
 */
export function selectionOnPage(
  host: HTMLElement,
  runs: TextRun[],
  range: Range
): { start: number; end: number } | null {
  if (!range.intersectsNode(host)) return null;
  const prefix = runPrefixes(runs);
  const total = textLength(runs);
  const rawStart = offsetIn(host, prefix, range.startContainer, range.startOffset);
  const rawEnd = offsetIn(host, prefix, range.endContainer, range.endOffset);
  // Neither end on this page means the page sits in the middle of the
  // selection and is covered entirely.
  const start = rawStart ?? 0;
  const end = rawEnd ?? total;
  if (end <= start) return null;
  return { start, end };
}

/** The character offset under a point, for deciding what was right-clicked. */
function offsetAtPoint(host: HTMLElement, runs: TextRun[], x: number, y: number): number | null {
  const doc = host.ownerDocument;
  // `caretRangeFromPoint` is the WebKit/Blink spelling; this only ever runs in
  // WebView2, but guard rather than throw if that ever stops being true.
  const caret = doc.caretRangeFromPoint?.(x, y);
  if (!caret) return null;
  return offsetIn(host, runPrefixes(runs), caret.startContainer, caret.startOffset);
}

/** A page's share of a selection, captured before the menu can collapse it. */
interface SelectedSpan {
  page: number;
  start: number;
  end: number;
  text: string;
}

type PdfMenu = {
  x: number;
  y: number;
  /**
   * What was selected when the menu opened. Captured rather than read on
   * demand, because opening the menu is what destroys the selection.
   */
  spans: SelectedSpan[];
  /** The highlight under the cursor, when the click landed on one. */
  hit: number | null;
} | null;

/**
 * The right-click menu: colours when something is selected, removal when the
 * click landed on a highlight.
 *
 * It replaces WebView2's own menu, which otherwise offers to reload the page
 * and open developer tools over a book.
 */
function HighlightMenu({
  menu,
  onHighlight,
  onRemove,
  onCopy,
  onDismiss,
}: {
  menu: NonNullable<PdfMenu>;
  onHighlight: (spans: SelectedSpan[], color: string) => void;
  onRemove: (id: number) => void;
  onCopy: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="fixed z-50 min-w-44 overflow-hidden rounded-lg border border-white/10 bg-slate-900/95 py-1 shadow-2xl backdrop-blur"
      style={{
        left: Math.min(menu.x, window.innerWidth - 200),
        top: Math.min(menu.y, window.innerHeight - 130),
      }}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
      // Stops the press collapsing the selection, so it stays visible behind
      // the menu. The offsets are already captured either way.
      onMouseDown={(e) => e.preventDefault()}
    >
      {menu.spans.length > 0 && (
        <div className="flex items-center gap-1.5 border-b border-white/10 px-3 py-2">
          <span className="mr-auto text-[11px] text-slate-500">Highlight</span>
          {Object.entries(HIGHLIGHT_COLORS).map(([name, css]) => (
            <button
              key={name}
              title={name}
              onClick={() => {
                onHighlight(menu.spans, name);
                onDismiss();
              }}
              className="h-5 w-5 rounded-full border border-white/20 transition-transform hover:scale-110"
              style={{ background: css }}
            />
          ))}
        </div>
      )}
      {menu.spans.length > 0 && (
        <button
          onClick={() => {
            onCopy();
            onDismiss();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon name="check" className="h-3.5 w-3.5 opacity-60" />
          Copy
        </button>
      )}
      {menu.hit !== null && (
        <button
          onClick={() => {
            onRemove(menu.hit as number);
            onDismiss();
          }}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-slate-300 hover:bg-white/10 hover:text-white"
        >
          <Icon name="trash" className="h-3.5 w-3.5 opacity-60" />
          Remove highlight
        </button>
      )}
    </div>
  );
}
