import { DOCUMENT_COMPAT_PASSES } from "./passes/document";
import { CompatReport } from "./types";
import { bridgeXhtmlToHtml } from "./xhtml-bridge";

export type PreparedChapterDocument = {
  document: Document;
  report: CompatReport;
};

/**
 * Prepare one sanitized EPUB content document for the browser reader.
 * Passes are deliberately ordered here so compatibility behavior cannot depend
 * on import order or on whichever helper a caller happened to remember.
 */
export function prepareChapterDocument(html: string): PreparedChapterDocument {
  const bridge = bridgeXhtmlToHtml(html);
  const document = new DOMParser().parseFromString(bridge.markup, "text/html");
  const changes = [...bridge.changes];

  for (const pass of DOCUMENT_COMPAT_PASSES) {
    const count = pass.apply(document);
    if (count > 0) changes.push({ id: pass.id, phase: pass.phase, count });
  }

  return {
    document,
    report: {
      changes,
      appliedPasses: changes.map((change) => change.id),
    },
  };
}
