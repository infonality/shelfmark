import { describe, expect, it } from "vitest";
import { applyLayoutStyle, countPages, geometryFor } from "../../src/reader-layout";
import { DEFAULT_PREFS, ReaderPrefs } from "../../src/reader-prefs";
import { chapterFixture } from "./fixture";
import { prepareChapterDocument } from "../../src/epub-compat/pipeline";

describe("EPUB pagination policy", () => {
  it("uses one column below the spread threshold and two above it", () => {
    expect(geometryFor(900, 700, DEFAULT_PREFS)).toMatchObject({ cols: 1, w: 900, h: 700 });
    expect(geometryFor(1500, 900, DEFAULT_PREFS)).toMatchObject({ cols: 2, w: 1500, h: 900 });
  });

  it.each([
    ["minimum", 12, 480, 640, 1],
    ["default", 19, 1100, 820, 1],
    ["maximum spread", 32, 1500, 900, 2],
  ] as const)("emits stable %s-size layout constraints", (_label, size, width, height, columns) => {
    const prefs: ReaderPrefs = { ...DEFAULT_PREFS, size };
    const prepared = prepareChapterDocument(chapterFixture("long-table.xhtml"));
    const geometry = geometryFor(width, height, prefs);
    applyLayoutStyle(prepared.document, geometry, prefs);
    const css = prepared.document.querySelector<HTMLStyleElement>("#bv-layout")?.textContent ?? "";

    expect(geometry.cols).toBe(columns);
    expect(css).toContain(`font-size:${size}px !important`);
    expect(css).toContain(`column-count:${columns} !important`);
    expect(css).toContain("break-inside:auto !important");
    expect(css).toContain("overflow-wrap:anywhere");
    expect(css).toContain("object-fit:contain !important");
  });

  it("absorbs rounding slack without losing a real page", () => {
    expect(countPages(999.9, 1000)).toBe(1);
    expect(countPages(1001, 1000)).toBe(1);
    expect(countPages(1500, 1000)).toBe(2);
    expect(countPages(3000, 1000)).toBe(3);
  });
});
