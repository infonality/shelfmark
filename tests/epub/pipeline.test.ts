import { describe, expect, it } from "vitest";
import { prepareChapterDocument } from "../../src/epub-compat/pipeline";
import { buildDocument, internalTarget } from "../../src/reader-layout";
import { Chapter, ReaderSession } from "../../src/api";
import { chapterFixture } from "./fixture";

describe("EPUB compatibility pipeline", () => {
  it("keeps content after self-closing page markers visible and outside the marker", () => {
    const prepared = prepareChapterDocument(chapterFixture("self-closing.xhtml"));
    const marker = prepared.document.querySelector<HTMLElement>(`[role="doc-pagebreak"]`);
    const heading = prepared.document.querySelector<HTMLElement>("#after-marker");

    expect(marker).not.toBeNull();
    expect(marker?.childNodes).toHaveLength(0);
    expect(marker?.hasAttribute("data-bv-empty-pagebreak")).toBe(true);
    expect(marker?.contains(heading ?? null)).toBe(false);
    expect(prepared.document.body.textContent).toContain("This prose must remain outside");
    expect(prepared.report.appliedPasses).toEqual(
      expect.arrayContaining(["self-closing-html-elements", "language-attributes", "empty-pagebreak-markers"]),
    );
  });

  it("adopts prefixed SVG and preserves image aspect ratios", () => {
    const prepared = prepareChapterDocument(chapterFixture("prefixed-svg.xhtml"));
    const svg = prepared.document.querySelector("svg");
    const image = prepared.document.querySelector("svg image");

    expect(svg?.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(image?.getAttribute("preserveAspectRatio")).toBe("xMidYMid meet");
    expect(svg?.hasAttribute("data-bv-page-media")).toBe(true);
    expect(prepared.report.appliedPasses).toEqual(
      expect.arrayContaining(["foreign-namespace-prefixes", "image-aspect-ratio", "page-media-markers"]),
    );
  });

  it("preserves publisher image dimensions while marking figures and wrappers", () => {
    const prepared = prepareChapterDocument(chapterFixture("publisher-images.xhtml"));
    const imprint = prepared.document.querySelector<HTMLImageElement>("img.imprint");
    const publisherCss = prepared.document.querySelector("style")?.textContent ?? "";
    const figure = prepared.document.querySelector("figure");
    const linkedImage = prepared.document.querySelector<HTMLImageElement>("a.wide img");

    expect(publisherCss).toContain("width: 2em");
    expect(imprint?.getAttribute("style")).toBeNull();
    expect(imprint?.hasAttribute("data-bv-page-media")).toBe(true);
    expect(figure?.hasAttribute("data-bv-page-media-wrapper")).toBe(true);
    expect(linkedImage?.parentElement?.hasAttribute("data-bv-page-media-wrapper")).toBe(true);
  });

  it("does not mark a page-break element that contains chapter content as empty", () => {
    const html = `<html><body><span role="doc-pagebreak"><p>Do not hide me</p></span></body></html>`;
    const prepared = prepareChapterDocument(html);
    const marker = prepared.document.querySelector<HTMLElement>(`[role="doc-pagebreak"]`);
    expect(marker?.hasAttribute("data-bv-empty-pagebreak")).toBe(false);
    expect(marker?.textContent).toContain("Do not hide me");
  });

  it("preserves linked contents and resolves same- and cross-chapter targets", () => {
    const chapter: Chapter = {
      index: 3,
      html: chapterFixture("linked-toc.xhtml"),
      dir: "EPUB",
      chars: 100,
    };
    const session = sessionFixture();
    const output = buildDocument(chapter, session.resource_base);
    const doc = new DOMParser().parseFromString(output, "text/html");
    const same = doc.querySelector<HTMLAnchorElement>("#same-chapter");
    const other = doc.querySelector<HTMLAnchorElement>("#other-chapter");

    expect(same?.getAttribute("href")).toBe("#target");
    expect(other?.getAttribute("href")).toBe("self-closing.xhtml#after-marker");
    expect(internalTarget(session, chapter, "#target", same?.href ?? "")).toEqual({
      spine: 3,
      fragment: "target",
    });
    expect(internalTarget(session, chapter, other?.getAttribute("href") ?? "", other?.href ?? "")).toEqual({
      spine: 0,
      fragment: "after-marker",
    });
  });

  it("retains every table row and the publisher's cell content", () => {
    const prepared = prepareChapterDocument(chapterFixture("long-table.xhtml"));
    expect(prepared.document.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(prepared.document.body.textContent).toContain("averylongunbrokenvalue");
  });
});

function sessionFixture(): ReaderSession {
  const paths = [
    "EPUB/self-closing.xhtml",
    "EPUB/prefixed-svg.xhtml",
    "EPUB/publisher-images.xhtml",
    "EPUB/linked-toc.xhtml",
    "EPUB/long-table.xhtml",
  ];
  return {
    spine: paths.map((path, index) => ({ index, path, chars: 100 })),
    toc: [],
    total_chars: 500,
    resource_base: "http://bookres.localhost/1/",
    locator: null,
    title: "Compatibility fixture",
  };
}
