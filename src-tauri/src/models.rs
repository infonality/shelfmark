//! Serializable data structures shared between the Rust core and the React UI.

use serde::{Deserialize, Serialize};

/// A single book in the library. Combines the file on disk, its extracted /
/// fetched metadata, and the user's reading state.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Book {
    pub id: i64,
    pub path: String,
    pub filename: String,
    /// epub | pdf | mobi
    pub format: String,
    pub size: i64,

    // ----- bibliographic metadata -----
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    /// User-assigned shelf/category (free text).
    pub category: Option<String>,
    /// Comma-joined genres / subjects.
    pub subjects: Option<String>,
    /// User-assigned comma-separated collections.
    pub tags: Option<String>,
    /// Stored local cover image path (for the asset protocol).
    pub cover_path: Option<String>,

    // ----- size metrics -----
    pub pages: Option<i64>,
    pub words: Option<i64>,
    /// True when `words` (and often `pages`) are estimated rather than counted.
    pub words_estimated: bool,

    // ----- reading state -----
    /// unread | reading | finished
    pub status: String,
    pub current_page: i64,
    /// User ranking, 1..=5.
    pub rating: Option<i64>,

    /// none | embedded | fetched | manual
    pub meta_status: String,
    pub meta_source: Option<String>,

    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
    /// Last time the file was handed to the system's default reader.
    pub last_opened_at: Option<i64>,
    /// Opaque JSON position from the built-in reader (spine index + offset).
    pub locator: Option<String>,
    /// book | comic. Decided by which root the file was found under, except
    /// for cbz/cbr which are comics wherever they live.
    pub kind: String,
    /// "rtl" for a comic that reads right to left; null or "ltr" otherwise.
    pub reading_direction: Option<String>,
    pub added_at: i64,
    pub updated_at: i64,
}

/// Fields the user can edit directly from the detail drawer.
#[derive(Debug, Clone, Deserialize)]
pub struct BookEdit {
    pub title: String,
    pub author: Option<String>,
    pub series: Option<String>,
    pub publisher: Option<String>,
    pub published_date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub category: Option<String>,
    pub subjects: Option<String>,
    pub tags: Option<String>,
    pub pages: Option<i64>,
    pub words: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Root folder that holds the book files.
    pub books_root: String,
    /// Root folder for comics. Kept separate from books because format alone
    /// can't tell them apart — plenty of comics are PDFs.
    pub comics_root: String,
    /// Estimate used to derive word counts when a real count isn't available.
    pub words_per_page: i64,
}

/// Per-category rollup for the dashboard.
#[derive(Debug, Clone, Serialize)]
pub struct CategoryStat {
    pub name: String,
    pub total: i64,
    pub finished: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    /// Finished books and comics, counted separately.
    pub books_read: i64,
    pub comics_read: i64,
    /// Pages across everything finished — books and comics together, since a
    /// page read is a page read.
    pub pages_read: i64,
    /// In progress, both kinds.
    pub currently_reading: i64,

    pub total_books: i64,
    pub total_comics: i64,
    pub unread: i64,
    pub finished: i64,

    pub categories: Vec<CategoryStat>,
    /// Most recently finished books (up to a handful) for the dashboard feed.
    pub recent_finished: Vec<Book>,
    /// Books currently being read.
    pub in_progress: Vec<Book>,
}

/// One metadata match returned from an Open Library search. Round-trips to the
/// frontend and back (the UI hands a chosen candidate to `apply_metadata`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetaCandidate {
    pub title: String,
    pub author: Option<String>,
    pub year: Option<i64>,
    pub pages: Option<i64>,
    pub publisher: Option<String>,
    pub isbn: Option<String>,
    pub subjects: Option<String>,
    pub cover_url: Option<String>,
    /// Open Library work key, e.g. "/works/OL45804W" (used to fetch a description).
    pub work_key: Option<String>,
}

/// A highlight or bookmark inside a book.
///
/// Anchored by character offsets into the chapter's rendered text, not by
/// pixels or page numbers, so it stays put when the type size or window
/// changes and the text reflows.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: i64,
    pub book_id: i64,
    /// Index into the reading order.
    pub spine: i64,
    pub start_off: i64,
    pub end_off: i64,
    /// highlight | bookmark
    pub kind: String,
    pub color: String,
    /// The text that was marked, kept so the list is readable without
    /// reopening the chapter.
    pub text: String,
    pub note: Option<String>,
    pub created_at: i64,
}

/// Progress event emitted during a scan.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub job: String,
    pub current: usize,
    pub total: usize,
    pub message: String,
    pub done: bool,
}

/// Result summary of a scan.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ScanResult {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    pub total: usize,
}

/// Result of copying files into the managed portion of a library root.
#[derive(Debug, Clone, Serialize, Default)]
pub struct ImportResult {
    pub copied: usize,
    pub skipped: usize,
    pub scan: ScanResult,
}
