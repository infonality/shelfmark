//! Built-in EPUB reader backend.
//!
//! Opens a book's ZIP, exposes the reading order and table of contents, and
//! hands out individual chapter documents plus the assets they reference
//! (stylesheets, images, embedded fonts) so the publisher's own typography can
//! render untouched.
//!
//! Everything served from here is untrusted: an EPUB is arbitrary HTML from
//! wherever the file came from. Chapters are stripped of scripts before they
//! leave this module, and the frontend renders them in an iframe with no
//! script permission. Resource lookups are confined to entries that actually
//! exist inside the archive, so a crafted href can't walk out to the disk.

use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use serde::Serialize;
use sha1::{Digest, Sha1};
use std::path::Path;
use zip::ZipArchive;

use crate::formats::epub::{
    find_opf_path, parent_dir, parse_opf, read_entry_bytes, read_entry_string, resolve, Archive,
};

/// One document in the reading order.
#[derive(Debug, Clone, Serialize)]
pub struct SpineItem {
    /// Position in the spine; the stable half of a reading locator.
    pub index: usize,
    /// Path of the document inside the archive.
    pub path: String,
    /// Characters of text in this document, used to turn a position into a
    /// percentage without re-reading the whole book.
    pub chars: usize,
}

/// A table-of-contents entry. Flat, with a depth so the UI can indent.
#[derive(Debug, Clone, Serialize)]
pub struct TocEntry {
    pub label: String,
    /// Spine index this entry points at, when it resolves to one.
    pub spine_index: Option<usize>,
    /// Fragment (`#id`) within the document, if the entry targets one.
    pub fragment: Option<String>,
    pub depth: usize,
}

/// Everything the reader UI needs to open a book.
#[derive(Debug, Clone, Serialize)]
pub struct ReaderBook {
    pub spine: Vec<SpineItem>,
    pub toc: Vec<TocEntry>,
    /// Total characters across the spine — the denominator for progress.
    pub total_chars: usize,
}

fn open_zip(path: &Path) -> Result<Archive> {
    let file = std::fs::File::open(path).with_context(|| format!("open {}", path.display()))?;
    ZipArchive::new(std::io::BufReader::new(file)).context("read epub archive")
}

/// The package document, plus the reading order as archive paths.
struct Package {
    opf: crate::formats::epub::Opf,
    /// Directory the OPF lives in; hrefs inside it resolve against this.
    dir: String,
    /// Content documents in reading order.
    docs: Vec<String>,
}

/// Read the package and the reading order, without touching the documents
/// themselves. Opening a chapter needs the order but not the text, and reading
/// the text means decompressing every document in the book.
fn package(zip: &mut Archive) -> Result<Package> {
    let opf_path = find_opf_path(zip)?;
    let opf_xml = read_entry_string(zip, &opf_path)?;
    let opf = parse_opf(&opf_xml);
    let dir = parent_dir(&opf_path);

    // Reading order: spine itemrefs mapped through the manifest to real paths.
    let mut docs = Vec::new();
    for idref in &opf.spine {
        let Some(item) = opf.manifest.iter().find(|i| &i.id == idref) else {
            continue;
        };
        if !is_document(&item.media_type, &item.href) {
            continue;
        }
        docs.push(resolve(&dir, &item.href));
    }
    if docs.is_empty() {
        return Err(anyhow!("this EPUB has no readable chapters"));
    }
    Ok(Package { opf, dir, docs })
}

/// Read the spine and table of contents.
pub fn open(path: &Path) -> Result<ReaderBook> {
    let mut zip = open_zip(path)?;
    let pkg = package(&mut zip)?;

    // Counting text now means progress percentages never need a second pass.
    let mut spine = Vec::with_capacity(pkg.docs.len());
    for entry in &pkg.docs {
        let chars = read_entry_string(&mut zip, entry)
            .map(|html| crate::formats::strip_tags(&html).chars().count())
            .unwrap_or(0);
        spine.push(SpineItem { index: spine.len(), path: entry.clone(), chars });
    }

    let toc = read_toc(&mut zip, &pkg.opf, &pkg.dir, &spine).unwrap_or_default();
    let total_chars = spine.iter().map(|s| s.chars).sum();

    Ok(ReaderBook { spine, toc, total_chars })
}

fn is_document(media_type: &str, href: &str) -> bool {
    let h = href.to_ascii_lowercase();
    media_type.contains("xhtml")
        || media_type.contains("html")
        || h.ends_with(".xhtml")
        || h.ends_with(".html")
        || h.ends_with(".htm")
}

/// A chapter, sanitised and ready to drop into the reader frame.
#[derive(Debug, Clone, Serialize)]
pub struct Chapter {
    pub index: usize,
    /// Body markup with scripts removed.
    pub html: String,
    /// Directory of this document inside the archive; the frontend resolves
    /// relative asset URLs against it.
    pub dir: String,
    pub chars: usize,
}

/// One chapter. Deliberately goes through `package` rather than `open`: turning
/// a page into the next chapter shouldn't re-read and re-measure every other
/// document in the book, which on a long one is seconds of work per chapter.
pub fn chapter(path: &Path, index: usize) -> Result<Chapter> {
    let mut zip = open_zip(path)?;
    let pkg = package(&mut zip)?;
    let entry = pkg
        .docs
        .get(index)
        .ok_or_else(|| anyhow!("chapter {index} is out of range"))?
        .clone();
    let raw = read_entry_string(&mut zip, &entry)?;
    let chars = crate::formats::strip_tags(&raw).chars().count();
    Ok(Chapter {
        index,
        html: sanitize(&raw),
        dir: parent_dir(&entry),
        chars,
    })
}

/// One match from a full-text search across the book.
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub spine: usize,
    /// Which occurrence this is within its chapter, counting from zero. The
    /// reader finds the same occurrence in the rendered page rather than
    /// trusting an offset — the text we search here has had its markup
    /// stripped, so character positions wouldn't line up with the DOM.
    pub occurrence: usize,
    /// Surrounding text for the result list.
    pub snippet: String,
}

/// Case-insensitive search over every chapter's text.
pub fn search(path: &Path, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
    let q: Vec<char> = query.trim().to_lowercase().chars().collect();
    if q.len() < 2 {
        return Ok(Vec::new());
    }
    let book = open(path)?;
    let mut zip = open_zip(path)?;
    let mut out = Vec::new();

    for item in &book.spine {
        if out.len() >= limit {
            break;
        }
        let Ok(html) = read_entry_string(&mut zip, &item.path) else {
            continue;
        };
        let chars: Vec<char> = crate::formats::strip_tags(&html).chars().collect();
        // Fold case per character so positions stay aligned with `chars`;
        // lowercasing the whole string can change its length.
        let lower: Vec<char> = chars
            .iter()
            .map(|c| c.to_lowercase().next().unwrap_or(*c))
            .collect();

        let mut occurrence = 0usize;
        let mut i = 0usize;
        while i + q.len() <= lower.len() {
            if lower[i..i + q.len()] == q[..] {
                out.push(SearchHit {
                    spine: item.index,
                    occurrence,
                    snippet: snippet_at(&chars, i, q.len()),
                });
                occurrence += 1;
                i += q.len();
                if out.len() >= limit {
                    break;
                }
            } else {
                i += 1;
            }
        }
    }
    Ok(out)
}

/// A window of text either side of a match, trimmed to whole words.
fn snippet_at(chars: &[char], start: usize, len: usize) -> String {
    const PAD: usize = 55;
    let from = start.saturating_sub(PAD);
    let to = (start + len + PAD).min(chars.len());
    let mut s: String = chars[from..to].iter().collect();
    s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if from > 0 {
        s.insert_str(0, "… ");
    }
    if to < chars.len() {
        s.push_str(" …");
    }
    s
}

/// Bytes of an asset referenced by a chapter, with a guessed content type.
/// Only entries present in the archive resolve, so this can't escape the zip.
pub fn resource(path: &Path, entry: &str) -> Result<(Vec<u8>, String)> {
    let mut zip = open_zip(path)?;
    // `resolve` collapses `.` and `..`, so a crafted href can't climb out.
    let clean = resolve("", entry);
    let mut bytes = read_entry_bytes(&mut zip, &clean)?;
    maybe_deobfuscate_font(&mut zip, &clean, &mut bytes)?;
    Ok((bytes, mime_for(&clean)))
}

/// EPUB permits embedded fonts to be lightly obfuscated so the font file is
/// tied to this publication. Browsers cannot consume those bytes directly;
/// reading systems reverse the XOR before serving the font to their renderer.
fn maybe_deobfuscate_font(zip: &mut Archive, entry: &str, bytes: &mut [u8]) -> Result<()> {
    let lower = entry.to_ascii_lowercase();
    if ![".otf", ".ttf", ".woff", ".woff2"]
        .iter()
        .any(|ext| lower.ends_with(ext))
    {
        return Ok(());
    }

    let Ok(encryption_xml) = read_entry_string(zip, "META-INF/encryption.xml") else {
        return Ok(());
    };
    let protected = idpf_obfuscated_entries(&encryption_xml);
    if !protected.iter().any(|path| norm(path) == norm(entry)) {
        return Ok(());
    }

    let opf_path = find_opf_path(zip)?;
    let opf = parse_opf(&read_entry_string(zip, &opf_path)?);
    let identifier = opf
        .unique_identifier
        .as_deref()
        .ok_or_else(|| anyhow!("obfuscated font has no publication identifier"))?;
    apply_idpf_obfuscation(bytes, identifier);
    Ok(())
}

/// Resources protected with the standard IDPF embedding algorithm.
fn idpf_obfuscated_entries(xml: &str) -> Vec<String> {
    const IDPF: &str = "http://www.idpf.org/2008/embedding";
    let mut reader = Reader::from_str(xml);
    let mut buf = Vec::new();
    let mut in_resource = false;
    let mut is_idpf = false;
    let mut uri: Option<String> = None;
    let mut out = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) if e.local_name().as_ref() == b"EncryptedData" => {
                in_resource = true;
                is_idpf = false;
                uri = None;
            }
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if in_resource => {
                match e.local_name().as_ref() {
                    b"EncryptionMethod" => {
                        is_idpf = attr(&e, b"Algorithm").as_deref() == Some(IDPF)
                    }
                    b"CipherReference" => uri = attr(&e, b"URI"),
                    _ => {}
                }
            }
            Ok(Event::End(e)) if e.local_name().as_ref() == b"EncryptedData" => {
                if is_idpf {
                    if let Some(path) = uri.take() {
                        out.push(resolve("", &path));
                    }
                }
                in_resource = false;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// The IDPF algorithm removes XML whitespace from the package identifier,
/// hashes it with SHA-1, and repeats that 20-byte key over the first 1040 bytes.
/// XOR is symmetric, so the same operation obfuscates and restores a font.
fn apply_idpf_obfuscation(bytes: &mut [u8], identifier: &str) {
    let normalized: String = identifier
        .chars()
        .filter(|c| !matches!(*c, ' ' | '\t' | '\r' | '\n'))
        .collect();
    let key = Sha1::digest(normalized.as_bytes());
    for (index, byte) in bytes.iter_mut().take(1040).enumerate() {
        *byte ^= key[index % key.len()];
    }
}

pub fn mime_for(path: &str) -> String {
    let lower = path.to_ascii_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "css" => "text/css",
        "js" => "text/plain", // never served as script
        "xhtml" | "html" | "htm" => "application/xhtml+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "otf" => "font/otf",
        "ttf" => "font/ttf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "mp3" => "audio/mpeg",
        "mp4" | "m4v" => "video/mp4",
        _ => "application/octet-stream",
    }
    .to_string()
}

// ---------- sanitising ----------

/// Remove anything that could execute. The reader frame also runs without
/// script permission, so this is the inner of two layers rather than the only
/// one — but it means script never reaches the webview at all.
fn sanitize(html: &str) -> String {
    let mut out = strip_elements(html, "script");
    out = strip_elements(&out, "iframe");
    out = strip_elements(&out, "object");
    out = strip_elements(&out, "embed");
    out = strip_event_handlers(&out);
    out
}

/// Drop `<tag ...>...</tag>` and self-closing forms, case-insensitively.
fn strip_elements(html: &str, tag: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}");
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while let Some(rel) = lower[i..].find(&open_pat) {
        let start = i + rel;
        // Only a real tag: next char must end the name.
        let after = lower[start + open_pat.len()..].chars().next();
        if !matches!(after, Some(c) if c.is_whitespace() || c == '>' || c == '/') {
            out.push_str(&html[i..start + open_pat.len()]);
            i = start + open_pat.len();
            continue;
        }
        out.push_str(&html[i..start]);
        // Skip to the matching close tag, or the end of a self-closing one.
        let end = match lower[start..].find(&close_pat) {
            Some(c) => match lower[start + c..].find('>') {
                Some(g) => start + c + g + 1,
                None => html.len(),
            },
            None => match lower[start..].find('>') {
                Some(g) => start + g + 1,
                None => html.len(),
            },
        };
        i = end;
    }
    out.push_str(&html[i..]);
    out
}

/// Strip `on*="..."` attributes and `javascript:` URLs.
fn strip_event_handlers(html: &str) -> String {
    let chars: Vec<char> = html.chars().collect();
    let mut out = String::with_capacity(html.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] != '<' || !opens_tag(chars.get(i + 1)) {
            // A bare `<` in prose — "5 < 6" — is text, and treating it as a tag
            // would swallow everything up to the next `>`.
            out.push(chars[i]);
            i += 1;
            continue;
        }
        let end = tag_end(&chars, i);
        let tag: String = chars[i..end.min(chars.len())].iter().collect();
        out.push_str(&filter_tag(&tag));
        i = end;
    }
    out
}

/// Whether `<` followed by this character begins a tag rather than prose.
fn opens_tag(next: Option<&char>) -> bool {
    matches!(next, Some(c) if c.is_ascii_alphabetic() || *c == '/' || *c == '!' || *c == '?')
}

/// Index just past the `>` that closes the tag starting at `start`.
///
/// Quoting matters here. `<img alt="a > b" src="p.png">` ends at the *second*
/// `>`; stopping at the first would cut the tag in half and drop `src` with it,
/// which shows up as an image that silently fails to load.
fn tag_end(chars: &[char], start: usize) -> usize {
    // Comments have their own terminator and may contain anything at all.
    if chars[start..].starts_with(&['<', '!', '-', '-']) {
        let mut j = start + 4;
        while j + 2 < chars.len() {
            if chars[j] == '-' && chars[j + 1] == '-' && chars[j + 2] == '>' {
                return j + 3;
            }
            j += 1;
        }
        return chars.len();
    }

    let mut quote: Option<char> = None;
    let mut j = start + 1;
    while j < chars.len() {
        let c = chars[j];
        match quote {
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == '>' => return j + 1,
            None => {}
        }
        j += 1;
    }
    chars.len()
}

fn filter_tag(tag: &str) -> String {
    let lower = tag.to_ascii_lowercase();
    if !lower.contains("on") && !lower.contains("javascript:") {
        return tag.to_string();
    }
    let mut out = String::with_capacity(tag.len());
    let mut rest = tag;
    loop {
        let lower = rest.to_ascii_lowercase();
        // Find an `on...=` attribute at a word boundary.
        let hit = lower.match_indices("on").find(|(idx, _)| {
            let before_ok = *idx == 0
                || rest[..*idx].chars().next_back().map(|c| c.is_whitespace()).unwrap_or(false);
            let eq = lower[*idx..].find('=');
            before_ok
                && eq.is_some_and(|e| lower[*idx..*idx + e].chars().all(|c| c.is_alphanumeric()))
        });
        match hit {
            Some((idx, _)) => {
                out.push_str(&rest[..idx]);
                let after = &rest[idx..];
                let eq = after.find('=').unwrap_or(after.len());
                let tail = &after[eq..];
                // Skip past the attribute's quoted (or bare) value.
                let mut chars = tail.char_indices().skip(1).skip_while(|(_, c)| c.is_whitespace());
                let consumed = match chars.next() {
                    Some((qi, q @ ('"' | '\''))) => tail[qi + 1..]
                        .find(q)
                        .map(|e| qi + 1 + e + 1)
                        .unwrap_or(tail.len()),
                    Some((si, _)) => tail[si..]
                        .find(|c: char| c.is_whitespace() || c == '>')
                        .map(|e| si + e)
                        .unwrap_or(tail.len()),
                    None => tail.len(),
                };
                rest = &tail[consumed..];
            }
            None => {
                out.push_str(rest);
                break;
            }
        }
    }
    out.replace("javascript:", "about:blank#")
}

// ---------- table of contents ----------

fn read_toc(
    zip: &mut Archive,
    opf: &crate::formats::epub::Opf,
    dir: &str,
    spine: &[SpineItem],
) -> Option<Vec<TocEntry>> {
    // EPUB 3 declares its nav document in the manifest; EPUB 2 uses an NCX.
    let nav = opf
        .manifest
        .iter()
        .find(|i| i.properties.split_whitespace().any(|p| p == "nav"));
    if let Some(item) = nav {
        let entry = resolve(dir, &item.href);
        if let Ok(xml) = read_entry_string(zip, &entry) {
            let base = parent_dir(&entry);
            let list = parse_nav(&xml, &base, spine);
            if !list.is_empty() {
                return Some(list);
            }
        }
    }
    let ncx = opf
        .manifest
        .iter()
        .find(|i| i.media_type.contains("dtbncx") || i.href.to_ascii_lowercase().ends_with(".ncx"));
    let item = ncx?;
    let entry = resolve(dir, &item.href);
    let xml = read_entry_string(zip, &entry).ok()?;
    let base = parent_dir(&entry);
    Some(parse_ncx(&xml, &base, spine))
}

/// Percent-decoded and case-folded, so two spellings of one entry compare equal.
fn norm(path: &str) -> String {
    urlencoding::decode(path)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| path.to_string())
        .to_lowercase()
}

fn leaf(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Map an href from a nav/ncx document onto a spine index plus fragment.
///
/// The comparison is deliberately forgiving. Producers disagree about whether
/// hrefs are percent-encoded, about the case of archive entries, and about
/// which directory an NCX `src` is relative to; an exact match sends a TOC row
/// back as unresolved, which the UI can only render as a dead entry.
fn locate(base: &str, href: &str, spine: &[SpineItem]) -> (Option<usize>, Option<String>) {
    let (file, frag) = match href.split_once('#') {
        Some((f, g)) if !g.is_empty() => (f, Some(norm_fragment(g))),
        Some((f, _)) => (f, None),
        None => (href, None),
    };
    // A bare `#id` points inside the current document, which this function has
    // no way to identify; leave it unresolved rather than guessing a chapter.
    if file.is_empty() {
        return (None, frag);
    }

    let target = norm(&resolve(base, file));
    if let Some(i) = spine.iter().position(|s| norm(&s.path) == target) {
        return (Some(i), frag);
    }
    // Last resort: the file name alone. Two spine documents rarely share one.
    let name = leaf(&target).to_string();
    let idx = spine.iter().position(|s| leaf(&norm(&s.path)) == name);
    (idx, frag)
}

/// Fragments are IRIs too, so `#chapter%201` and `#chapter 1` are the same id.
fn norm_fragment(frag: &str) -> String {
    urlencoding::decode(frag)
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| frag.to_string())
}

fn parse_nav(xml: &str, base: &str, spine: &[SpineItem]) -> Vec<TocEntry> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut in_toc = false;
    let mut depth = 0usize;
    let mut pending: Option<(Option<usize>, Option<String>)> = None;
    let mut label = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => match e.name().as_ref() {
                b"nav" => {
                    // Only the `toc` nav; EPUB 3 files often carry several.
                    let ty = attr(&e, b"epub:type").or_else(|| attr(&e, b"type"));
                    in_toc = ty.as_deref().map(|t| t.contains("toc")).unwrap_or(out.is_empty());
                }
                b"ol" if in_toc => depth += 1,
                b"a" if in_toc => {
                    pending = attr(&e, b"href").map(|h| locate(base, &h, spine));
                    label.clear();
                }
                _ => {}
            },
            Ok(Event::Text(t)) if pending.is_some() => {
                label.push_str(&t.xml10_content().unwrap_or_default());
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"a" if in_toc => {
                    if let Some((spine_index, fragment)) = pending.take() {
                        let text = label.trim();
                        if !text.is_empty() {
                            out.push(TocEntry {
                                label: text.to_string(),
                                spine_index,
                                fragment,
                                depth: depth.saturating_sub(1),
                            });
                        }
                    }
                }
                b"ol" if in_toc => depth = depth.saturating_sub(1),
                b"nav" => in_toc = false,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn parse_ncx(xml: &str, base: &str, spine: &[SpineItem]) -> Vec<TocEntry> {
    let mut out = Vec::new();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    let mut depth = 0usize;
    let mut label = String::new();
    let mut in_label = false;
    let mut href: Option<String> = None;

    loop {
        match reader.read_event_into(&mut buf) {
            // `<content>` is usually self-closing but the spec doesn't require
            // it, so both event kinds have to be handled in one arm — matching
            // Start broadly first would shadow it.
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.name().as_ref() {
                b"navPoint" => {
                    depth += 1;
                    label.clear();
                    href = None;
                }
                b"text" => in_label = true,
                b"content" => href = attr(&e, b"src"),
                _ => {}
            },
            Ok(Event::Text(t)) if in_label => {
                label.push_str(&t.xml10_content().unwrap_or_default());
            }
            Ok(Event::End(e)) => match e.name().as_ref() {
                b"text" => in_label = false,
                b"navLabel" => {}
                b"navPoint" => {
                    if let Some(h) = href.take() {
                        let (spine_index, fragment) = locate(base, &h, spine);
                        let text = label.trim();
                        if !text.is_empty() {
                            out.push(TocEntry {
                                label: text.to_string(),
                                spine_index,
                                fragment,
                                depth: depth.saturating_sub(1),
                            });
                        }
                    }
                    depth = depth.saturating_sub(1);
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.as_ref() == key).map(|a| {
        a.normalized_value(quick_xml::XmlVersion::Explicit1_0)
            .map(|v| v.to_string())
            .unwrap_or_default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    #[test]
    fn strips_scripts_and_handlers() {
        let dirty = r#"<p onclick="steal()">hi</p><script>bad()</script><a href="javascript:x()">y</a>"#;
        let clean = sanitize(dirty);
        assert!(!clean.contains("<script"), "script survived: {clean}");
        assert!(!clean.contains("bad()"), "script body survived: {clean}");
        assert!(!clean.to_ascii_lowercase().contains("onclick"), "handler survived: {clean}");
        assert!(!clean.contains("javascript:"), "js url survived: {clean}");
        assert!(clean.contains("hi"), "content was lost: {clean}");
    }

    #[test]
    fn keeps_ordinary_markup_intact() {
        let html = r#"<div class="chapter"><img src="../img/a.png" alt="one"/><p>Text</p></div>"#;
        assert_eq!(sanitize(html), html);
    }

    #[test]
    fn a_bracket_inside_an_attribute_does_not_truncate_the_tag() {
        let html = r#"<img alt="before &amp; after > detail" src="fig/plate.png"/>"#;
        let clean = sanitize(html);
        assert!(clean.contains(r#"src="fig/plate.png""#), "src was lost: {clean}");
    }

    #[test]
    fn prose_brackets_and_comments_survive() {
        let html = "<p>if 5 &lt; 6 and x < y then don't stop</p><!-- a > note --><p>next</p>";
        let clean = sanitize(html);
        assert!(clean.contains("don't stop"), "text was swallowed: {clean}");
        assert!(clean.contains("<p>next</p>"), "markup after a comment was lost: {clean}");
    }

    fn spine_of(paths: &[&str]) -> Vec<SpineItem> {
        paths
            .iter()
            .enumerate()
            .map(|(index, p)| SpineItem { index, path: p.to_string(), chars: 100 })
            .collect()
    }

    #[test]
    fn toc_hrefs_resolve_despite_encoding_and_case() {
        let spine = spine_of(&["OEBPS/Text/chapter 1.xhtml", "OEBPS/Text/ch02.xhtml"]);

        // Exact.
        assert_eq!(locate("OEBPS", "Text/ch02.xhtml", &spine).0, Some(1));
        // Percent-encoded href against a plain archive entry.
        assert_eq!(locate("OEBPS", "Text/chapter%201.xhtml", &spine).0, Some(0));
        // Case that doesn't match the archive.
        assert_eq!(locate("OEBPS", "text/CH02.xhtml", &spine).0, Some(1));
        // An NCX that forgot its subdirectory: fall back to the file name.
        assert_eq!(locate("", "ch02.xhtml", &spine).0, Some(1));
    }

    #[test]
    fn toc_hrefs_carry_their_fragment() {
        let spine = spine_of(&["OEBPS/all.xhtml"]);
        let (idx, frag) = locate("OEBPS", "all.xhtml#part_two", &spine);
        assert_eq!(idx, Some(0));
        assert_eq!(frag.as_deref(), Some("part_two"));

        // A trailing '#' isn't a fragment.
        assert_eq!(locate("OEBPS", "all.xhtml#", &spine).1, None);
        // A document-relative fragment can't name a chapter on its own.
        assert_eq!(locate("OEBPS", "#somewhere", &spine).0, None);
    }

    #[test]
    fn resource_paths_cannot_escape_the_archive() {
        // `resolve` collapses traversal before the name ever reaches the zip.
        assert_eq!(resolve("", "../../etc/passwd"), "etc/passwd");
        assert_eq!(resolve("", "OEBPS/../../secret"), "secret");
    }

    #[test]
    fn restores_idpf_obfuscated_font_bytes() {
        let identifier = " urn:uuid:76571D94-E513-4D43-A279-E369313F5A0E\n";
        let mut font = b"OTTO font payload used for a deterministic round trip".to_vec();
        let original = font.clone();

        apply_idpf_obfuscation(&mut font, identifier);
        assert_ne!(&font[..4], b"OTTO");
        apply_idpf_obfuscation(&mut font, identifier);
        assert_eq!(font, original);
    }

    #[test]
    fn finds_only_idpf_obfuscated_resources() {
        let xml = r#"<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
          <enc:EncryptedData>
            <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
            <enc:CipherData><enc:CipherReference URI="OEBPS/font/book.otf"/></enc:CipherData>
          </enc:EncryptedData>
          <enc:EncryptedData>
            <enc:EncryptionMethod Algorithm="urn:unsupported"/>
            <enc:CipherData><enc:CipherReference URI="secret.bin"/></enc:CipherData>
          </enc:EncryptedData>
        </encryption>"#;
        assert_eq!(idpf_obfuscated_entries(xml), ["OEBPS/font/book.otf"]);
    }

    #[test]
    fn serves_a_deobfuscated_font_from_an_epub() {
        let identifier = "urn:uuid:76571D94-E513-4D43-A279-E369313F5A0E";
        let original = b"OTTO font payload that a browser can recognize".to_vec();
        let mut protected = original.clone();
        apply_idpf_obfuscation(&mut protected, identifier);

        let path = std::env::temp_dir().join(format!(
            "shelfmark_obfuscated_font_{}.epub",
            std::process::id()
        ));
        let mut zip = ZipWriter::new(std::fs::File::create(&path).unwrap());
        let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
        zip.start_file("mimetype", stored).unwrap();
        zip.write_all(b"application/epub+zip").unwrap();
        zip.start_file("META-INF/container.xml", deflated).unwrap();
        zip.write_all(
            br#"<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>"#,
        )
        .unwrap();
        zip.start_file("META-INF/encryption.xml", deflated).unwrap();
        zip.write_all(
            br#"<encryption xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
              <enc:EncryptedData>
                <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
                <enc:CipherData><enc:CipherReference URI="OEBPS/font/book.otf"/></enc:CipherData>
              </enc:EncryptedData>
            </encryption>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(
            format!(
                r#"<package unique-identifier="bookid" xmlns:dc="http://purl.org/dc/elements/1.1/">
                  <metadata><dc:identifier id="bookid">{identifier}</dc:identifier></metadata>
                </package>"#
            )
            .as_bytes(),
        )
        .unwrap();
        zip.start_file("OEBPS/font/book.otf", deflated).unwrap();
        zip.write_all(&protected).unwrap();
        zip.finish().unwrap();

        let (served, mime) = resource(&path, "OEBPS/font/book.otf").unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(served, original);
        assert_eq!(mime, "font/otf");
    }
}
