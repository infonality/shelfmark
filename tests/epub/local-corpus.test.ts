import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, posix } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { prepareChapterDocument } from "../../src/epub-compat/pipeline";
import corpus from "./local-corpus.json";

const corpusRoot = process.env.SHELFMARK_EPUB_CORPUS_ROOT;
const localDescribe = corpusRoot ? describe : describe.skip;

localDescribe("local copyrighted EPUB regression corpus", () => {
  it.each(corpus)("renders every spine document in $match", async (entry) => {
    const path = findByName(corpusRoot as string, entry.match);
    expect(path, `No EPUB matching ${entry.match} below ${corpusRoot}`).not.toBeNull();
    const bytes = readFileSync(path as string);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(entry.sha256);

    const zip = await JSZip.loadAsync(bytes);
    const container = await requiredText(zip, "META-INF/container.xml");
    const containerDoc = new DOMParser().parseFromString(container, "application/xml");
    const opfPath = containerDoc.getElementsByTagNameNS("*", "rootfile")[0]?.getAttribute("full-path");
    expect(opfPath).toBeTruthy();
    const opf = new DOMParser().parseFromString(
      await requiredText(zip, opfPath as string),
      "application/xml",
    );
    const opfDir = posix.dirname(opfPath as string);
    const manifest = new Map<string, { href: string; mediaType: string }>();
    for (const item of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (id && href) {
        manifest.set(id, { href, mediaType: item.getAttribute("media-type") ?? "" });
      }
    }

    let tested = 0;
    for (const itemref of Array.from(opf.getElementsByTagNameNS("*", "itemref"))) {
      const item = manifest.get(itemref.getAttribute("idref") ?? "");
      if (!item || !isContentDocument(item)) continue;
      const chapterPath = archivePath(opfDir, item.href);
      const html = await requiredText(zip, chapterPath);
      const prepared = prepareChapterDocument(html);
      const sourceCharacters = roughText(html).length;
      const renderedCharacters = compact(prepared.document.body.textContent ?? "").length;
      const media = prepared.document.querySelectorAll("img, svg, video, canvas").length;

      if (sourceCharacters >= 80) {
        expect(
          renderedCharacters + media,
          `${basename(path as string)}:${chapterPath} became empty (${entry.guards})`,
        ).toBeGreaterThan(20);
      }

      for (const marker of pagebreakMarkers(prepared.document)) {
        if (marker.hasAttribute("data-bv-empty-pagebreak")) {
          expect(marker.childNodes, `${chapterPath} marked a non-empty pagebreak as empty`).toHaveLength(0);
        }
        expect(
          compact(marker.textContent ?? "").length,
          `${chapterPath} has substantial prose trapped inside a pagebreak marker`,
        ).toBeLessThan(80);
      }
      tested += 1;
    }
    expect(tested).toBeGreaterThan(0);
  });
});

function findByName(root: string, needle: string): string | null {
  const want = needle.toLowerCase();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findByName(path, needle);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name.toLowerCase().includes(want) && entry.name.endsWith(".epub")) {
      return path;
    }
  }
  return null;
}
async function requiredText(zip: JSZip, path: string): Promise<string> {
  const file = zip.file(path);
  if (!file) throw new Error(`Missing EPUB entry: ${path}`);
  return file.async("string");
}

function isContentDocument(item: { href: string; mediaType: string }): boolean {
  const href = item.href.toLowerCase();
  return item.mediaType.includes("xhtml") || /\.x?html?$/.test(href);
}

function archivePath(base: string, href: string): string {
  const raw = href.split("#", 1)[0];
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Broken percent encoding is common; JSZip may still contain the raw name.
  }
  return posix.normalize(base === "." ? decoded : posix.join(base, decoded));
}

function roughText(html: string): string {
  return compact(
    html
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function pagebreakMarkers(doc: Document): HTMLElement[] {
  return Array.from(doc.querySelectorAll<HTMLElement>("*")).filter((element) => {
    const epub = (element.getAttribute("epub:type") ?? "").split(/\s+/);
    const role = (element.getAttribute("role") ?? "").split(/\s+/);
    return epub.includes("pagebreak") || role.includes("doc-pagebreak");
  });
}
