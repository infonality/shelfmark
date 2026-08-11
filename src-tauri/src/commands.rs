//! Tauri command surface — the typed IPC boundary the React UI calls into.

use std::path::PathBuf;
use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, State};

use crate::db;
use crate::error::CmdResult;
use crate::models::{
    Annotation, Book, BookEdit, DashboardStats, MetaCandidate, ScanResult, Settings,
};
use crate::scanner::now_ts;
use crate::{covers, metadata, scanner};

pub struct AppState {
    pub conn: Mutex<Connection>,
    pub http: reqwest::Client,
    pub covers_dir: PathBuf,
}

fn s<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------- settings ----------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    let conn = state.conn.lock().map_err(s)?;
    db::load_settings(&conn).map_err(s)
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: Settings) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::save_settings(&conn, &settings).map_err(s)
}

// ---------------- library ----------------

#[tauri::command]
pub fn list_books(state: State<'_, AppState>) -> CmdResult<Vec<Book>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_books(&conn).map_err(s)
}

#[tauri::command]
pub fn get_book(state: State<'_, AppState>, id: i64) -> CmdResult<Option<Book>> {
    let conn = state.conn.lock().map_err(s)?;
    db::get_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn list_categories(state: State<'_, AppState>) -> CmdResult<Vec<String>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_categories(&conn).map_err(s)
}

#[tauri::command]
pub fn dashboard_stats(state: State<'_, AppState>) -> CmdResult<DashboardStats> {
    let conn = state.conn.lock().map_err(s)?;
    db::dashboard(&conn).map_err(s)
}

// ---------------- scan ----------------

#[tauri::command]
pub fn scan_library(app: AppHandle, state: State<'_, AppState>) -> CmdResult<ScanResult> {
    let conn = state.conn.lock().map_err(s)?;
    let settings = db::load_settings(&conn).map_err(s)?;
    if settings.books_root.trim().is_empty() && settings.comics_root.trim().is_empty() {
        return Err("Set your books or comics folder in Settings first.".into());
    }
    let books = PathBuf::from(&settings.books_root);
    let comics = PathBuf::from(&settings.comics_root);
    scanner::scan(
        &conn,
        &books,
        &comics,
        &state.covers_dir,
        settings.words_per_page,
        |ev| {
            let _ = app.emit("scan-progress", ev);
        },
    )
    .map_err(s)
}

// ---------------- edits & reading state ----------------

#[tauri::command]
pub fn update_book(state: State<'_, AppState>, id: i64, edit: BookEdit) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    let settings = db::load_settings(&conn).map_err(s)?;
    db::update_book(&conn, id, &edit, settings.words_per_page, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_status(state: State<'_, AppState>, id: i64, status: String) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_status(&conn, id, &status, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_progress(state: State<'_, AppState>, id: i64, current_page: i64) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_progress(&conn, id, current_page, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn set_rating(state: State<'_, AppState>, id: i64, rating: Option<i64>) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::set_rating(&conn, id, rating, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

// ---------------- built-in reader ----------------

/// Everything the reader needs to open a book: reading order, contents, the
/// saved position, and the base URL its frame resolves assets against.
#[derive(serde::Serialize)]
pub struct ReaderSession {
    #[serde(flatten)]
    pub book: crate::reader::ReaderBook,
    pub resource_base: String,
    pub locator: Option<String>,
    pub title: String,
}

/// Base URL of the `bookres` protocol. Tauri maps custom schemes onto an
/// http origin on Windows and Android, and a real scheme elsewhere.
fn resource_base(id: i64) -> String {
    #[cfg(any(windows, target_os = "android"))]
    let base = format!("http://bookres.localhost/{id}/");
    #[cfg(not(any(windows, target_os = "android")))]
    let base = format!("bookres://localhost/{id}/");
    base
}

#[tauri::command]
pub fn reader_open(state: State<'_, AppState>, id: i64) -> CmdResult<ReaderSession> {
    let (path, title, locator) = {
        let conn = state.conn.lock().map_err(s)?;
        let b = db::require_book(&conn, id).map_err(s)?;
        (b.path, b.title, db::get_locator(&conn, id).map_err(s)?)
    };
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("The file is no longer at {path}. Rescan your library."));
    }
    let book = crate::reader::open(std::path::Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    Ok(ReaderSession { book, resource_base: resource_base(id), locator, title })
}

#[tauri::command]
pub fn reader_chapter(
    state: State<'_, AppState>,
    id: i64,
    index: usize,
) -> CmdResult<crate::reader::Chapter> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    crate::reader::chapter(std::path::Path::new(&path), index).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn reader_save_position(
    state: State<'_, AppState>,
    id: i64,
    locator: String,
    percent: f64,
) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    db::save_locator(&conn, id, &locator, percent, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn reader_search(
    state: State<'_, AppState>,
    id: i64,
    query: String,
) -> CmdResult<Vec<crate::reader::SearchHit>> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    // Capped so a single-letter query on a long book can't flood the UI.
    crate::reader::search(std::path::Path::new(&path), &query, 300)
        .map_err(|e| format!("{e:#}"))
}

// ---------------- built-in PDF reader ----------------

/// Everything the PDF reader needs to lay out the whole document before a
/// single page has been rasterised.
#[derive(serde::Serialize)]
pub struct PdfSession {
    /// Every page's size in points. The reader needs all of them up front:
    /// a scrollbar that means anything, and pages that don't jump about as
    /// they arrive, both depend on knowing the shape of pages nobody has
    /// looked at yet.
    pub pages: Vec<crate::pdf::PageSize>,
    /// The document's own table of contents, flattened with its depth.
    pub outline: Vec<crate::pdf::Outline>,
    pub resource_base: String,
    pub locator: Option<String>,
    pub title: String,
}

/// The selectable text on one page.
///
/// Fetched per page rather than with the session: extracting a page costs a few
/// milliseconds, which is nothing on its own and half a minute across a
/// five-hundred-page book nobody has scrolled to yet.
#[tauri::command]
pub fn pdf_text(state: State<'_, AppState>, id: i64, page: usize) -> CmdResult<Vec<crate::pdf::TextRun>> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    crate::pdf::page_text(std::path::Path::new(&path), page).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn pdf_open(state: State<'_, AppState>, id: i64) -> CmdResult<PdfSession> {
    let (path, title, locator) = {
        let conn = state.conn.lock().map_err(s)?;
        let b = db::require_book(&conn, id).map_err(s)?;
        (b.path, b.title, db::get_locator(&conn, id).map_err(s)?)
    };
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("The file is no longer at {path}. Rescan your library."));
    }
    // Opening a book is the moment to drop what was rendered from the last
    // copy of it: a file replaced on disk while the app was running would
    // otherwise keep serving pages from the version that is gone.
    crate::pdf::forget(id);
    let book = crate::pdf::open(std::path::Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    Ok(PdfSession {
        pages: book.pages,
        outline: book.outline,
        resource_base: resource_base(id),
        locator,
        title,
    })
}

/// Every occurrence of `query` in a PDF.
///
/// Scanned on demand rather than from an index. A five-hundred-page book takes
/// about a second, which is a fine price for never having a stale index and
/// never having to decide when to rebuild one.
#[tauri::command]
pub fn pdf_search(state: State<'_, AppState>, id: i64, query: String) -> CmdResult<Vec<crate::pdf::SearchHit>> {
    let path = {
        let conn = state.conn.lock().map_err(s)?;
        db::require_book(&conn, id).map_err(s)?.path
    };
    crate::pdf::search(std::path::Path::new(&path), &query).map_err(|e| format!("{e:#}"))
}

// ---------------- built-in comic reader ----------------

/// Everything the comic reader needs: the page list, where its images come
/// from, and where the reader left off.
#[derive(serde::Serialize)]
pub struct ComicSession {
    /// Entry paths inside the archive, in reading order.
    pub pages: Vec<String>,
    pub resource_base: String,
    pub locator: Option<String>,
    pub title: String,
    /// "rtl" or "ltr". Page order in the archive never changes — this is only
    /// which way the reader moves through it.
    pub direction: String,
    /// Whether this comic belongs to a series, so the reader can offer to set
    /// the direction for the whole run at once.
    pub series: Option<String>,
}

#[tauri::command]
pub fn comic_open(state: State<'_, AppState>, id: i64) -> CmdResult<ComicSession> {
    let (path, title, locator, direction, series) = {
        let conn = state.conn.lock().map_err(s)?;
        let b = db::require_book(&conn, id).map_err(s)?;
        let dir = b.reading_direction.clone().unwrap_or_else(|| "ltr".into());
        (b.path, b.title, db::get_locator(&conn, id).map_err(s)?, dir, b.series)
    };
    if !std::path::Path::new(&path).is_file() {
        return Err(format!("The file is no longer at {path}. Rescan your library."));
    }
    let book = crate::comics::open(std::path::Path::new(&path)).map_err(|e| format!("{e:#}"))?;
    Ok(ComicSession {
        pages: book.pages,
        resource_base: resource_base(id),
        locator,
        title,
        direction,
        series,
    })
}

/// Set which way a comic reads, optionally for its whole series.
#[tauri::command]
pub fn set_reading_direction(
    state: State<'_, AppState>,
    id: i64,
    direction: String,
    wholeSeries: bool,
) -> CmdResult<usize> {
    let dir = if direction == "rtl" { "rtl" } else { "ltr" };
    let conn = state.conn.lock().map_err(s)?;
    db::set_reading_direction(&conn, id, dir, wholeSeries, now_ts()).map_err(s)
}

// ---------------- highlights & bookmarks ----------------

#[tauri::command]
pub fn list_annotations(state: State<'_, AppState>, book_id: i64) -> CmdResult<Vec<Annotation>> {
    let conn = state.conn.lock().map_err(s)?;
    db::list_annotations(&conn, book_id).map_err(s)
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn add_annotation(
    state: State<'_, AppState>,
    book_id: i64,
    spine: i64,
    start_off: i64,
    end_off: i64,
    kind: String,
    color: String,
    text: String,
) -> CmdResult<Annotation> {
    let conn = state.conn.lock().map_err(s)?;
    db::add_annotation(
        &conn, book_id, spine, start_off, end_off, &kind, &color, &text, now_ts(),
    )
    .map_err(s)
}

#[tauri::command]
pub fn update_annotation(
    state: State<'_, AppState>,
    id: i64,
    note: Option<String>,
    color: Option<String>,
) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::update_annotation(&conn, id, note.as_deref(), color.as_deref()).map_err(s)
}

#[tauri::command]
pub fn delete_annotation(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::delete_annotation(&conn, id).map_err(s)
}

/// Hand a book to whatever application the OS has registered for its file type,
/// and record that we did. The path is looked up from the library rather than
/// taken from the caller, so the webview can't ask us to launch arbitrary files.
#[tauri::command]
pub fn open_book(state: State<'_, AppState>, id: i64) -> CmdResult<Book> {
    let conn = state.conn.lock().map_err(s)?;
    let book = db::require_book(&conn, id).map_err(s)?;

    let path = PathBuf::from(&book.path);
    if !path.is_file() {
        return Err(format!(
            "The file is no longer at {}. Rescan your library to update it.",
            book.path
        ));
    }

    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| {
        format!("Couldn't open {}: {e}. Is a {} reader installed?", book.filename, book.format)
    })?;

    db::mark_opened(&conn, id, now_ts()).map_err(s)?;
    db::require_book(&conn, id).map_err(s)
}

#[tauri::command]
pub fn delete_book(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let conn = state.conn.lock().map_err(s)?;
    db::delete_book(&conn, id).map_err(s)?;
    // Drop any cached cover for this book.
    for ext in ["jpg", "png", "gif", "webp", "jpeg", "svg"] {
        let p = state.covers_dir.join(format!("{id}.{ext}"));
        if p.exists() {
            std::fs::remove_file(&p).ok();
        }
    }
    Ok(())
}

// ---------------- online metadata (Open Library) ----------------

#[tauri::command]
pub async fn search_metadata(
    state: State<'_, AppState>,
    query: String,
) -> CmdResult<Vec<MetaCandidate>> {
    let http = state.http.clone();
    metadata::search(&http, &query).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub async fn apply_metadata(
    state: State<'_, AppState>,
    id: i64,
    candidate: MetaCandidate,
) -> CmdResult<Book> {
    // Snapshot what we need under a short lock.
    let (words_per_page, book) = {
        let conn = state.conn.lock().map_err(s)?;
        let settings = db::load_settings(&conn).map_err(s)?;
        let book = db::require_book(&conn, id).map_err(s)?;
        (settings.words_per_page, book)
    };

    let http = state.http.clone();

    // Fill a description only when the book doesn't already have one.
    let description = if book.description.as_deref().map(|d| d.is_empty()).unwrap_or(true) {
        match &candidate.work_key {
            Some(k) => metadata::fetch_description(&http, k).await,
            None => None,
        }
    } else {
        None
    };

    // Download and cache the cover art.
    let cover_path = if let Some(url) = &candidate.cover_url {
        match metadata::download_cover(&http, url).await {
            Ok(bytes) if !bytes.is_empty() => {
                covers::store_bytes(&state.covers_dir, id, &bytes, "jpg").ok()
            }
            _ => None,
        }
    } else {
        None
    };

    // Derive word count from the fetched page count only if we don't already
    // have a real (non-estimated) count.
    let published_date = candidate.year.map(|y| y.to_string());
    let (words, words_estimated) = match candidate.pages {
        Some(p) if p > 0 && (book.words.is_none() || book.words_estimated) => {
            (Some(p * words_per_page.max(1)), true)
        }
        _ => (book.words, book.words_estimated),
    };

    {
        let conn = state.conn.lock().map_err(s)?;
        db::apply_metadata(
            &conn,
            id,
            &candidate.title,
            candidate.author.as_deref(),
            candidate.publisher.as_deref(),
            published_date.as_deref(),
            candidate.isbn.as_deref(),
            candidate.subjects.as_deref(),
            description.as_deref(),
            candidate.pages,
            words,
            words_estimated,
            cover_path.as_deref(),
            now_ts(),
        )
        .map_err(s)?;
        db::require_book(&conn, id).map_err(s)
    }
}
