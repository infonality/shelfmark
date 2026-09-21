import { describe, expect, it } from "vitest";
import { isNoteReference } from "../../src/reader-dom";

describe("EPUB note links", () => {
  it.each([
    `<a href="#n1" epub:type="noteref">1</a><aside id="n1">Note</aside>`,
    `<a href="#n1" role="doc-noteref">1</a><aside id="n1">Note</aside>`,
    `<sup><a href="#fn-1">1</a></sup><p id="fn-1">Note</p>`,
    `<a href="#n1">1</a><aside id="n1" epub:type="footnote">Note</aside>`,
  ])("recognizes semantic and common legacy note references", (body) => {
    const doc = new DOMParser().parseFromString(`<html><body>${body}</body></html>`, "text/html");
    expect(isNoteReference(doc.querySelector("a") as HTMLAnchorElement, doc)).toBe(true);
  });

  it("leaves an ordinary internal chapter link alone", () => {
    const doc = new DOMParser().parseFromString(
      `<html><body><a href="#chapter-two">Next chapter</a><h2 id="chapter-two">Chapter two</h2></body></html>`,
      "text/html",
    );
    expect(isNoteReference(doc.querySelector("a") as HTMLAnchorElement, doc)).toBe(false);
  });
});
