import { prepareChapterDocument } from "../../../src/epub-compat/pipeline";
import { applyLayoutStyle, clearOffset, geometryFor, settle } from "../../../src/reader-layout";
import { DEFAULT_PREFS } from "../../../src/reader-prefs";
import selfClosing from "../fixtures-src/compat-regressions/EPUB/self-closing.xhtml?raw";
import prefixedSvg from "../fixtures-src/compat-regressions/EPUB/prefixed-svg.xhtml?raw";
import publisherImages from "../fixtures-src/compat-regressions/EPUB/publisher-images.xhtml?raw";
import linkedToc from "../fixtures-src/compat-regressions/EPUB/linked-toc.xhtml?raw";
import longTable from "../fixtures-src/compat-regressions/EPUB/long-table.xhtml?raw";

const fixtures: Record<string, string> = {
  "self-closing": selfClosing,
  "prefixed-svg": prefixedSvg,
  "publisher-images": publisherImages,
  "linked-toc": linkedToc,
  "long-table": longTable,
};

const params = new URLSearchParams(location.search);
const fixture = params.get("fixture") ?? "self-closing";
const width = positiveNumber(params.get("width"), 900);
const height = positiveNumber(params.get("height"), 700);
const size = positiveNumber(params.get("size"), DEFAULT_PREFS.size);
const html = fixtures[fixture];
if (!html) throw new Error(`Unknown EPUB fixture: ${fixture}`);

document.body.style.margin = "0";
const frame = document.createElement("iframe");
frame.id = "reader";
frame.title = `EPUB fixture: ${fixture}`;
frame.style.display = "block";
frame.style.width = `${width}px`;
frame.style.height = `${height}px`;
frame.style.border = "0";
document.querySelector("#harness")?.appendChild(frame);

const prepared = prepareChapterDocument(html);
frame.addEventListener("load", async () => {
  const doc = frame.contentDocument;
  if (!doc) throw new Error("Fixture frame has no document");
  const prefs = { ...DEFAULT_PREFS, size };
  const geometry = geometryFor(width, height, prefs);
  applyLayoutStyle(doc, geometry, prefs);
  clearOffset(doc);
  await settle(doc);
  applyLayoutStyle(doc, geometry, prefs);
  clearOffset(doc);
  doc.documentElement.dataset.compatPasses = prepared.report.appliedPasses.join(",");
  doc.documentElement.dataset.columns = String(geometry.cols);
  doc.documentElement.dataset.ready = "true";
});
frame.srcdoc = `<!doctype html>${prepared.document.documentElement.outerHTML}`;

function positiveNumber(value: string | null, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}
