/**
 * Pagination for the reader frame.
 *
 * The chapter is laid out as CSS multi-column text in a box exactly the size of
 * the frame, and a "page" is one viewport width of horizontal scroll. That only
 * works if the columns advance at exactly the rate we scroll, which constrains
 * the geometry more than it looks:
 *
 *   column pitch = column width + column gap
 *
 * With one column of width `w - 2*pad` the pitch is `w - 2*pad + gap`, so the
 * gap has to be `2 * pad` for the pitch to come out at `w`. Any other gap and
 * every page turn drifts by the difference — a gap of `1.8 * pad` loses a fifth
 * of a margin per page, which at the default margin is 11px a turn and half a
 * column by the tenth. The same identity holds for two columns: each is
 * `(w - 4*pad)/2` wide, so a spread advances by `w` and the gutter lands dead
 * centre, which is where the spine rule is drawn.
 *
 * Everything here therefore derives the gap from the margin rather than taking
 * them as independent settings. Widths are kept fractional throughout, because
 * rounding the page width to an integer reintroduces the same drift at a
 * smaller scale.
 */

import { Chapter, ReaderSession } from "./api";
import { FONT_STACKS, ReaderPrefs, THEMES } from "./reader-prefs";

/** Width past which a second column reads better than one long line. */
export const IDEAL_COLUMN = 720;

/** Highlight drawn over a search result. */
export const SEEK_COLOR = "rgba(255,193,7,.5)";

/** Where to land once a chapter has been laid out. */
export type Landing =
  | { kind: "page"; page: number }
  /** A fraction through the chapter — survives a reflow, unlike a page number. */
  | { kind: "ratio"; ratio: number }
  /** The last page, for paging backwards into a chapter. */
  | { kind: "end" }
  /** A `#fragment` from the table of contents or an internal link. */
  | { kind: "fragment"; id: string }
  /** A stored annotation, by character offsets into the chapter text. */
  | { kind: "offsets"; start: number; end: number }
  /** Wherever the current search match was drawn. */
  | { kind: "flash" };

export interface Geometry {
  /** Frame width in CSS pixels; also the width of one page. */
  w: number;
  h: number;
  cols: 1 | 2;
  /** Horizontal page margin. The column gap is twice this. */
  pad: number;
}

export function geometryFor(w: number, h: number, prefs: ReaderPrefs): Geometry {
  const cols: 1 | 2 = w >= IDEAL_COLUMN * 2 ? 2 : 1;
  return { w, h, cols, pad: clampMargin(prefs.margin, w, cols) };
}

/**
 * The margin, held back far enough to leave a readable column. Without this a
 * wide margin on a narrow window collapses the text to a few characters, or
 * with two columns to nothing at all.
 */
function clampMargin(margin: number, w: number, cols: 1 | 2): number {
  const min = 8;
  const room = cols === 2 ? (w - 240) / 4 : (w - 200) / 2;
  return Math.max(min, Math.min(margin, Math.floor(room)));
}

/**
 * How many pages the laid-out chapter occupies.
 *
 * With the geometry above `scrollWidth` is an exact multiple of the page width
 * for one column, and of half of it for two — a spread whose second column is
 * empty still counts as a page. The slack absorbs the browser rounding
 * `scrollWidth` up to a whole pixel; a genuine extra column adds at least half
 * a page, so it can never be swallowed.
 */
export function countPages(scrollWidth: number, w: number): number {
  if (w < 1) return 1;
  return Math.max(1, Math.ceil(scrollWidth / w - 0.05));
}

/**
 * Impose the reading layout on the chapter document.
 *
 * The geometry is `!important` throughout. This stylesheet is appended after
 * the publisher's, so it already wins on ordering, but a book that declares
 * `body { margin: 5% !important }` would otherwise take the columns with it and
 * every page after the first would be misaligned.
 */
export function applyLayoutStyle(doc: Document, g: Geometry, prefs: ReaderPrefs) {
  // The page width is applied by scrolling, not by sizing anything, so `g.w`
  // appears below only as a column width, never as a page width.
  const { w, h, cols, pad } = g;
  const t = THEMES[prefs.theme];
  const gap = pad * 2;
  const bottom = pad * 0.75;
  // The column width, stated rather than left to `column-count` to work out.
  //
  // Both spellings ask for the same layout and every engine computes the same
  // used width from either — but only a non-auto `column-width` is guaranteed
  // to produce a multi-column flow at all. WebKit decides that in
  // `RenderBlockFlow::willCreateColumns`, and the branch that accepts a plain
  // `column-count` is `#if PLATFORM(COCOA)`-guarded and skips a count of one.
  // On macOS a single-column chapter therefore never fragmented: the whole
  // thing became one tall column, clipped by the window, counted as one page,
  // and a page turn ran off the end into the next chapter. Two columns were
  // fine, so it only showed up in a window too narrow for a spread.
  //
  // Half a pixel comes off so that rounding can only ever land the count on
  // the value below the one asked for, never above it; `column-count` stays as
  // the ceiling. The used width the engine computes back is unchanged, so the
  // page pitch identity at the top of this file still holds exactly.
  const column = Math.max(1, (w - pad * 2 - (cols - 1) * gap) / cols - 0.5);
  // The tallest a figure can be and still fit the page it starts on.
  const contentH = Math.max(80, h - pad - bottom);

  preservePublisherFontScale(doc);

  // Tinted and dark pages override the book's colours; plain light ones leave
  // them alone. See `forceColors` in reader-prefs.
  const recolour = !t.forceColors
    ? ""
    : `body, body * { color:${t.fg} !important; background-color:transparent !important;
         border-color:rgba(128,128,128,.35) !important; }
       a, a * { color:${t.link} !important; }
       img, svg, video { filter:${prefs.theme === "night" ? "brightness(.82)" : "none"}; }`;

  // Only override the typeface when the reader has actually chosen one;
  // "publisher" leaves the book's own @font-face and families in charge.
  const family =
    prefs.font === "publisher"
      ? ""
      : `body, body * { font-family:${FONT_STACKS[prefs.font]} !important; }`;

  const css = `
    html {
      margin:0 !important; padding:0 !important;
      height:100% !important;
      font-size:${prefs.size}px !important;
      overflow:hidden !important;
      /* Scroll anchoring would "helpfully" shift the page when a late image
         changes the layout, which reads as the text sliding sideways. */
      overflow-anchor:none !important;
      background:${t.bg};
      -webkit-text-size-adjust:none;
    }
    body {
      margin:0 !important;
      padding:${pad}px ${pad}px ${bottom}px !important;
      width:auto !important; min-width:0 !important; max-width:none !important;
      height:${h}px !important; min-height:0 !important; max-height:none !important;
      box-sizing:border-box !important;
      column-width:${column}px !important;
      column-count:${cols} !important;
      column-gap:${gap}px !important;
      column-fill:auto !important;
      -webkit-column-width:${column}px !important;
      -webkit-column-count:${cols} !important;
      -webkit-column-gap:${gap}px !important;
      overflow:visible !important;
      overflow-anchor:none !important;
      overflow-wrap:break-word;
      background:${t.bg};
      font-size:1rem;
      line-height:${prefs.lineHeight};
      text-align:${prefs.justify ? "justify" : "left"};
      hyphens:${prefs.justify ? "auto" : "manual"};
      -webkit-hyphens:${prefs.justify ? "auto" : "manual"};
      orphans:2;
      widows:2;
    }
    ${family}
    ${recolour}
    /* Nothing may be wider than a column or taller than the page: an oversized
       figure would otherwise straddle the gutter or push a column off the end,
       and both look exactly like the layout having come apart.

       These are a ceiling and nothing more. Forcing an auto width here as well
       would throw away the size the publisher chose and blow every inline
       decoration up to its natural pixel size, which is far too big for a
       figure meant to sit in a paragraph. */
    img, svg, video, canvas, [data-bv-page-media] {
      max-width:min(100%, ${column}px) !important;
      max-height:${contentH}px !important;
      box-sizing:border-box;
    }
    /* Respect publisher dimensions such as a two-em imprint logo. When both
       dimensions define a box, contain the bitmap inside it rather than
       stretching its pixels to match the box's proportions. */
    img, video { object-fit:contain !important; }
    /* A publisher can opt a figure into column-span:all, float it across a
       gutter, or put a viewport-wide box around it. Media and media-only
       ancestors are marked before the chapter is serialized so every visual
       participates in one column's flow as one indivisible unit. */
    [data-bv-page-media], [data-bv-page-media-wrapper] {
      column-span:none !important;
      -webkit-column-span:none !important;
      break-inside:avoid-column !important;
      page-break-inside:avoid !important;
      -webkit-column-break-inside:avoid !important;
      max-width:min(100%, ${column}px) !important;
      box-sizing:border-box !important;
    }
    [data-bv-page-media] {
      position:static !important;
      display:inline-block;
      vertical-align:top;
    }
    [data-bv-page-media-wrapper] {
      position:static !important;
    }
    [data-bv-empty-media-wrapper] {
      height:auto !important;
      min-height:0 !important;
      max-height:${contentH}px !important;
      line-height:0 !important;
    }
    /* Leave room for a normal multi-line caption so the image plus caption can
       still fit the page as an unbroken figure. */
    figure[data-bv-page-media-wrapper] [data-bv-page-media] {
      max-height:calc(${contentH}px - 4rem) !important;
    }
    img, svg, figure, picture { break-inside:avoid; page-break-inside:avoid; }
    /* A short table stays together naturally, while a long one is allowed to
       continue between rows. Marking the entire table unbreakable makes a
       multi-page appendix overflow the reader instead of paginating. */
    table {
      max-width:min(100%, ${column}px) !important;
      break-inside:auto !important;
      page-break-inside:auto !important;
    }
    thead, tr {
      break-inside:avoid !important;
      page-break-inside:avoid !important;
      -webkit-column-break-inside:avoid !important;
    }
    th, td { min-width:0; overflow-wrap:anywhere; }
    pre { white-space:pre-wrap; word-wrap:break-word; }
    h1, h2, h3, h4 { break-after:avoid; text-align:left; hyphens:none; }
    ::selection { background:rgba(120,110,255,.28); }
  `;

  let style = doc.getElementById(LAYOUT_STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement("style");
    style.id = LAYOUT_STYLE_ID;
  }
  if (style.textContent !== css) style.textContent = css;
  // Always last in the head, so a stylesheet the publisher loads late can't
  // end up overriding the geometry.
  if (style.parentNode !== doc.head || doc.head.lastChild !== style) {
    doc.head.appendChild(style);
  }
}

const LAYOUT_STYLE_ID = "bv-layout";
const VEIL_STYLE_ID = "bv-veil";
const PUBLISHER_FONT_SCALE = "data-bv-font-scale";

/**
 * Turn the publisher's computed sizes into root-relative sizes once per
 * chapter. EPUB styles frequently use absolute keywords such as `small`,
 * which ignore a font size set on `body`; preserving the computed ratios as
 * `rem` lets the reader's root size scale prose, headings and notes together.
 */
function preservePublisherFontScale(doc: Document) {
  const root = doc.documentElement;
  const view = doc.defaultView;
  if (!view || root.hasAttribute(PUBLISHER_FONT_SCALE)) return;

  const rootPx = Number.parseFloat(view.getComputedStyle(root).fontSize) || 16;
  const elements = [doc.body, ...Array.from(doc.body.querySelectorAll<HTMLElement>("*"))];
  const sizes = elements.map((el) => Number.parseFloat(view.getComputedStyle(el).fontSize));

  root.setAttribute(PUBLISHER_FONT_SCALE, "");
  elements.forEach((el, i) => {
    const px = sizes[i];
    if (Number.isFinite(px) && px > 0) {
      el.style.setProperty("font-size", `${px / rootPx}rem`, "important");
    }
  });
}

/**
 * Show a page by translating the content, rather than scrolling to it.
 *
 * Scrolling looks like the obvious mechanism and is wrong at exactly one place:
 * the last page. A scroll container's scrollable overflow region does not
 * include the trailing padding of its contents, so with a `pad` right margin
 * the maximum scroll offset lands `pad` pixels short of where the final column
 * actually sits, and the browser silently clamps to it. Every page but the last
 * is fine, which is what makes it look like a drift that only appears near the
 * end of a chapter.
 *
 * A transform has no clamp, and being composited it makes a page turn cheaper
 * rather than more expensive.
 */
export function showPage(doc: Document, page: number, w: number) {
  doc.body.style.transform = page <= 0 ? "none" : `translateX(${-page * w}px)`;
}

/**
 * Put the content back at offset zero. Measuring has to happen here: every
 * client rect is then already a document-space position, which is what
 * `pageForRange` and `pageForElement` assume.
 */
export function clearOffset(doc: Document) {
  doc.body.style.transform = "none";
}

/** Drop the cover that hides the chapter until it has been positioned. */
export function reveal(doc: Document) {
  doc.getElementById(VEIL_STYLE_ID)?.remove();
}

/**
 * Wait for the things that change a chapter's measurements after it first
 * paints: web fonts and images. Both are capped, because one unreachable asset
 * must not leave the reader sitting behind the veil forever.
 */
export function settle(doc: Document, timeoutMs = 2500): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  const waits: Promise<unknown>[] = [Promise.resolve(fonts?.ready).catch(() => {})];

  for (const img of Array.from(doc.images)) {
    if (img.complete) continue;
    waits.push(
      new Promise<void>((done) => {
        img.addEventListener("load", () => done(), { once: true });
        img.addEventListener("error", () => done(), { once: true });
      })
    );
  }

  return Promise.race([
    Promise.all(waits).then(() => {}),
    new Promise<void>((done) => setTimeout(done, timeoutMs)),
  ]);
}

/**
 * Where a link inside the book points, or null if it leaves the book.
 *
 * `raw` is the href as the publisher wrote it and `href` is the browser's
 * resolved absolute form. Both are needed: a bare `#note` resolves against the
 * frame's `<base>` rather than the chapter, so only the raw attribute reveals
 * that it meant "here".
 */
export function internalTarget(
  session: ReaderSession,
  chapter: Chapter,
  raw: string,
  href: string
): { spine: number; fragment: string | null } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) {
    return { spine: chapter.index, fragment: decode(trimmed.slice(1)) || null };
  }

  const base = session.resource_base;
  if (!href.startsWith(base)) return null;

  const rest = href.slice(base.length);
  const hash = rest.indexOf("#");
  const path = decode(hash < 0 ? rest : rest.slice(0, hash));
  const fragment = hash < 0 ? null : decode(rest.slice(hash + 1)) || null;

  const spine = findSpine(session, path);
  return spine === null ? null : { spine, fragment };
}

/** Match an archive path against the spine, forgiving case and encoding. */
function findSpine(session: ReaderSession, path: string): number | null {
  const want = path.toLowerCase();
  if (!want) return null;
  let i = session.spine.findIndex((s) => s.path.toLowerCase() === want);
  if (i < 0) {
    const leaf = want.split("/").pop();
    i = session.spine.findIndex((s) => s.path.toLowerCase().split("/").pop() === leaf);
  }
  return i < 0 ? null : i;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Namespaces whose elements the HTML parser knows how to adopt on sight. */
const FOREIGN_NS = [
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/1998/Math/MathML",
];

/**
 * Drop the namespace prefix from SVG and MathML element names.
 *
 * A chapter is XHTML, but it is parsed here as HTML, which is far more
 * forgiving of the malformed markup real EPUBs are full of. The one thing HTML
 * parsing cannot do is honour a namespace prefix: written `<svg:svg>`, the
 * parser produces an unknown element in the XHTML namespace — no box, no
 * rendered children — so a cover page authored that way comes out completely
 * blank. Written `<svg>`, the same parser adopts it into the SVG namespace and
 * it renders. The prefix is the only difference.
 *
 * Only prefixes the document itself binds to SVG or MathML are touched, and
 * only where they open or close a tag, so this can't disturb prose that happens
 * to contain a colon after a less-than sign.
 */
export function unprefixForeignMarkup(html: string): string {
  const declarations = /xmlns:([A-Za-z_][\w.-]*)\s*=\s*["']([^"']+)["']/g;
  const prefixes = new Set<string>();
  for (const m of html.matchAll(declarations)) {
    if (FOREIGN_NS.includes(m[2].trim())) prefixes.add(m[1]);
  }
  if (prefixes.size === 0) return html;

  let out = html;
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
    out = out.replace(new RegExp(`(</?)${escaped}:(?=[A-Za-z])`, "g"), "$1");
  }
  return out;
}

/** HTML elements for which an XHTML self-closing slash is unsafe in HTML. */
const NON_VOID_HTML_ELEMENTS = new Set([
  "a", "abbr", "address", "article", "aside", "audio", "b", "bdi", "bdo",
  "blockquote", "button", "caption", "cite", "code", "colgroup", "data",
  "datalist", "dd", "del", "details", "dfn", "dialog", "div", "dl", "dt",
  "em", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "i", "ins", "kbd", "label",
  "legend", "li", "main", "map", "mark", "menu", "meter", "nav", "noscript",
  "object", "ol", "optgroup", "option", "output", "p", "picture", "pre",
  "progress", "q", "rp", "rt", "ruby", "s", "samp", "section", "select",
  "slot", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "template", "textarea", "tfoot", "th", "thead", "time",
  "tr", "u", "ul", "var", "video",
]);

/**
 * Turn XHTML's self-closing HTML elements into explicit opening and closing
 * tags before using the forgiving HTML parser.
 *
 * HTML only honours the self-closing slash on void elements and on elements
 * inside SVG or MathML. EPUBs routinely use valid XHTML such as
 * `<span role="doc-pagebreak"/>`, `<a id="figure"/>`, and even `<td/>`. Parsed
 * directly as HTML, one of those becomes an opening tag that swallows the rest
 * of the chapter. This used to produce random giant links; once page markers
 * were hidden it could hide the complete chapter.
 *
 * The allowlist deliberately contains HTML elements only. Foreign-content
 * elements such as SVG `<path/>` and `<image/>` keep their XML form so the HTML
 * parser can apply its native SVG and MathML rules.
 */
export function closeSelfClosingHtmlElements(html: string): string {
  return html.replace(
    /<([A-Za-z][\w.-]*)(\b(?:[^>"']|"[^"]*"|'[^']*')*)\/\s*>/g,
    (tag, rawName: string) => {
      const name = rawName.toLowerCase();
      if (!NON_VOID_HTML_ELEMENTS.has(name)) return tag;
      return `${tag.replace(/\/\s*>$/, ">")}</${rawName}>`;
    }
  );
}

/**
 * Where the book's own files come from. Tauri maps a custom scheme onto an http
 * origin on Windows and serves it as a real scheme elsewhere, so both spellings
 * have to be allowed — see `resource_base` in `src-tauri/src/commands.rs`.
 */
const RESOURCE_SOURCES = "bookres: http://bookres.localhost";

/**
 * The policy the chapter document is rendered under.
 *
 * `script-src 'none'` is the load-bearing line: it, and not the frame's sandbox,
 * is what stops an EPUB executing anything. See the security note in
 * `pages/Reader.tsx` for why the job moved here. Everything else is the shortest
 * list that still lets a book look like itself — its stylesheets, its embedded
 * fonts, its images — and nothing may be fetched from the network.
 *
 * `base-uri` is not `'none'`: this document is given a `<base>` of its own
 * below, and the chapter's relative URLs are worthless without it.
 */
const CHAPTER_CSP = [
  "default-src 'none'",
  `img-src ${RESOURCE_SOURCES} data: blob:`,
  `style-src ${RESOURCE_SOURCES} 'unsafe-inline'`,
  `font-src ${RESOURCE_SOURCES} data:`,
  `media-src ${RESOURCE_SOURCES} data: blob:`,
  `base-uri ${RESOURCE_SOURCES}`,
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

/**
 * Wrap chapter markup for the frame. A `<base>` pointed at the chapter's folder
 * inside the archive makes every relative URL the publisher wrote — images,
 * stylesheets, `@font-face` sources — resolve through the resource protocol
 * untouched, which is what keeps the original typography intact.
 *
 * The document starts hidden. A chapter opened part-way through would otherwise
 * paint at page one and then jump, which is the single most visible piece of
 * jank in a paginated reader.
 */
export function buildDocument(chapter: Chapter, resourceBase: string): string {
  const base = `${resourceBase}${chapter.dir ? `${chapter.dir}/` : ""}`;
  const markup = closeSelfClosingHtmlElements(unprefixForeignMarkup(chapter.html));
  const doc = new DOMParser().parseFromString(markup, "text/html");

  normalizeDocumentLanguages(doc);
  preserveImageAspectRatios(doc);
  markMediaForPagination(doc);

  // First in the head, before anything that could fetch or run. A book may
  // carry a policy of its own; a second one can only narrow this, never widen
  // it, so arriving first is all the precedence needed.
  const csp = doc.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", CHAPTER_CSP);
  doc.head.insertBefore(csp, doc.head.firstChild);

  const baseEl = doc.createElement("base");
  baseEl.setAttribute("href", base);
  doc.head.insertBefore(baseEl, csp.nextSibling);

  // Defaults the publisher's own stylesheet can still override, since these
  // come first in the cascade.
  const defaults = doc.createElement("style");
  defaults.textContent = `
    body { font-family:'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;
           -webkit-font-smoothing:antialiased; }
    p { margin:0 0 0.2em; text-indent:1.3em; }
    p:first-of-type, h1 + p, h2 + p, h3 + p, blockquote p { text-indent:0; }
    h1,h2,h3 { font-weight:600; letter-spacing:-0.01em; }
    blockquote { margin:1em 1.5em; font-style:italic; }
    [epub\\:type~="pagebreak"]:empty, [role~="doc-pagebreak"]:empty { display:none; }
  `;
  doc.head.insertBefore(defaults, baseEl.nextSibling);

  const veil = doc.createElement("style");
  veil.id = VEIL_STYLE_ID;
  veil.textContent = `html { visibility:hidden; }`;
  doc.head.appendChild(veil);

  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/**
 * XHTML understands `xml:lang`; the forgiving HTML parser used for real-world
 * EPUB markup does not use it for shaping or automatic hyphenation. Mirror it
 * to HTML's `lang` wherever the publisher did not already provide one.
 */
export function normalizeDocumentLanguages(doc: Document) {
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
    const language = element.getAttribute("xml:lang")?.trim();
    if (language && !element.hasAttribute("lang")) element.setAttribute("lang", language);
  }
}

/**
 * Refuse the SVG opt-out that stretches artwork to the viewport.
 *
 * EPUB cover pages commonly wrap a bitmap in an SVG sized to 100% by 100%.
 * `preserveAspectRatio="none"` then deforms that bitmap whenever the reader
 * and cover have different proportions. `meet` keeps the whole image visible
 * and centres any spare space. The same rule applies to nested SVG `<image>`
 * elements, where `none` would distort the bitmap inside an otherwise
 * correctly proportioned SVG.
 */
export function preserveImageAspectRatios(doc: Document) {
  doc.querySelectorAll("svg, image").forEach((el) => {
    if (el.getAttribute("preserveAspectRatio")?.trim().toLowerCase() === "none") {
      el.setAttribute("preserveAspectRatio", "xMidYMid meet");
    }
  });
}

/**
 * Mark visual elements and their image-only wrappers for the pagination
 * stylesheet. Applying the rule to the wrapper matters: EPUBs commonly put a
 * cover or illustration inside a viewport-wide `<div>` or an anchor with
 * `column-span:all`; constraining only the nested `<img>` leaves that outer box
 * spanning both pages of a spread.
 */
export function markMediaForPagination(doc: Document) {
  const media = Array.from(doc.querySelectorAll<HTMLElement>("img, svg, video, canvas"));
  for (const element of media) {
    element.setAttribute("data-bv-page-media", "");
    let parent = element.parentElement;
    for (let depth = 0; parent && parent !== doc.body && depth < 4; depth += 1) {
      const tag = parent.tagName.toLowerCase();
      const isFigure = tag === "figure" || tag === "picture";
      const isEmptyWrapper = parent.textContent?.trim() === "";
      if (!isFigure && !isEmptyWrapper) break;
      parent.setAttribute("data-bv-page-media-wrapper", "");
      if (isEmptyWrapper) parent.setAttribute("data-bv-empty-media-wrapper", "");
      parent = parent.parentElement;
    }
  }
}
