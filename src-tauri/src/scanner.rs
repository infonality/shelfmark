//! Filesystem scanner: walks the configured roots, extracts metadata from every
//! supported file, caches embedded covers, and registers each entry in the
//! library. Entries whose files have disappeared are pruned.
//!
//! Two roots are walked — books and comics — because a file's format can't say
//! which it is; plenty of comics are PDFs. The folder decides, except for
//! cbz/cbr, which are comics wherever they're found.

use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;
use walkdir::WalkDir;

use crate::covers;
use crate::db::{self, ScannedBook};
use crate::formats;
use crate::models::{ProgressEvent, ScanResult};

/// Turn a filename stem into a friendly default title when the file carries no
/// embedded title of its own.
pub fn clean_name(stem: &str) -> String {
    let out = stem.replace(['_', '.'], " ");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Comic archives are comics no matter where they sit; everything else takes
/// the kind of the root it was found under.
fn kind_for(fmt: &str, root_kind: &str) -> String {
    match fmt {
        "cbz" | "cbr" => "comic".to_string(),
        _ => root_kind.to_string(),
    }
}

pub fn scan(
    conn: &Connection,
    books_root: &Path,
    comics_root: &Path,
    covers_dir: &Path,
    words_per_page: i64,
    mut progress: impl FnMut(ProgressEvent),
) -> Result<ScanResult> {
    let mut result = ScanResult::default();

    // An empty Path resolves to the current working directory on some
    // platforms; an unset root must not make a scan walk the app directory.
    let books_ok = !books_root.as_os_str().is_empty() && books_root.is_dir();
    let comics_ok = !comics_root.as_os_str().is_empty() && comics_root.is_dir();
    if !books_ok && !comics_ok {
        anyhow::bail!(
            "Neither folder exists. Books: {}. Comics: {}",
            books_root.display(),
            comics_root.display()
        );
    }

    progress(ProgressEvent {
        job: "scan".into(),
        current: 0,
        total: 0,
        message: "Discovering files…".into(),
        done: false,
    });

    // 1. Discover candidate files across both roots. Comics are walked first
    // so that a comics folder nested inside the books folder still wins.
    let mut candidates: Vec<(std::path::PathBuf, &'static str, String)> = Vec::new();
    let mut live_paths: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let roots: [(&Path, &str, bool); 2] =
        [(comics_root, "comic", comics_ok), (books_root, "book", books_ok)];
    for (root, root_kind, ok) in roots {
        if !ok {
            continue;
        }
        for entry in WalkDir::new(root).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let Some(fmt) = formats::detect_format(path) else { continue };
            let key = path.to_string_lossy().to_string();
            if !seen.insert(key.clone()) {
                continue;
            }
            live_paths.push(key);
            candidates.push((path.to_path_buf(), fmt, kind_for(fmt, root_kind)));
        }
    }
    result.total = candidates.len();
    let total = candidates.len();

    // 2. Extract + register each candidate.
    let now = now_ts();
    for (i, (path, fmt, kind)) in candidates.iter().enumerate() {
        let filename = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let stem = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
        let size = std::fs::metadata(path).map(|m| m.len() as i64).unwrap_or(0);

        progress(ProgressEvent {
            job: "scan".into(),
            current: i,
            total,
            message: format!("Reading {filename}"),
            done: false,
        });

        let meta = formats::extract(path, fmt, words_per_page);
        let has_embedded_title = meta.title.as_deref().map(|t| !t.trim().is_empty()).unwrap_or(false);
        let title = match &meta.title {
            Some(t) if !t.trim().is_empty() => t.clone(),
            _ => clean_name(&stem),
        };

        let scanned = ScannedBook {
            path: path.to_string_lossy().to_string(),
            filename,
            format: (*fmt).to_string(),
            size,
            title,
            author: meta.author.clone(),
            series: meta.series.clone(),
            publisher: meta.publisher.clone(),
            published_date: meta.published_date.clone(),
            language: meta.language.clone(),
            isbn: meta.isbn.clone(),
            description: meta.description.clone(),
            subjects: meta.subjects.clone(),
            cover_path: None,
            pages: meta.pages,
            words: meta.words,
            words_estimated: meta.words_estimated,
            meta_status: if has_embedded_title { "embedded".into() } else { "none".into() },
            kind: kind.clone(),
        };

        let (id, inserted) = db::upsert_scanned(conn, &scanned, now)?;
        if inserted {
            result.added += 1;
        } else {
            result.updated += 1;
        }

        // Ensure the book has a usable cover. We (re)generate from the file
        // whenever the current cover is missing or looks broken (e.g. a tiny 1x1
        // spacer, as Open Library returns for books with no cover). A cover that
        // is already a real image — including one the user fetched online — is
        // left untouched.
        let cover_path: Option<String> = conn
            .query_row("SELECT cover_path FROM books WHERE id=?1", [id], |r| r.get(0))
            .unwrap_or_default();
        if !cover_is_usable(cover_path.as_deref()) {
            // Prefer an embedded cover; for PDFs (which have none) render page 1.
            let mut new_cover: Option<String> = None;
            if let Some(cover) = &meta.cover {
                new_cover = covers::store_bytes(covers_dir, id, &cover.bytes, &cover.ext).ok();
            }
            if new_cover.is_none() && *fmt == "pdf" {
                new_cover = crate::pdfcover::render_cover(path, covers_dir, id).ok();
            }
            if let Some(cp) = new_cover {
                let _ = conn.execute(
                    "UPDATE books SET cover_path=?2 WHERE id=?1",
                    rusqlite::params![id, cp],
                );
            }
        }
    }

    // 3. Prune books whose files vanished.
    result.removed = db::delete_missing(conn, &live_paths)?;

    progress(ProgressEvent {
        job: "scan".into(),
        current: total,
        total,
        message: format!(
            "Scan complete — {} added, {} updated, {} removed",
            result.added, result.updated, result.removed
        ),
        done: true,
    });
    Ok(result)
}

/// Fill covers that an older EPUB parser could not discover. This is deliberately
/// cover-only, so upgrading does not turn application startup into a full scan.
pub fn backfill_missing_epub_covers(conn: &Connection, covers_dir: &Path) -> Result<usize> {
    let mut stmt = conn.prepare(
        "SELECT id, path, cover_path FROM books WHERE lower(format) = 'epub'",
    )?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);

    let mut repaired = 0;
    for (id, path, current) in rows {
        if cover_is_usable(current.as_deref()) {
            continue;
        }
        let Ok(Some(cover)) = crate::formats::epub::extract_cover(Path::new(&path)) else {
            continue;
        };
        let Ok(cover_path) = covers::store_bytes(covers_dir, id, &cover.bytes, &cover.ext) else {
            continue;
        };
        conn.execute(
            "UPDATE books SET cover_path=?2 WHERE id=?1",
            rusqlite::params![id, cover_path],
        )?;
        repaired += 1;
    }
    Ok(repaired)
}

/// Whether a stored cover file exists and is large enough to be a real image
/// (some ebooks ship a tiny 1x1 spacer that we don't want to keep as a cover).
fn cover_is_usable(cover_path: Option<&str>) -> bool {
    const MIN_COVER_BYTES: u64 = 2048;
    match cover_path {
        Some(p) if !p.is_empty() => std::fs::metadata(p)
            .map(|m| m.len() >= MIN_COVER_BYTES)
            .unwrap_or(false),
        _ => false,
    }
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
