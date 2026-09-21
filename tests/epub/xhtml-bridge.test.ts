import { describe, expect, it } from "vitest";
import {
  bridgeXhtmlToHtml,
  closeSelfClosingHtmlElements,
  unprefixForeignMarkup,
} from "../../src/epub-compat/xhtml-bridge";
import { chapterFixture } from "./fixture";

describe("EPUB XHTML-to-HTML bridge", () => {
  it("closes non-void HTML elements without changing void or foreign elements", () => {
    const input = `<span role="doc-pagebreak"/><a id="target"/><td/><img src="x"/><path d="M0 0"/>`;
    expect(closeSelfClosingHtmlElements(input)).toBe(
      `<span role="doc-pagebreak"></span><a id="target"></a><td></td><img src="x"/><path d="M0 0"/>`,
    );
  });

  it("handles greater-than characters inside quoted attributes", () => {
    expect(closeSelfClosingHtmlElements(`<span title="1 > 0"/>after`)).toBe(
      `<span title="1 > 0"></span>after`,
    );
  });

  it("unprefixes only prefixes bound to SVG or MathML", () => {
    const markup = `<html xmlns:s="http://www.w3.org/2000/svg" xmlns:x="urn:example"><s:svg><s:path/></s:svg><x:item/></html>`;
    const output = unprefixForeignMarkup(markup);
    expect(output).toContain("<svg><path/></svg>");
    expect(output).toContain("<x:item/>");
  });

  it("reports the repairs used by the historical blank-chapter fixture", () => {
    const result = bridgeXhtmlToHtml(chapterFixture("self-closing.xhtml"));
    expect(result.markup).toContain(`<span role="doc-pagebreak" aria-label="1"></span>`);
    expect(result.markup).toContain(`<a id="empty-anchor"></a>`);
    expect(result.changes.map((change) => change.id)).toContain("self-closing-html-elements");
  });
});
