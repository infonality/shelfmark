//! Copy user-selected files into an organized, app-managed part of a library.

use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};

use crate::formats;
use crate::models::ProgressEvent;
use crate::scanner::clean_name;

/// Import layout: `<root>/Imported/<author or series>/<title>/<original file>`.
/// Existing files elsewhere in the root are never moved.
pub fn copy_into_library(
    paths: &[String],
    root: &Path,
    kind: &str,
    words_per_page: i64,
    mut progress: impl FnMut(ProgressEvent),
) -> Result<(usize, usize)> {
    fs::create_dir_all(root)
        .with_context(|| format!("Could not create library folder {}", root.display()))?;
    let root_abs = fs::canonicalize(root)?;
    let mut copied = 0;
    let mut skipped = 0;

    for (i, raw) in paths.iter().enumerate() {
        let source = PathBuf::from(raw);
        let filename = source
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("book")
            .to_string();
        progress(ProgressEvent {
            job: "import".into(),
            current: i,
            total: paths.len(),
            message: format!("Importing {filename}"),
            done: false,
        });

        if !source.is_file() {
            skipped += 1;
            continue;
        }
        let Some(format) = formats::detect_format(&source) else {
            skipped += 1;
            continue;
        };
        if (kind == "book" && matches!(format, "cbz" | "cbr"))
            || (kind == "comic" && matches!(format, "epub" | "mobi"))
        {
            skipped += 1;
            continue;
        }

        let source_abs = fs::canonicalize(&source)?;
        if source_abs.starts_with(&root_abs) {
            // It is already managed by this library; the following scan will
            // register it without manufacturing a duplicate.
            skipped += 1;
            continue;
        }

        let meta = formats::extract(&source, format, words_per_page);
        let fallback = source
            .file_stem()
            .and_then(|s| s.to_str())
            .map(clean_name)
            .unwrap_or_else(|| "Untitled".into());
        let title = meta
            .title
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&fallback);
        let group = if kind == "comic" {
            meta.series
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Unsorted")
        } else {
            meta.author
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("Unknown Author")
        };
        let dir = root_abs
            .join("Imported")
            .join(safe_component(group))
            .join(safe_component(title));
        fs::create_dir_all(&dir)?;
        let target = unique_target(&source, &dir.join(&filename))?;
        let Some(target) = target else {
            skipped += 1;
            continue;
        };
        fs::copy(&source, &target).with_context(|| {
            format!(
                "Could not copy {} to {}",
                source.display(),
                target.display()
            )
        })?;
        copied += 1;
    }

    progress(ProgressEvent {
        job: "import".into(),
        current: paths.len(),
        total: paths.len(),
        message: format!("Copied {copied}; skipped {skipped}"),
        done: false,
    });
    Ok((copied, skipped))
}

fn unique_target(source: &Path, requested: &Path) -> Result<Option<PathBuf>> {
    if !requested.exists() {
        return Ok(Some(requested.to_path_buf()));
    }
    if files_equal(source, requested)? {
        return Ok(None);
    }

    let stem = requested
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("book");
    let ext = requested.extension().and_then(|s| s.to_str());
    let parent = requested.parent().unwrap_or_else(|| Path::new(""));
    for n in 2..10_000 {
        let filename = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = parent.join(filename);
        if !candidate.exists() {
            return Ok(Some(candidate));
        }
        if files_equal(source, &candidate)? {
            return Ok(None);
        }
    }
    anyhow::bail!("Too many files named {stem} in {}", parent.display())
}

fn files_equal(a: &Path, b: &Path) -> Result<bool> {
    if fs::metadata(a)?.len() != fs::metadata(b)?.len() {
        return Ok(false);
    }
    let mut a = BufReader::new(File::open(a)?);
    let mut b = BufReader::new(File::open(b)?);
    let mut ab = [0_u8; 64 * 1024];
    let mut bb = [0_u8; 64 * 1024];
    loop {
        let an = a.read(&mut ab)?;
        let bn = b.read(&mut bb)?;
        if an != bn || ab[..an] != bb[..bn] {
            return Ok(false);
        }
        if an == 0 {
            return Ok(true);
        }
    }
}

fn safe_component(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
            out.push('_');
        } else {
            out.push(ch);
        }
    }
    let mut out = out.trim().trim_end_matches(['.', ' ']).to_string();
    if out.is_empty() {
        out = "Unknown".into();
    }
    if is_windows_device_name(&out) {
        out.insert(0, '_');
    }
    out.chars().take(80).collect()
}

fn is_windows_device_name(name: &str) -> bool {
    let base = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (base.len() == 4
            && (base.starts_with("COM") || base.starts_with("LPT"))
            && base[3..].parse::<u8>().is_ok_and(|n| (1..=9).contains(&n)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_components_are_portable_and_bounded() {
        assert_eq!(safe_component("  Ursula K. Le Guin  "), "Ursula K. Le Guin");
        assert_eq!(safe_component("A/B: C?"), "A_B_ C_");
        assert_eq!(safe_component("CON"), "_CON");
        assert_eq!(safe_component("..."), "Unknown");
        assert!(safe_component(&"x".repeat(100)).chars().count() <= 80);
    }

    #[test]
    fn imports_into_metadata_folders_and_skips_an_identical_reimport() {
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("sample_books")
            .join("The Time Machine.epub");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("shelfmark-import-{}-{stamp}", std::process::id()));
        let paths = vec![source.to_string_lossy().to_string()];

        let (copied, skipped) = copy_into_library(&paths, &root, "book", 275, |_| {}).unwrap();
        assert_eq!((copied, skipped), (1, 0));
        let imported = walkdir::WalkDir::new(root.join("Imported"))
            .into_iter()
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().and_then(|x| x.to_str()) == Some("epub"));
        assert!(imported.is_some());

        let again = copy_into_library(&paths, &root, "book", 275, |_| {}).unwrap();
        assert_eq!(again, (0, 1));
        fs::remove_dir_all(&root).unwrap();
    }
}
