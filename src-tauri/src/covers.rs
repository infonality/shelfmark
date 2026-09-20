//! Cover-image storage. Covers (extracted from files or downloaded from Open
//! Library) are cached under the app-data `covers/` dir, named by book id, and
//! surfaced to the webview through Tauri's asset protocol.

use std::path::Path;

use anyhow::Result;
use image::ImageFormat;
use rusqlite::Connection;

/// Cover extensions we may have written for a book.
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "svg"];

/// Remove any cached cover files for a book (all known extensions).
pub fn remove_all(covers_dir: &Path, book_id: i64) {
    for ext in COVER_EXTS {
        let p = covers_dir.join(format!("{book_id}.{ext}"));
        if p.exists() {
            std::fs::remove_file(&p).ok();
        }
    }
}

/// Write cover bytes as `covers/{book_id}.{ext}`, replacing any existing file.
/// Returns the absolute path as a string for storage in the DB.
pub fn store_bytes(covers_dir: &Path, book_id: i64, bytes: &[u8], ext: &str) -> Result<String> {
    remove_all(covers_dir, book_id);
    let ext = ext.to_ascii_lowercase();
    let path = covers_dir.join(format!("{book_id}.{ext}"));
    let format = match ext.as_str() {
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "png" => Some(ImageFormat::Png),
        "gif" => Some(ImageFormat::Gif),
        "webp" => Some(ImageFormat::WebP),
        _ => None,
    };
    // Library covers are thumbnails. Retaining a 4000px publisher image wastes
    // disk and decode memory without adding visible detail in a shelf tile.
    // `thumbnail` preserves aspect ratio and never enlarges a small source.
    if let (Some(format), Ok(image)) = (format, image::load_from_memory(bytes)) {
        if image.width() > 600 || image.height() > 900 {
            image.thumbnail(600, 900).save_with_format(&path, format)?;
        } else {
            std::fs::write(&path, bytes)?;
        }
    } else {
        // SVG and unusual but browser-readable cover formats remain untouched.
        std::fs::write(&path, bytes)?;
    }
    Ok(path.to_string_lossy().to_string())
}

/// Remove cache files whose book row no longer exists. This is run after a
/// scan prunes missing books, keeping storage proportional to the live library.
pub fn prune_orphans(covers_dir: &Path, conn: &Connection) -> Result<usize> {
    let mut stmt = conn.prepare("SELECT id FROM books")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, i64>(0))?
        .collect::<rusqlite::Result<std::collections::HashSet<_>>>()?;
    let mut removed = 0;
    for entry in std::fs::read_dir(covers_dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let Some(id) = entry
            .path()
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<i64>().ok())
        else {
            continue;
        };
        if !ids.contains(&id) {
            std::fs::remove_file(entry.path())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn large_cover_is_bounded_without_changing_aspect_ratio() {
        let dir = std::env::temp_dir().join(format!(
            "shelfmark-cover-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let source = image::DynamicImage::new_rgb8(1200, 600);
        let mut bytes = Cursor::new(Vec::new());
        source.write_to(&mut bytes, ImageFormat::Png).unwrap();
        let path = store_bytes(&dir, 1, bytes.get_ref(), "png").unwrap();
        let stored = image::open(path).unwrap();
        assert_eq!((stored.width(), stored.height()), (600, 300));
        std::fs::remove_dir_all(dir).ok();
    }
}
