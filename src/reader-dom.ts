/**
 * Text anchoring inside the reader frame.
 *
 * Highlights and search results are located by character offsets into the
 * chapter's *rendered* text — the concatenation of its text nodes. That anchor
 * is stable across a font change, a resize, or a switch to two columns, none of
 * which alter the text itself. It deliberately does not use the tag-stripped
 * text the Rust side counts for progress: that inserts whitespace between
 * elements, so its offsets would drift from the DOM's.
 *
 * The frame runs without script permission, so everything here is executed by
 * the parent through its same-origin handle on the document.
 */

/** Every text node in document order, skipping ones we inject ourselves. */
function textNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      if (el.closest("script, style, [data-bv-skip]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

/** Full rendered text of the chapter, matching the offsets used for anchors. */
export function chapterText(doc: Document): string {
  return textNodes(doc)
    .map((n) => n.data)
    .join("");
}

/** Turn a character range into a DOM Range, or null if it's out of bounds. */
export function rangeForOffsets(doc: Document, start: number, end: number): Range | null {
  if (end <= start) return null;
  const nodes = textNodes(doc);
  let seen = 0;
  let range: Range | null = null;
  for (const node of nodes) {
    const len = node.data.length;
    if (!range && seen + len > start) {
      range = doc.createRange();
      range.setStart(node, Math.max(0, start - seen));
    }
    if (range && seen + len >= end) {
      range.setEnd(node, Math.max(0, end - seen));
      return range;
    }
    seen += len;
  }
  // Ran past the end of the chapter — clamp to the last node we saw.
  if (range && nodes.length) {
    const last = nodes[nodes.length - 1];
    range.setEnd(last, last.data.length);
    return range;
  }
  return null;
}

/** Character offsets of the current selection, or null when nothing is selected. */
export function offsetsForSelection(doc: Document): { start: number; end: number; text: string } | null {
  const sel = doc.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString();
  if (!text.trim()) return null;

  const nodes = textNodes(doc);
  let seen = 0;
  let start = -1;
  let end = -1;
  for (const node of nodes) {
    if (node === range.startContainer) start = seen + range.startOffset;
    if (node === range.endContainer) end = seen + range.endOffset;
    seen += node.data.length;
  }
  // Selections that begin or end on an element rather than a text node.
  if (start < 0 || end < 0) {
    const idx = chapterText(doc).indexOf(text);
    if (idx < 0) return null;
    return { start: idx, end: idx + text.length, text };
  }
  return start < end ? { start, end, text } : null;
}

/** Offsets of the nth case-insensitive occurrence of `needle`. */
export function offsetsForOccurrence(
  doc: Document,
  needle: string,
  occurrence: number
): { start: number; end: number } | null {
  if (!needle) return null;
  const hay = chapterText(doc).toLowerCase();
  const q = needle.toLowerCase();
  let from = 0;
  for (let i = 0; i <= occurrence; i++) {
    const at = hay.indexOf(q, from);
    if (at < 0) return null;
    if (i === occurrence) return { start: at, end: at + q.length };
    from = at + q.length;
  }
  return null;
}

/**
 * Which page a box falls on, given the width of one page.
 *
 * Callers must have put the document back at offset zero first (see
 * `clearOffset` in reader-layout), so a client rect is already a document-space
 * position and no scroll or translation has to be added back.
 *
 * The tolerance matters: a column boundary computed in fractional pixels can
 * report an x of `2 * pageWidth - 0.4` for something that is really the first
 * word of page two, and a bare floor would send the reader back a page.
 */
function pageAt(rect: DOMRect, pageWidth: number): number {
  if (pageWidth < 1) return 0;
  return Math.max(0, Math.floor((rect.left + 1) / pageWidth));
}

/** Which page a range falls on, given the width of one page. */
export function pageForRange(range: Range, pageWidth: number): number {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return 0;
  return pageAt(rect, pageWidth);
}

/**
 * Which page an element falls on. Targets of a table-of-contents fragment are
 * often empty anchors — `<a id="ch3"/>` — which have no box of their own, so
 * fall back to a range around the element and then to whatever renders next.
 */
export function pageForElement(doc: Document, el: Element, pageWidth: number): number {
  const usable = (r: DOMRect) => r.width > 0 || r.height > 0;

  let rect = el.getBoundingClientRect();
  if (!usable(rect)) {
    try {
      const range = doc.createRange();
      range.selectNode(el);
      rect = range.getBoundingClientRect();
    } catch {
      /* selectNode throws on a node with no parent */
    }
  }
  if (!usable(rect)) {
    const near = el.nextElementSibling ?? el.parentElement;
    if (near) rect = near.getBoundingClientRect();
  }
  return usable(rect) ? pageAt(rect, pageWidth) : 0;
}

/**
 * The element a `#fragment` points at. `getElementById` covers ids whatever
 * characters they contain; the `name` fallback is for EPUB 2 files that still
 * anchor with `<a name="...">`.
 */
export function elementForFragment(doc: Document, id: string): Element | null {
  const byId = doc.getElementById(id);
  if (byId) return byId;
  try {
    const escape = (window as unknown as { CSS?: { escape(s: string): string } }).CSS?.escape;
    return doc.querySelector(`[name="${escape ? escape(id) : id}"]`);
  } catch {
    return null;
  }
}

/**
 * Whether an internal link is being used as a note reference.
 *
 * EPUB 3 gives us `epub:type="noteref"` and DPUB-ARIA gives us
 * `role="doc-noteref"`, but many EPUB 2 books only use a superscript number
 * or a conventional `fn`/`note` identifier. The conservative fallbacks below
 * cover those books without turning ordinary chapter links into note jumps.
 */
export function isNoteReference(anchor: HTMLAnchorElement, doc: Document): boolean {
  if (hasToken(anchor, "epub:type", "noteref") || hasToken(anchor, "role", "doc-noteref")) {
    return true;
  }

  const href = anchor.getAttribute("href")?.trim() ?? "";
  if (!href.startsWith("#") || href.length < 2) return false;

  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* A malformed fragment can still be inspected as written. */
  }

  for (let element = elementForFragment(doc, id); element; element = element.parentElement) {
    if (
      ["footnote", "endnote", "rearnote"].some((token) => hasToken(element, "epub:type", token)) ||
      ["doc-footnote", "doc-endnote"].some((token) => hasToken(element, "role", token))
    ) {
      return true;
    }
    if (element === doc.body) break;
  }

  const label = anchor.textContent?.trim() ?? "";
  if (anchor.closest("sup") && /^(?:\d{1,3}|[a-z]|[*†‡]+)$/i.test(label)) return true;

  const hint = `${id} ${anchor.id} ${anchor.className}`.toLowerCase();
  return /(?:^|[-_])(fn|footnote|endnote|note)(?:[-_\d]|$)/.test(hint) && label.length <= 6;
}

function hasToken(element: Element, attribute: string, wanted: string): boolean {
  return (element.getAttribute(attribute) ?? "")
    .trim()
    .split(/\s+/)
    .includes(wanted);
}

export const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: "rgba(255, 214, 0, .38)",
  green: "rgba(52, 211, 153, .34)",
  blue: "rgba(96, 165, 250, .34)",
  pink: "rgba(244, 114, 182, .34)",
};

/** Remove every mark this module previously drew. */
export function clearMarks(doc: Document, attr: string) {
  doc.querySelectorAll(`[${attr}]`).forEach((el) => {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
    parent.normalize();
  });
}

/**
 * Wrap a range in `<mark>` elements. A range can span several text nodes and
 * cross element boundaries, so `surroundContents` won't do — each intersecting
 * node gets its own mark instead.
 */
export function markRange(
  doc: Document,
  range: Range,
  attr: string,
  value: string,
  background: string
) {
  const nodes: Text[] = [];
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    if (range.intersectsNode(t)) nodes.push(t);
  }

  for (const node of nodes) {
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : node.data.length;
    if (to <= from) continue;

    const target = node.splitText(from);
    if (to - from < target.data.length) target.splitText(to - from);

    const mark = doc.createElement("mark");
    mark.setAttribute(attr, value);
    mark.style.background = background;
    mark.style.color = "inherit";
    mark.style.borderRadius = "2px";
    target.parentNode?.replaceChild(mark, target);
    mark.appendChild(target);
  }
}
