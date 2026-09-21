import { expect, test, type Page } from "@playwright/test";

async function openFixture(
  page: Page,
  fixture: string,
  options: { width?: number; height?: number; size?: number } = {},
) {
  const query = new URLSearchParams({
    fixture,
    width: String(options.width ?? 900),
    height: String(options.height ?? 700),
    size: String(options.size ?? 19),
  });
  await page.goto(`/tests/epub/browser/harness.html?${query}`);
  const frame = page.frameLocator("#reader");
  await expect(frame.locator("html")).toHaveAttribute("data-ready", "true");
  return frame;
}

test("self-closing page marker cannot swallow visible chapter content", async ({ page }) => {
  const frame = await openFixture(page, "self-closing");
  const marker = frame.locator(`[role="doc-pagebreak"]`);
  const heading = frame.locator("#after-marker");

  await expect(marker).toHaveAttribute("data-bv-empty-pagebreak", "");
  await expect(marker).toBeHidden();
  await expect(heading).toBeVisible();
  await expect(frame.locator("body")).toContainText("This prose must remain outside");
  expect(await marker.locator("#after-marker").count()).toBe(0);
});

test("prefixed SVG cover is adopted and aspect-safe", async ({ page }) => {
  const frame = await openFixture(page, "prefixed-svg", { width: 480, height: 640 });
  const svg = frame.locator("svg#cover");
  const image = frame.locator("svg#cover image");

  await expect(svg).toBeVisible();
  await expect(svg).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
  await expect(image).toHaveAttribute("preserveAspectRatio", "xMidYMid meet");
  const box = await svg.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);
  expect(box.width).toBeLessThanOrEqual(480);
  expect(box.height).toBeLessThanOrEqual(640);
});

test("publisher-sized images stay small and linked wrappers stay intact", async ({ page }) => {
  const frame = await openFixture(page, "publisher-images");
  const imprint = frame.locator("img.imprint");
  const linked = frame.locator("a.wide img");

  const imprintBox = await imprint.evaluate((element) => element.getBoundingClientRect().toJSON());
  expect(imprintBox.width).toBeGreaterThan(20);
  expect(imprintBox.width).toBeLessThan(100);
  expect(imprintBox.height).toBeGreaterThan(imprintBox.width);
  await expect(linked).toHaveAttribute("data-bv-page-media", "");
  await expect(frame.locator("a.wide")).toHaveAttribute("data-bv-page-media-wrapper", "");
});

test("long tables paginate without horizontal overflow and retain all rows", async ({ page }) => {
  const frame = await openFixture(page, "long-table", { width: 900, height: 700, size: 32 });
  const table = frame.locator("table");
  await expect(table.locator("tbody tr")).toHaveCount(4);
  const layout = await table.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll("tr"));
    const cell = element.querySelector("td");
    return {
      widestFragment: Math.max(
        ...rows.flatMap((row) => Array.from(row.getClientRects(), (rect) => rect.width)),
      ),
      body: element.ownerDocument.body.clientWidth,
      cellWrap: cell ? getComputedStyle(cell).overflowWrap : "",
    };
  });
  // WebKit may fragment a row despite the reader's break-inside hint. Its
  // union bounding box then spans multiple columns, so inspect the rendered
  // fragments: none may escape the width of one reader page.
  expect(layout.widestFragment).toBeLessThanOrEqual(layout.body);
  expect(layout.cellWrap).toBe("anywhere");
});

for (const scenario of [
  { label: "narrow minimum type", width: 480, height: 640, size: 12, columns: "1" },
  { label: "default reader", width: 1100, height: 820, size: 19, columns: "1" },
  { label: "wide maximum type", width: 1500, height: 900, size: 32, columns: "2" },
]) {
  test(`${scenario.label} produces stable pagination geometry`, async ({ page }) => {
    const frame = await openFixture(page, "long-table", scenario);
    await expect(frame.locator("html")).toHaveAttribute("data-columns", scenario.columns);
    const metrics = await frame.locator("body").evaluate((body) => ({
      clientWidth: body.clientWidth,
      scrollWidth: body.scrollWidth,
      scrollHeight: body.scrollHeight,
      text: body.textContent?.trim().length ?? 0,
    }));
    expect(metrics.clientWidth).toBeGreaterThan(0);
    expect(metrics.scrollWidth).toBeGreaterThanOrEqual(metrics.clientWidth);
    expect(metrics.scrollHeight).toBeGreaterThan(0);
    expect(metrics.text).toBeGreaterThan(100);
  });
}
