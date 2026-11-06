import { describe, expect, it } from "vitest";
import { remapScrollOffset, stackLayout } from "../src/pdf-layout";

describe("PDF scroll position through display changes", () => {
  const pages = Array.from({ length: 12 }, () => ({ w: 600, h: 800 }));

  it("keeps the place within a page when width and pixel density change", () => {
    const before = stackLayout(pages, 1200, 16, 1);
    const after = stackLayout(pages, 750, 16, 2);
    const oldTop = before.tops[7] + before.heights[7] * 0.6;
    const mapped = remapScrollOffset(before, after, oldTop);
    expect(mapped.page).toBe(7);
    expect(mapped.top).toBeCloseTo(after.tops[7] + after.heights[7] * 0.6);
  });

  it("does not drift to a page top across successive display changes", () => {
    const wide = stackLayout(pages, 1400, 16, 1);
    const narrow = stackLayout(pages, 750, 16, 2);
    const wideAgain = stackLayout(pages, 1400, 16, 1);
    const start = wide.tops[10] + wide.heights[10] * 0.4;
    const moved = remapScrollOffset(wide, narrow, start);
    const returned = remapScrollOffset(narrow, wideAgain, moved.top);
    expect(returned.page).toBe(10);
    expect(returned.top).toBeCloseTo(start);
  });
});
