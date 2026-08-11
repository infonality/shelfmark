/**
 * Where a PDF's pages go, and how big they are rendered.
 *
 * Split out of the reader for the same reason `reader-layout` is: this is the
 * arithmetic, and arithmetic can be checked. The reader above it is the state
 * around it.
 *
 * All of this works from the page sizes the document itself declares, which
 * arrive before anything has been rasterised. That is what lets a
 * five-hundred-page book have a truthful scrollbar from the moment it opens.
 */

import { PageSize, PdfSession, TextRun } from "./api";

/** Gap between pages when scrolling, in CSS pixels. */
export const PAGE_GAP = 16;

/** Matches the clamp in the Rust renderer; asking beyond it just wastes work. */
export const MAX_RENDER_WIDTH = 4000;
export const MIN_RENDER_WIDTH = 200;

/**
 * The pixel width to rasterise a page at: exactly the pixels it will occupy on
 * screen, and no others.
 *
 * This looks like a place to round. Quantise the width to a step and dragging a
 * window edge stops asking for a new bitmap every frame, which is why it was
 * written that way first. Don't: a stepped width leaves the browser scaling the
 * bitmap by whatever ratio is left over, and resampling glyphs by 1.13 visibly
 * softens them. Rendered at 1400 and shown at 1238, body text goes blurry —
 * which is exactly what "rendering is not sharp" turned out to be.
 *
 * Oversampling — rendering at 2x and letting the browser halve it — was the
 * obvious alternative, and measured barely better than 1:1 for four times the
 * pixels. The awkward ratio was the problem, not the resolution.
 *
 * The cost is that resizing renders as it goes. Each is about 20ms, they land
 * in the cache, and a window that has stopped moving asks for one width from
 * then on.
 */
export function renderWidth(cssWidth: number, dpr: number): number {
  const exact = Math.round(Math.max(1, cssWidth) * Math.max(1, dpr));
  return Math.min(MAX_RENDER_WIDTH, Math.max(MIN_RENDER_WIDTH, exact));
}

/**
 * Round a css length to a whole device pixel.
 *
 * Every size and offset a page bitmap depends on goes through this. A bitmap
 * drawn into a box that is a fraction of a device pixel off — in either
 * dimension — is resampled rather than blitted, and resampled glyphs look
 * soft. Exact pixels are the whole game.
 */
export function snapToDevice(value: number, dpr: number): number {
  const scale = Math.max(1, dpr);
  return Math.round(value * scale) / scale;
}

export function pageUrl(session: PdfSession, index: number, width: number): string {
  return `${session.resource_base}page/${index}?w=${width}`;
}

/** A page wider than it is tall is already a spread. */
function isWide(sizes: PageSize[], i: number): boolean {
  const s = sizes[i];
  return !!s && s.w > s.h;
}

/**
 * Group pages into what is shown at once when paging two-up.
 *
 * Same two rules as a comic — the first page stands alone so later spreads
 * aren't one page out of step, and a landscape page is already a spread — but
 * here they can be applied immediately, because the sizes came with the
 * document rather than with the images.
 */
export function buildSpreads(sizes: PageSize[], twoUp: boolean): number[][] {
  const out: number[][] = [];
  let i = 0;
  while (i < sizes.length) {
    if (!twoUp || i === 0 || isWide(sizes, i)) {
      out.push([i]);
      i += 1;
    } else if (i + 1 < sizes.length && !isWide(sizes, i + 1)) {
      out.push([i, i + 1]);
      i += 2;
    } else {
      out.push([i]);
      i += 1;
    }
  }
  return out;
}

export interface Stack {
  /** Each page's offset from the top of the document, in CSS pixels. */
  tops: number[];
  heights: number[];
  total: number;
}

/**
 * Where each page sits in the scrolled document, and how tall it is.
 *
 * Heights come from the declared page sizes, so this is exact before a single
 * page has been rendered — which is why the scrollbar doesn't lurch about as
 * you read.
 */
export function stackLayout(
  sizes: PageSize[],
  width: number,
  gap = PAGE_GAP,
  dpr = 1
): Stack {
  const tops: number[] = [];
  const heights: number[] = [];
  let y = 0;
  for (const size of sizes) {
    // A page with a nonsense size still has to occupy something, or every page
    // after it lands at the same offset. A4 is the least surprising guess.
    const ratio = size.w > 0 && size.h > 0 ? size.h / size.w : Math.SQRT2;
    // Snapped to a whole device pixel rather than a whole css pixel. Under
    // display scaling those are not the same thing, and a page that starts
    // half a device pixel off makes the browser resample its bitmap, which on
    // text reads as blur.
    const h = snapToDevice(Math.max(1, width) * ratio, dpr);
    tops.push(y);
    heights.push(h);
    y += h + gap;
  }
  return { tops, heights, total: Math.max(0, y - gap) };
}

/** The last page whose top is at or above `y` — the one you are looking at. */
export function pageAtOffset(tops: number[], y: number): number {
  let lo = 0;
  let hi = tops.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (tops[mid] <= y) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/**
 * Which pages to render: everything visible, plus `overscan` screens either
 * side, so scrolling at a normal speed never outruns the renderer.
 */
export function visibleRange(
  tops: number[],
  scrollTop: number,
  viewport: number,
  overscan: number
): [number, number] {
  if (tops.length === 0) return [0, -1];
  const margin = Math.max(0, viewport) * overscan;
  const first = pageAtOffset(tops, scrollTop - margin);
  const limit = scrollTop + viewport + margin;
  let last = first;
  while (last + 1 < tops.length && tops[last + 1] < limit) last += 1;
  return [first, last];
}

/**
 * Anchoring a highlight to a place in a PDF.
 *
 * A highlight has to survive being closed, reopened, zoomed and re-rendered,
 * so it cannot be stored as rectangles — those are a property of how wide the
 * page happened to be drawn that day. It is stored instead as a character
 * range in the page's text, exactly as the book reader stores one: the page
 * takes the place of the spine index, and the offsets index the page's runs
 * joined end to end.
 *
 * That leaves one job for the reader: turning a character range back into
 * rectangles at whatever size the page is now.
 */

/** Where each run starts in the page's text, and how long the text is. */
export function runPrefixes(runs: TextRun[]): number[] {
  const out: number[] = [];
  let n = 0;
  for (const run of runs) {
    out.push(n);
    n += run.text.length;
  }
  return out;
}

export function textLength(runs: TextRun[]): number {
  let n = 0;
  for (const run of runs) n += run.text.length;
  return n;
}

/** The piece of one run that a character range covers. */
export interface RunSlice {
  /** Index into `runs`. */
  run: number;
  /** Character range within that run's own text. */
  from: number;
  to: number;
}

/**
 * Which runs a character range touches, and how much of each.
 *
 * Ranges are half-open, so a highlight ending exactly where a run begins does
 * not reach into it — otherwise every highlight would bleed one run further
 * than the reader dragged.
 */
export function runSlices(
  runs: TextRun[],
  prefix: number[],
  start: number,
  end: number
): RunSlice[] {
  const lo = Math.min(start, end);
  const hi = Math.max(start, end);
  const out: RunSlice[] = [];
  if (hi <= lo) return out;
  for (let i = 0; i < runs.length; i++) {
    const runStart = prefix[i] ?? 0;
    const runEnd = runStart + runs[i].text.length;
    if (runEnd <= lo || runStart >= hi) continue;
    out.push({
      run: i,
      from: Math.max(0, lo - runStart),
      to: Math.min(runs[i].text.length, hi - runStart),
    });
  }
  return out;
}

/** The text a character range covers, for storing alongside the highlight. */
export function textBetween(
  runs: TextRun[],
  prefix: number[],
  start: number,
  end: number
): string {
  return runSlices(runs, prefix, start, end)
    .map((s) => runs[s.run].text.slice(s.from, s.to))
    .join("");
}
