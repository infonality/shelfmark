# Changelog

## 0.7.0 — 2026-09-21

Shelfmark 0.7 adds a tested EPUB compatibility boundary around the reader and
makes footnote navigation reversible without disturbing the book's layout.

### EPUB compatibility gate

- Show a floating return button after following a footnote or endnote link so
  the reader can return to the page where the note was opened.
- Move XHTML repairs and document normalization into an ordered, named EPUB
  compatibility pipeline that reports which repairs a chapter needed.
- Add a generated EPUB fixture for self-closing markup, prefixed SVG covers,
  publisher-sized images, linked contents, and long tables.
- Render the fixtures in Chromium and WebKit across narrow, default, and wide
  layouts, and guard the four books that exposed earlier regressions with an
  optional local corpus test.
- Require the EPUB suite and frontend build to pass before release packaging.

## 0.6.2 — 2026-09-21

### EPUB image viewer

- Double-click any raster image in an EPUB to open it in a dedicated window.
- Start with the entire image fitted inside the window without changing its
  aspect ratio.
- Add Fit, actual-size (100%), zoom-out, and zoom-in controls, with keyboard
  shortcuts for each view.
- Keep original-size images scrollable at high zoom and support embedded data
  images without putting their contents in a window URL.

## 0.6.1 — 2026-09-21

### EPUB reader hotfix

- Repair valid XHTML self-closing HTML elements before chapters enter the
  browser's HTML parser. Elements such as `<span role="doc-pagebreak"/>` now
  remain empty instead of swallowing the rest of the chapter.
- Hide only page-break markers that are actually empty, so malformed markup
  cannot make an entire chapter disappear.
- Restore rendering and pagination for *AI Snake Oil* while retaining the image,
  table, font, and link improvements from 0.6.0.

## 0.6.0 — 2026-09-20

Shelfmark 0.6 brings the recent library-management, large-library, and EPUB
reader work together in one release.

### Library organization and imports

- Add comma-separated tags to books and show each tag as a collection under
  **Books** in the sidebar. A book can belong to multiple collections without
  moving its file.
- Save book and comic library paths automatically when they change.
- Import books and comics from the file picker or by drag and drop. Shelfmark
  copies imports into `Imported/<Author>/<Title>/`; comics use their series in
  place of the author.
- Avoid overwriting existing files, skip identical reimports, sanitize folder
  names, and leave files already organized inside the library where they are.

### Large libraries

- Page, filter, and sort the library in SQLite so the interface only renders a
  bounded set of books at once.
- Add a local full-text search index for responsive title, author, and metadata
  searches.
- Make rescans incremental by skipping unchanged files using their size and
  modification time.
- Generate shelf-sized cover thumbnails and clean up cached covers left behind
  by removed books.
- Validate the library path against a synthetic collection of 10,000 books.

### EPUB reader

- Support namespace-prefixed EPUB package manifests and recover embedded covers
  that are not declared correctly.
- Decode standard IDPF-obfuscated embedded fonts and honor `xml:lang` metadata
  for font shaping and hyphenation.
- Let the reader's font-size setting scale publisher-defined text sizes while
  retaining a **Publisher's font** option.
- Preserve every image's aspect ratio and publisher-defined size. Images stay
  inside a single page and move intact to the next page when necessary.
- Restore publisher float and wrapper sizing, while constraining oversized
  images and media to the available page area.
- Preserve publisher link styling so linked tables of contents remain visibly
  interactive.
- Paginate long tables between rows, keep each row intact, and wrap long cell
  content instead of allowing it to overflow.
- Hide print page-number markers and improve chapter pagination across Windows
  and macOS.

### Packages

- Build Windows MSI and EXE installers, a universal macOS DMG and app archive,
  and Linux AppImage, DEB, and RPM packages.
