import { CompatPass } from "../types";

/** Mirror XHTML `xml:lang` to HTML `lang` without overriding creator markup. */
export function normalizeDocumentLanguages(doc: Document): number {
  let changed = 0;
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
    const language = element.getAttribute("xml:lang")?.trim();
    if (language && !element.hasAttribute("lang")) {
      element.setAttribute("lang", language);
      changed += 1;
    }
  }
  return changed;
}

/** Keep SVG covers and nested images from opting into geometric distortion. */
export function preserveImageAspectRatios(doc: Document): number {
  let changed = 0;
  doc.querySelectorAll("svg, image").forEach((element) => {
    if (element.getAttribute("preserveAspectRatio")?.trim().toLowerCase() === "none") {
      element.setAttribute("preserveAspectRatio", "xMidYMid meet");
      changed += 1;
    }
  });
  return changed;
}

/** Mark media and image-only wrappers for the pagination stylesheet. */
export function markMediaForPagination(doc: Document): number {
  let changed = 0;
  const media = Array.from(doc.querySelectorAll<HTMLElement>("img, svg, video, canvas"));
  for (const element of media) {
    element.setAttribute("data-bv-page-media", "");
    changed += 1;
    let parent = element.parentElement;
    for (let depth = 0; parent && parent !== doc.body && depth < 4; depth += 1) {
      const tag = parent.tagName.toLowerCase();
      const isFigure = tag === "figure" || tag === "picture";
      const isEmptyWrapper = parent.textContent?.trim() === "";
      if (!isFigure && !isEmptyWrapper) break;
      parent.setAttribute("data-bv-page-media-wrapper", "");
      if (isEmptyWrapper) parent.setAttribute("data-bv-empty-media-wrapper", "");
      changed += 1;
      parent = parent.parentElement;
    }
  }
  return changed;
}

/** Mark only truly empty print-page markers; never hide their descendants. */
export function markEmptyPagebreaks(doc: Document): number {
  let changed = 0;
  for (const element of Array.from(doc.querySelectorAll<HTMLElement>("*"))) {
    const epubType = tokens(element.getAttribute("epub:type"));
    const role = tokens(element.getAttribute("role"));
    const pagebreak = epubType.includes("pagebreak") || role.includes("doc-pagebreak");
    if (pagebreak && element.matches(":empty")) {
      element.setAttribute("data-bv-empty-pagebreak", "");
      changed += 1;
    }
  }
  return changed;
}

function tokens(value: string | null): string[] {
  return (value ?? "").trim().split(/\s+/).filter(Boolean);
}

export const DOCUMENT_COMPAT_PASSES: CompatPass[] = [
  { id: "language-attributes", phase: "semantics", apply: normalizeDocumentLanguages },
  { id: "image-aspect-ratio", phase: "media", apply: preserveImageAspectRatios },
  { id: "page-media-markers", phase: "media", apply: markMediaForPagination },
  { id: "empty-pagebreak-markers", phase: "semantics", apply: markEmptyPagebreaks },
];
