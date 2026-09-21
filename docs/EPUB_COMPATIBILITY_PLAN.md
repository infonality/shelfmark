# EPUB compatibility layer

Status: implementation plan. This document does not change reader behavior.

## Goal

Render conforming EPUB 2 and EPUB 3 publications as their creators intended,
repair common defects without changing sound content, and guarantee a readable
fallback when publisher markup or CSS cannot be paginated safely.

The layer must keep these concerns distinct:

1. **Security** decides what untrusted book content is allowed to do.
2. **Compatibility** translates EPUB/XHTML conventions into a form the host
   browser can render without losing meaning.
3. **Reader policy** applies user choices and non-negotiable accessibility
   rules.
4. **Pagination** measures the prepared document and turns it into pages.

Today these responsibilities are split between `src-tauri/src/reader.rs`,
`src/reader-layout.ts`, and `src/pages/Reader.tsx`, with several compatibility
repairs embedded directly in the layout module. The first implementation step
is to introduce the boundary without changing output.

## Standards baseline

Shelfmark should target:

- EPUB 2 publications encountered in existing libraries.
- EPUB 3.3 publications and the EPUB Reading Systems 3.3 processing model.
- XHTML content, SVG content, CSS, embedded OpenType/TrueType/WOFF fonts,
  package reading order, navigation documents, fallbacks, language, direction,
  and reflowable versus fixed-layout metadata.

Creator CSS remains authoritative by default. Shelfmark adds or overrides rules
only for security, a user setting, accessibility, or a measured failure to fit
the active reading mode. EPUBCheck diagnoses publication conformance; it is an
input to compatibility testing, not a renderer and not a reason to reject a
book that can be shown safely.

References:

- <https://www.w3.org/TR/epub-33/>
- <https://www.w3.org/TR/epub-rs-33/>
- <https://www.w3.org/publishing/epubcheck/>

## Proposed pipeline

```text
EPUB archive
  -> package profile and spine (Rust)
  -> resource confinement and security sanitization (Rust)
  -> XHTML-to-HTML bridge (TypeScript)
  -> ordered compatibility passes (TypeScript)
  -> publisher styles
  -> reader policy and pagination styles
  -> asset settling and layout
  -> post-render invariants
  -> normal view or readable safe mode
```

### 1. Publication profile

Extend the backend session model with facts needed before a chapter is laid
out. Do not infer these repeatedly from rendered DOM.

```ts
type PublicationProfile = {
  epubVersion: "2" | "3" | "unknown";
  layout: "reflowable" | "pre-paginated";
  pageProgression: "ltr" | "rtl" | "default";
};

type SpineProfile = {
  path: string;
  linear: boolean;
  properties: string[];
  fallbackPath: string | null;
};
```

The Rust package reader owns this stage because it already parses the OPF,
manifest, and spine. It should also resolve declared fallback chains and expose
which resource was selected. Fixed-layout documents must take a dedicated
viewport-scaling path; forcing them through reflow pagination will always
damage some books.

### 2. Security sanitization

Keep this in Rust, before markup reaches a webview:

- Strip scripts, event attributes, executable embeds, and `javascript:` URLs.
- Confine resource paths to entries in the open archive.
- Block file URLs, forms, frames, external objects, and top-level navigation.
- Retain the chapter CSP as a second independent control.

Security transformations must not also make visual-layout decisions. Each
security rule needs a focused Rust test using hostile input.

### 3. XHTML-to-HTML bridge

Create `src/epub-compat/xhtml-bridge.ts` for transformations required because
the iframe `srcdoc` is parsed as HTML rather than XML:

- Expand self-closing non-void HTML elements.
- Adopt bound SVG and MathML prefixes without changing foreign elements.
- Preserve IDs, namespaced semantic attributes, fragments, and internal links.
- Mirror `xml:lang` to `lang` and retain base direction.
- Report XML/HTML recovery decisions instead of making them silently.

This stage is deterministic and must not inspect window size or user settings.
The *AI Snake Oil* regression belongs here.

### 4. Ordered compatibility passes

Create `src/epub-compat/pipeline.ts` and small passes under
`src/epub-compat/passes/`. A pass has an ID, a reason, and a report entry.

```ts
type CompatPass = {
  id: string;
  phase: "structure" | "semantics" | "media";
  apply(document: Document, context: CompatContext): CompatChange[];
};
```

Initial passes move existing behavior without changing it:

- `language-attributes`
- `image-aspect-ratio`
- `page-media-markers`
- `empty-pagebreak-markers`

Later passes may address known producer defects, but only when a minimal fixture
demonstrates the problem. Do not add publisher-name checks or broad CSS
rewrites. Pass ordering is explicit and tested so one repair cannot quietly
depend on incidental source order.

### 5. Style ownership

Split injected CSS into three named outputs:

1. **Defaults:** ordinary book typography, inserted before creator CSS and easy
   for the publication to override.
2. **Reader policy:** font, size, spacing, theme, language, and accessibility
   choices explicitly selected by the user.
3. **Pagination constraints:** the minimum rules needed to form stable columns,
   keep media within one page, and prevent horizontal escape.

Use `!important` only in pagination constraints or for an explicit user
preference that must override creator CSS. Every such declaration should state
the failure it prevents. Table, media, link, and typography rules need separate
modules instead of one generated template string.

### 6. Layout and post-render invariants

Keep geometry and page movement in `reader-layout`, but make it consume a
prepared document. After fonts and media settle, collect a render report:

```ts
type ChapterRenderReport = {
  sourceCharacters: number;
  renderedCharacters: number;
  media: { total: number; loaded: number; failed: number };
  pageCount: number;
  hiddenContentWarnings: string[];
  overflowWarnings: string[];
  appliedPasses: string[];
};
```

The following are release-blocking fixture failures and runtime warning signs:

- A text-bearing chapter renders no visible text and no visible media.
- A page-break marker or hidden wrapper contains substantial chapter content.
- Page count is zero, non-finite, or changes continuously after assets settle.
- A media element's rendered aspect ratio differs from its intrinsic ratio
  without an explicit, supported crop mode.
- Content is positioned wholly outside every page or crosses the spine gutter.
- An internal table-of-contents target cannot resolve to a spine item and
  fragment that exist.

Runtime checks must be bounded and cheap. They should produce local diagnostic
information and never add telemetry.

### 7. Safe mode

If a chapter fails the blank-content or catastrophic-overflow invariants,
Shelfmark should retry once in safe mode:

- Keep semantic markup, images, tables, headings, lists, and internal links.
- Disable creator layout CSS while retaining embedded resources.
- Apply a simple reflow stylesheet with aspect-safe media and row-breaking
  tables.
- Preserve the same locator and chapter identity.
- Show a quiet reader notice that the chapter was repaired, with an option to
  retry publisher styling.

Safe mode is a last-resort readability guarantee. It must not activate merely
because a book has unusual colors, spacing, or typography.

## Test architecture

### Generated fixture EPUBs

Add `tests/epub/fixtures-src/` containing small, reviewable publications and a
generator that packages them. Each historical defect gets the smallest EPUB
that reproduces it:

- self-closing HTML elements followed by normal prose
- prefixed and unprefixed SVG covers
- fixed-layout cover and reflowable chapter in one publication
- publisher-sized inline and block images
- float, figure, picture, and linked-image wrappers
- multi-page tables and long unbroken cell content
- embedded and IDPF-obfuscated fonts
- `xml:lang`, RTL direction, vertical-writing metadata, and mixed scripts
- EPUB 2 NCX and EPUB 3 navigation targets
- missing resources, malformed CSS, and broken fallback chains

Run EPUBCheck over fixtures expected to conform. Keep deliberately broken
fixtures in a clearly named recovery suite and assert the exact warning or
repair Shelfmark applies.

### Unit tests

Use a DOM-capable TypeScript test environment for the XHTML bridge and every
compatibility pass. Tests compare semantic DOM and reports rather than complete
serialized HTML, which is sensitive to harmless attribute ordering.

Rust tests continue to cover package parsing, resource confinement,
sanitization, font decoding, navigation, and fallbacks.

### Render tests

Add a browser harness that loads every generated fixture through the same
`prepareChapter -> applyLayout -> settle` path as the app. Run Chromium and
WebKit at:

- narrow one-page and wide two-page viewports
- minimum, default, and maximum reader font sizes
- publisher, paper, and night themes
- first, middle, and final spine items

Assert structural invariants and page counts within declared ranges. Maintain a
small set of screenshot comparisons for covers, figures, tables, RTL text, and
two-page gutters; avoid pixel snapshots for ordinary prose and platform fonts.

### Local regression corpus

Keep copyrighted books outside Git. A local corpus manifest records only a
content hash, the chapter to open, expected invariant ranges, and the issue it
guards. The current corpus should include the books that exposed the major
reader failures:

- *AI Snake Oil*
- *The Silmarillion Illustrated by the Author*
- *The Model Thinker*
- *Co-Intelligence*

The generated fixtures remain the authoritative CI tests; the local corpus is
an additional pre-release compatibility sweep.

## Delivery phases

### Phase 1 — Boundary and regression gate

- Add the TypeScript test runner and DOM environment.
- Extract current repairs into the XHTML bridge and named passes without
  changing generated markup.
- Add synthetic fixtures for every resolved Shelfmark EPUB issue.
- Add `npm run test:epub` and run it before packaging in the release workflow.

Exit criteria: current books render identically, historical regressions fail
when their repair is removed, and a release cannot package if they fail.

### Phase 2 — Publication profiles

- Expose EPUB version, layout mode, page progression, spine properties, and
  fallbacks from Rust.
- Separate fixed-layout viewport scaling from reflow pagination.
- Add EPUB 2/3 navigation and RTL fixtures.

Exit criteria: fixed-layout books are never forced into reflow, and reading
direction comes from publication metadata unless the user overrides it.

### Phase 3 — Diagnostics and safe mode

- Produce compatibility and render reports per chapter.
- Add blank-content and catastrophic-overflow detection.
- Retry a failed chapter once with safe-mode styling.
- Provide a local diagnostic export suitable for a bug report.

Exit criteria: a malformed chapter may lose publisher styling, but it cannot
silently become an empty sequence of pages.

### Phase 4 — Broader conformance

- Import applicable public W3C/EPUBCheck test publications or recreate minimal
  fixtures under compatible licenses.
- Add MathML, vertical writing, media fallback, and accessibility cases.
- Run browser render tests on Windows and macOS CI in addition to the fast
  cross-engine harness.

Exit criteria: the supported feature matrix is documented, tested, and linked
to either a specification requirement or an explicit Shelfmark limitation.

## First implementation slice

Phase 1 should be the next reader change. It provides the largest risk
reduction without changing book presentation:

1. Install a lightweight TypeScript test runner with a DOM environment.
2. Move `unprefixForeignMarkup`, `closeSelfClosingHtmlElements`,
   `normalizeDocumentLanguages`, `preserveImageAspectRatios`, and
   `markMediaForPagination` into `src/epub-compat/`.
3. Add minimal fixtures for blank page-break chapters, prefixed SVG covers,
   aspect-ratio preservation, publisher-sized images, linked TOCs, and long
   tables.
4. Test one- and two-column layout at the supported font-size extremes.
5. Add the EPUB test command to a pre-package CI job required by every release.

No additional rendering repair should merge before this slice is in place;
otherwise the compatibility layer will begin with the same untested coupling it
is intended to remove.
