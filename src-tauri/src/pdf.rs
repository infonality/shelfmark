//! Built-in PDF reader backend.
//!
//! A PDF has no markup to hand a webview, so unlike an EPUB it can't be laid
//! out by the browser: every page is rasterised here and served as an image,
//! the way a comic's pages are. Pages are rendered one at a time as they are
//! reached — a technical book runs to hundreds of pages, and rendering them up
//! front would cost minutes and hundreds of megabytes for the two you're
//! looking at.
//!
//! What makes this cheaper than it sounds is that page *sizes* are known
//! without rendering anything. `open` reads them from the page tree in a few
//! milliseconds, so the reader can lay out the whole document — scrollbar
//! included — before a single page has been rasterised, and nothing shifts
//! underneath you as they arrive.
//!
//! Rendering goes through the same PDFium binding that draws covers, which is
//! already bound per-thread and shipped alongside the executable.

use anyhow::{anyhow, Context, Result};
use image::ImageEncoder;
use pdfium_render::prelude::*;
use serde::Serialize;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::pdfcover::with_pdfium;

/// A page's size in PDF points (1/72"), as authored. The reader only needs the
/// ratio, but points are what the document is in and converting here would
/// throw away the one thing that makes the numbers checkable.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct PageSize {
    pub w: f32,
    pub h: f32,
}

/// One entry in the document's outline — what a PDF calls bookmarks and every
/// reader calls the table of contents.
#[derive(Debug, Clone, Serialize)]
pub struct Outline {
    pub label: String,
    /// Zero-based page it points at, or `None` when the entry names something
    /// this document doesn't actually contain — which happens, and is not a
    /// reason to drop the heading it carries.
    pub page: Option<usize>,
    /// Nesting depth, so the reader can indent the tree it came from.
    pub depth: usize,
}

/// A run of text on a page, with where it sits.
///
/// Coordinates are in points from the *top* left, already flipped out of PDF's
/// bottom-left origin. Doing it here means the reader scales one rectangle
/// system rather than reasoning about two.
#[derive(Debug, Clone, Serialize)]
pub struct TextRun {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    pub text: String,
}

/// A PDF's shape: how many pages, how big each one is, and its contents.
#[derive(Debug, Clone, Serialize)]
pub struct PdfBook {
    pub pages: Vec<PageSize>,
    pub outline: Vec<Outline>,
}

/// How deep to follow the outline. Real documents nest three or four levels;
/// anything deeper is a malformed file pointing at itself.
const MAX_OUTLINE_DEPTH: usize = 8;
/// Enough for any real table of contents, and a bound on a document whose
/// bookmark tree loops.
const MAX_OUTLINE_ENTRIES: usize = 5000;

/// Narrowest and widest we will rasterise to.
///
/// The ceiling is a memory bound rather than a quality one: width² bytes of
/// bitmap, and the request carries the width, so without a cap a stray URL
/// could ask for a gigapixel page. It has room for the reader's 2x
/// oversampling on a wide window, which is what makes text look drawn rather
/// than resampled.
pub const MIN_WIDTH: i32 = 200;
pub const MAX_WIDTH: i32 = 4000;

/// Read a PDF's page count and page sizes.
///
/// No page is rasterised, so this stays in single-digit milliseconds even on a
/// five-hundred-page book.
pub fn open(path: &Path) -> Result<PdfBook> {
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_file(path, None)
            .with_context(|| format!("open {}", path.display()))?;
        let pages: Vec<PageSize> = doc
            .pages()
            .iter()
            .map(|page| PageSize {
                w: page.width().value,
                h: page.height().value,
            })
            .collect();
        if pages.is_empty() {
            return Err(anyhow!("this PDF has no pages"));
        }
        let mut outline = Vec::new();
        if let Some(root) = doc.bookmarks().root() {
            walk_outline(&root, 0, &mut outline);
        }
        Ok(PdfBook { pages, outline })
    })
}

/// Flatten the bookmark tree, keeping the depth so it can be indented again.
///
/// Walked by hand rather than with the crate's descendants iterator because
/// that one gives no depth, and an outline without its shape is a list of
/// headings with the structure — which is most of the meaning — thrown away.
fn walk_outline(node: &PdfBookmark, depth: usize, out: &mut Vec<Outline>) {
    if depth > MAX_OUTLINE_DEPTH || out.len() >= MAX_OUTLINE_ENTRIES {
        return;
    }
    for bookmark in node.iter_siblings() {
        if out.len() >= MAX_OUTLINE_ENTRIES {
            return;
        }
        let label = bookmark.title().unwrap_or_default();
        let label = label.trim().to_string();
        if !label.is_empty() {
            out.push(Outline {
                label,
                page: bookmark
                    .destination()
                    .and_then(|d| d.page_index().ok())
                    .map(|i| i as usize),
                depth,
            });
        }
        if let Some(child) = bookmark.first_child() {
            walk_outline(&child, depth + 1, out);
        }
    }
}

/// Every run of text on a page, positioned from the top left in points.
///
/// This is what makes text selectable: the reader lays these out as invisible
/// spans over the rendered bitmap, so the selection the browser already knows
/// how to do lands on the words that are actually there.
pub fn page_text(path: &Path, index: usize) -> Result<Vec<TextRun>> {
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_file(path, None)
            .with_context(|| format!("open {}", path.display()))?;
        let count = doc.pages().len() as usize;
        if index >= count {
            return Err(anyhow!("page {} of {}", index + 1, count));
        }
        runs_on(&doc.pages().get(index as u16)?)
    })
}

/// The runs on one page.
///
/// Search and selection both come through here, and they have to: a hit's
/// offsets are only meaningful against the same text the reader laid out, so
/// the two must agree on which segments count and in what order. Extracting
/// them twice with two rules is how a search result ends up highlighting the
/// wrong words.
fn runs_on(page: &PdfPage) -> Result<Vec<TextRun>> {
    let height = page.height().value;
    let text = page.text()?;
    let mut runs = Vec::new();
    for segment in text.segments().iter() {
        let content = segment.text();
        if content.trim().is_empty() {
            continue;
        }
        let b = segment.bounds();
        // PDF measures up from the bottom of the page; screens measure down
        // from the top.
        runs.push(TextRun {
            x: b.left.value,
            y: height - b.top.value,
            w: (b.right.value - b.left.value).max(0.0),
            h: (b.top.value - b.bottom.value).max(0.0),
            text: content,
        });
    }
    Ok(runs)
}

/// A place in the document where the query appears.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub page: usize,
    /// Character offsets into that page's text, in the units the reader counts
    /// in — see `u16_offsets`.
    pub start: usize,
    pub end: usize,
    /// The match with a little of the sentence around it.
    pub snippet: String,
}

/// Stop before a runaway query fills the panel with thousands of rows.
const MAX_HITS: usize = 500;
/// Characters of context either side of a match in the snippet.
const SNIPPET_CONTEXT: usize = 48;

/// Find every occurrence of `query`, case-insensitively, across the document.
///
/// No index. Extracting a page's text costs single-digit milliseconds, so a
/// five-hundred-page book scans in about a second — cheaper than building an
/// index, and far cheaper than keeping one honest as the file changes.
pub fn search(path: &Path, query: &str) -> Result<Vec<SearchHit>> {
    let needle: Vec<char> = fold(query.trim());
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_file(path, None)
            .with_context(|| format!("open {}", path.display()))?;
        let mut hits = Vec::new();
        for (index, page) in doc.pages().iter().enumerate() {
            if hits.len() >= MAX_HITS {
                break;
            }
            let text: String = runs_on(&page)?.iter().map(|r| r.text.as_str()).collect();
            let chars: Vec<char> = text.chars().collect();
            let hay = fold(&text);
            let offsets = u16_offsets(&chars);
            for at in find_all(&hay, &needle, MAX_HITS - hits.len()) {
                hits.push(SearchHit {
                    page: index,
                    start: offsets[at],
                    end: offsets[at + needle.len()],
                    snippet: snippet(&chars, at, needle.len()),
                });
            }
        }
        Ok(hits)
    })
}

/// Lower-case one character per character.
///
/// `to_lowercase` can return more than one — ss for a German sharp s — which
/// would slide every offset after it. Matching is worth a little less
/// correctness in those cases; pointing at the wrong words is not.
fn fold(s: &str) -> Vec<char> {
    s.chars()
        .map(|c| c.to_lowercase().next().unwrap_or(c))
        .collect()
}

/// Where each character starts, counted in UTF-16 code units.
///
/// That is what the reader counts in, because a JavaScript string's length is
/// in UTF-16 units rather than characters. For anything outside the basic
/// plane — an emoji, some rarer CJK — the two disagree, and a hit would
/// highlight the wrong words.
fn u16_offsets(chars: &[char]) -> Vec<usize> {
    let mut out = Vec::with_capacity(chars.len() + 1);
    let mut n = 0;
    for c in chars {
        out.push(n);
        n += c.len_utf16();
    }
    out.push(n);
    out
}

fn find_all(hay: &[char], needle: &[char], limit: usize) -> Vec<usize> {
    let mut out = Vec::new();
    if needle.is_empty() || hay.len() < needle.len() {
        return out;
    }
    let mut i = 0;
    while i + needle.len() <= hay.len() && out.len() < limit {
        if hay[i..i + needle.len()] == *needle {
            out.push(i);
            // Overlapping repeats of the same phrase are one finding rather
            // than several: step past what was just matched.
            i += needle.len();
        } else {
            i += 1;
        }
    }
    out
}

fn snippet(chars: &[char], at: usize, len: usize) -> String {
    let from = at.saturating_sub(SNIPPET_CONTEXT);
    let to = (at + len + SNIPPET_CONTEXT).min(chars.len());
    let body: String = chars[from..to].iter().collect();
    // Runs are joined without separators, so a snippet carries whatever line
    // breaks and runs of spaces the layout had. Collapse them, or the panel
    // shows ragged holes.
    let mut s = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        s.insert(0, ELLIPSIS);
    }
    if to < chars.len() {
        s.push(ELLIPSIS);
    }
    s
}

const ELLIPSIS: char = '\u{2026}';

/// Rasterise one page to a PNG at `width` pixels across.
///
/// PNG rather than JPEG on measurement, not taste: against real books PDFium
/// renders a page in 10-20ms and the PNG encoder adds 5-11ms, where the JPEG
/// encoder adds 70-160ms. JPEG's smaller output would only matter if these
/// bytes crossed a network, and they don't — they go straight to the webview.
pub fn render_page(path: &Path, index: usize, width: i32) -> Result<Vec<u8>> {
    let width = width.clamp(MIN_WIDTH, MAX_WIDTH);
    with_pdfium(|pdfium| {
        let doc = pdfium
            .load_pdf_from_file(path, None)
            .with_context(|| format!("open {}", path.display()))?;
        let count = doc.pages().len() as usize;
        if index >= count {
            return Err(anyhow!("page {} of {}", index + 1, count));
        }
        let page = doc.pages().get(index as u16)?;

        // Pages are drawn onto white. PDFium clears to transparent, and
        // dropping the alpha channel on the way to RGB would leave whatever
        // happened to be underneath showing through the margins.
        let config = PdfRenderConfig::new()
            .set_target_width(width)
            .set_clear_color(PdfColor::WHITE);
        let rendered = page.render_with_config(&config)?.as_image().into_rgb8();

        let (w, h) = (rendered.width(), rendered.height());
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&rendered, w, h, image::ExtendedColorType::Rgb8)
            .map_err(|e| anyhow!("encode page: {e}"))?;
        Ok(png)
    })
}

/// Recently rendered pages, oldest first.
///
/// Bounded by bytes rather than by count, because a page's weight depends
/// entirely on the width it was asked for — thirty pages is 7MB at reading
/// width and 70MB zoomed in, and only one of those is a cache.
static CACHE: Mutex<Cache> = Mutex::new(Cache {
    entries: VecDeque::new(),
    bytes: 0,
    budget: CACHE_BYTES,
});

/// Around thirty pages at reading width, oversampled. The point is to make
/// paging back through what you just read free; holding a whole book would not.
const CACHE_BYTES: usize = 64 * 1024 * 1024;

type CacheKey = (i64, usize, i32);

struct Cache {
    entries: VecDeque<(CacheKey, Arc<Vec<u8>>)>,
    bytes: usize,
    budget: usize,
}

impl Cache {
    /// Look a page up, promoting it to newest so that what you are moving
    /// through stays cached and what you have left behind is what gets
    /// evicted.
    fn get(&mut self, key: CacheKey) -> Option<Arc<Vec<u8>>> {
        let at = self.entries.iter().position(|(k, _)| *k == key)?;
        let entry = self.entries.remove(at)?;
        let png = Arc::clone(&entry.1);
        self.entries.push_back(entry);
        Some(png)
    }

    fn put(&mut self, key: CacheKey, png: Arc<Vec<u8>>) {
        // A single page bigger than the whole budget would evict everything
        // and then still not fit; leave the cache alone and just serve it.
        if png.len() > self.budget {
            return;
        }
        self.remove(key);
        self.bytes += png.len();
        self.entries.push_back((key, png));
        while self.bytes > self.budget {
            match self.entries.pop_front() {
                Some((_, evicted)) => self.bytes -= evicted.len(),
                None => break,
            }
        }
    }

    fn remove(&mut self, key: CacheKey) {
        if let Some(at) = self.entries.iter().position(|(k, _)| *k == key) {
            if let Some((_, old)) = self.entries.remove(at) {
                self.bytes -= old.len();
            }
        }
    }

    fn forget_book(&mut self, book_id: i64) {
        let mut freed = 0;
        self.entries.retain(|((id, _, _), png)| {
            if *id == book_id {
                freed += png.len();
                return false;
            }
            true
        });
        self.bytes -= freed;
    }
}

/// A rendered page, from the cache when it's there.
///
/// Rendering happens outside the lock. Two requests for the same page can
/// therefore both render it, which wastes 20ms once; holding the lock across
/// the render would instead serialise every page request in the app behind
/// whichever one arrived first, including the prefetches.
pub fn page_png(book_id: i64, path: &Path, index: usize, width: i32) -> Result<Arc<Vec<u8>>> {
    let key = (book_id, index, width.clamp(MIN_WIDTH, MAX_WIDTH));
    if let Some(hit) = CACHE.lock().ok().and_then(|mut c| c.get(key)) {
        return Ok(hit);
    }
    let png = Arc::new(render_page(path, index, width)?);
    if let Ok(mut cache) = CACHE.lock() {
        cache.put(key, Arc::clone(&png));
    }
    Ok(png)
}

/// Drop everything cached for one book, so a file that has been re-scanned or
/// replaced on disk isn't served from a stale render.
pub fn forget(book_id: i64) {
    if let Ok(mut cache) = CACHE.lock() {
        cache.forget_book(book_id);
    }
}

/// Parse a `page/{n}` resource path into a zero-based page index.
///
/// Returns `None` for anything else, which is how the resource protocol tells a
/// page request apart from an archive entry.
pub fn page_index(entry: &str) -> Option<usize> {
    entry.strip_prefix("page/")?.parse::<usize>().ok()
}

/// Width to rasterise at, from a `?w=` query.
///
/// The reader always sends one — it is the only side that knows how big the
/// page is on screen. The fallback is for a request that arrives without it,
/// where a readable page beats a correct refusal.
pub fn width_from_query(query: Option<&str>) -> i32 {
    const DEFAULT_WIDTH: i32 = 1200;
    query
        .unwrap_or("")
        .split('&')
        .find_map(|pair| pair.strip_prefix("w=")?.parse::<i32>().ok())
        .unwrap_or(DEFAULT_WIDTH)
        .clamp(MIN_WIDTH, MAX_WIDTH)
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Document, Object, Stream};
    use std::path::PathBuf;

    /// A valid two-page PDF (200x300 then 300x200) at a temp path.
    fn build_pdf() -> PathBuf {
        let path = std::env::temp_dir().join(format!("shelfmark_pdf_{}.pdf", std::process::id()));
        let mut doc = Document::with_version("1.5");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for (w, h) in [(200, 300), (300, 200)] {
            let content_id = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
            let page_id = doc.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "MediaBox" => vec![0.into(), 0.into(), w.into(), h.into()],
                "Contents" => content_id,
            });
            kids.push(page_id.into());
        }
        let count = kids.len() as i64;
        doc.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => kids,
                "Count" => count,
            }),
        );
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        doc.trailer.set("Root", catalog_id);
        doc.save(&path).unwrap();
        path
    }

    /// Whether PDFium could be bound. Without the library these tests can say
    /// nothing, so they skip rather than fail.
    fn pdfium_available() -> bool {
        with_pdfium(|_| Ok(())).is_ok()
    }

    #[test]
    fn reads_page_sizes_without_rendering() {
        if !pdfium_available() {
            eprintln!("pdfium unavailable, skipping");
            return;
        }
        let path = build_pdf();
        let book = open(&path).expect("open pdf");
        std::fs::remove_file(&path).ok();

        assert_eq!(book.pages.len(), 2);
        assert_eq!((book.pages[0].w, book.pages[0].h), (200.0, 300.0));
        // Landscape pages have to survive as landscape — the reader pairs
        // pages by shape, so a size read the wrong way round would group them
        // wrongly before anything had rendered.
        assert_eq!((book.pages[1].w, book.pages[1].h), (300.0, 200.0));
    }

    #[test]
    fn renders_a_page_at_the_asked_width() {
        if !pdfium_available() {
            eprintln!("pdfium unavailable, skipping");
            return;
        }
        let path = build_pdf();
        let png = render_page(&path, 0, 400).expect("render page");
        let img = image::load_from_memory(&png).expect("decode png");
        assert_eq!(img.width(), 400);
        assert_eq!(img.height(), 600, "2:3 page should stay 2:3");

        // Out of range is an error, not a panic or a blank page.
        assert!(render_page(&path, 9, 400).is_err());

        // A width beyond the cap is clamped rather than refused.
        let wide = render_page(&path, 0, MAX_WIDTH * 10).expect("clamped render");
        assert_eq!(
            image::load_from_memory(&wide).unwrap().width(),
            MAX_WIDTH as u32
        );
        std::fs::remove_file(&path).ok();
    }

    /// A cache with a small budget, so eviction can be reasoned about in
    /// whole pages rather than megabytes.
    fn cache(budget: usize) -> Cache {
        Cache { entries: VecDeque::new(), bytes: 0, budget }
    }

    fn page(bytes: usize) -> Arc<Vec<u8>> {
        Arc::new(vec![0u8; bytes])
    }

    #[test]
    fn cache_evicts_the_least_recently_used() {
        let mut c = cache(300);
        c.put((1, 0, 900), page(100));
        c.put((1, 1, 900), page(100));
        c.put((1, 2, 900), page(100));

        // Reading page 0 again makes page 1 the coldest, so the next insert
        // evicts page 1 rather than page 0. Reading back through what you
        // just read is the case this exists for.
        assert!(c.get((1, 0, 900)).is_some());
        c.put((1, 3, 900), page(100));

        assert!(c.get((1, 1, 900)).is_none(), "coldest page should be gone");
        assert!(c.get((1, 0, 900)).is_some());
        assert!(c.get((1, 2, 900)).is_some());
        assert!(c.get((1, 3, 900)).is_some());
        assert_eq!(c.bytes, 300);
    }

    #[test]
    fn cache_keys_on_width_and_book() {
        let mut c = cache(1000);
        c.put((1, 0, 900), page(10));
        // The same page zoomed in is a different render, not a hit.
        assert!(c.get((1, 0, 1800)).is_none());
        // And the same page number in another book is another book's page.
        assert!(c.get((2, 0, 900)).is_none());
        assert!(c.get((1, 0, 900)).is_some());
    }

    #[test]
    fn cache_replaces_rather_than_double_counts() {
        let mut c = cache(1000);
        c.put((1, 0, 900), page(100));
        c.put((1, 0, 900), page(100));
        assert_eq!(c.entries.len(), 1);
        assert_eq!(c.bytes, 100, "re-rendering a page must not leak its budget");
    }

    #[test]
    fn cache_serves_but_does_not_hold_an_oversized_page() {
        let mut c = cache(100);
        c.put((1, 0, 3000), page(500));
        assert!(c.entries.is_empty(), "should not evict everything for a page that cannot fit");
        assert_eq!(c.bytes, 0);
    }

    #[test]
    fn forgetting_a_book_leaves_the_others() {
        let mut c = cache(1000);
        c.put((1, 0, 900), page(100));
        c.put((2, 0, 900), page(100));
        c.forget_book(1);
        assert!(c.get((1, 0, 900)).is_none());
        assert!(c.get((2, 0, 900)).is_some());
        assert_eq!(c.bytes, 100);
    }

    #[test]
    fn folds_one_character_per_character() {
        // The offsets a hit reports index the reader's text, so folding must
        // not change how many characters there are.
        for s in ["Hello", "STRASSE", "Ärger", "ǅungla", "naïve"] {
            assert_eq!(
                fold(s).len(),
                s.chars().count(),
                "folding {s:?} changed the character count"
            );
        }
        assert_eq!(fold("MiXeD").iter().collect::<String>(), "mixed");
    }

    #[test]
    fn counts_offsets_the_way_javascript_does() {
        // A reader counts in UTF-16 units, so anything outside the basic plane
        // takes two. Getting this wrong slides every later hit on the page.
        let chars: Vec<char> = "aB\u{1F600}c".chars().collect();
        assert_eq!(u16_offsets(&chars), vec![0, 1, 2, 4, 5]);
        let plain: Vec<char> = "abc".chars().collect();
        assert_eq!(u16_offsets(&plain), vec![0, 1, 2, 3]);
    }

    #[test]
    fn finds_each_occurrence_once() {
        let hay: Vec<char> = "the cat sat on the mat".chars().collect();
        let needle: Vec<char> = "at".chars().collect();
        assert_eq!(find_all(&hay, &needle, 99), vec![5, 9, 20]);

        // A repeated phrase is one finding per occurrence, not one per
        // starting position inside it.
        let aaa: Vec<char> = "aaaa".chars().collect();
        let aa: Vec<char> = "aa".chars().collect();
        assert_eq!(find_all(&aaa, &aa, 99), vec![0, 2]);

        assert_eq!(find_all(&hay, &needle, 2).len(), 2, "the limit is respected");
        assert!(find_all(&hay, &[], 9).is_empty(), "an empty query matches nothing");
        assert!(
            find_all(&[], &needle, 9).is_empty(),
            "an empty page matches nothing"
        );
        let long: Vec<char> = "xxxxxxxx".chars().collect();
        assert!(
            find_all(&needle, &long, 9).is_empty(),
            "a query longer than the text matches nothing"
        );
    }

    #[test]
    fn snippets_carry_context_without_the_layout() {
        let chars: Vec<char> = "alpha   beta\ngamma delta".chars().collect();
        // Runs join without separators, so the raw text keeps the layout's
        // line breaks and double spaces; a snippet should read as a sentence.
        let s = snippet(&chars, 8, 4);
        assert!(s.contains("alpha beta gamma"), "got {s:?}");
        assert!(!s.contains('\n'), "newlines should be collapsed: {s:?}");
        assert!(!s.contains("  "), "runs of spaces should be collapsed: {s:?}");

        // Truncated on both sides when there is more text around it.
        let long: Vec<char> = "z".repeat(400).chars().collect();
        let mid = snippet(&long, 200, 1);
        assert!(mid.starts_with('\u{2026}') && mid.ends_with('\u{2026}'), "got {mid:?}");
        // And not when the match is at the very start.
        let head = snippet(&long, 0, 1);
        assert!(!head.starts_with('\u{2026}'), "got {head:?}");
    }

    #[test]
    fn search_finds_nothing_for_an_empty_query() {
        let path = build_pdf();
        assert!(search(&path, "   ").unwrap().is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn reads_page_requests() {
        assert_eq!(page_index("page/0"), Some(0));
        assert_eq!(page_index("page/41"), Some(41));
        // Anything that isn't a page request belongs to the archive lookup.
        assert_eq!(page_index("OEBPS/image.png"), None);
        assert_eq!(page_index("page/"), None);
        assert_eq!(page_index("page/-1"), None);
        assert_eq!(page_index("page/2.5"), None);
        assert_eq!(page_index("pages/2"), None);
    }

    #[test]
    fn reads_the_render_width() {
        assert_eq!(width_from_query(Some("w=1400")), 1400);
        assert_eq!(width_from_query(Some("v=2&w=900")), 900);
        // Anything unusable falls back rather than failing the request.
        assert_eq!(width_from_query(None), 1200);
        assert_eq!(width_from_query(Some("w=wide")), 1200);
        // A width out of range is clamped, so a stray URL can't ask for a
        // gigapixel bitmap.
        assert_eq!(width_from_query(Some("w=99999")), MAX_WIDTH);
        assert_eq!(width_from_query(Some("w=1")), MIN_WIDTH);
        assert_eq!(width_from_query(Some("w=-5")), MIN_WIDTH);
    }
}




