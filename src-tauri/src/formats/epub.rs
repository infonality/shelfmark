//! EPUB extraction. An EPUB is a ZIP whose `META-INF/container.xml` points at an
//! OPF package document; the OPF carries Dublin Core metadata, a manifest of
//! files, and a reading-order spine. We read the metadata, count words across
//! the spine's content documents, and pull the cover image.

use std::io::Read;

use anyhow::{anyhow, Context, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use zip::ZipArchive;

use super::{clean, count_words, strip_tags, CoverImage, ExtractedMeta};

/// Rough words-per-page used to derive a page estimate from a real word count.
const WORDS_PER_PAGE: i64 = 275;

pub(crate) type Archive = ZipArchive<std::io::BufReader<std::fs::File>>;

pub fn extract(path: &std::path::Path) -> Result<ExtractedMeta> {
    let file = std::fs::File::open(path)?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).context("open epub zip")?;

    let opf_path = find_opf_path(&mut zip)?;
    let opf_xml = read_entry_string(&mut zip, &opf_path)?;

    let mut meta = ExtractedMeta::default();
    let opf = parse_opf(&opf_xml);

    meta.title = opf.title.as_deref().and_then(clean);
    meta.author = opf.author.as_deref().and_then(clean);
    meta.publisher = opf.publisher.as_deref().and_then(clean);
    meta.published_date = opf.date.as_deref().and_then(clean);
    meta.language = opf.language.as_deref().and_then(clean);
    meta.isbn = opf.isbn.as_deref().and_then(clean);
    meta.description = opf
        .description
        .as_deref()
        .map(|s| clean(&strip_tags(s)).unwrap_or_default())
        .filter(|s| !s.is_empty());
    if !opf.subjects.is_empty() {
        meta.subjects = Some(opf.subjects.join(", "));
    }

    let opf_dir = parent_dir(&opf_path);

    // Word count across the spine's content documents.
    let mut words = 0i64;
    for idref in &opf.spine {
        let Some(item) = opf.manifest.iter().find(|i| &i.id == idref) else { continue };
        let is_content = item.media_type.contains("xhtml")
            || item.media_type.contains("html")
            || item.href.ends_with(".xhtml")
            || item.href.ends_with(".html")
            || item.href.ends_with(".htm");
        if !is_content {
            continue;
        }
        let entry = resolve(&opf_dir, &item.href);
        if let Ok(html) = read_entry_string(&mut zip, &entry) {
            words += count_words(&strip_tags(&html));
        }
    }
    if words > 0 {
        meta.words = Some(words);
        meta.words_estimated = false;
        // EPUBs have no fixed pagination; estimate for progress tracking.
        meta.pages = Some(((words + WORDS_PER_PAGE - 1) / WORDS_PER_PAGE).max(1));
    }

    meta.cover = read_cover(&mut zip, &opf, &opf_dir);

    Ok(meta)
}

/// Read only the embedded cover. Used to repair libraries scanned by an older
/// parser without decompressing and counting every chapter again at startup.
pub fn extract_cover(path: &std::path::Path) -> Result<Option<CoverImage>> {
    let file = std::fs::File::open(path)?;
    let mut zip = ZipArchive::new(std::io::BufReader::new(file)).context("open epub zip")?;
    let opf_path = find_opf_path(&mut zip)?;
    let opf_xml = read_entry_string(&mut zip, &opf_path)?;
    let opf = parse_opf(&opf_xml);
    Ok(read_cover(&mut zip, &opf, &parent_dir(&opf_path)))
}

fn read_cover(zip: &mut Archive, opf: &Opf, opf_dir: &str) -> Option<CoverImage> {
    let href = cover_href(opf)?;
    let entry = resolve(opf_dir, &href);
    let bytes = read_entry_bytes(zip, &entry).ok()?;
    if bytes.is_empty() {
        None
    } else {
        Some(CoverImage { bytes, ext: image_ext(&href) })
    }
}

// ---------- OPF parsing ----------

#[derive(Default)]
pub(crate) struct ManifestItem {
    pub id: String,
    pub href: String,
    pub media_type: String,
    pub properties: String,
}

#[derive(Default)]
pub(crate) struct Opf {
    pub title: Option<String>,
    pub author: Option<String>,
    pub publisher: Option<String>,
    pub date: Option<String>,
    pub language: Option<String>,
    pub isbn: Option<String>,
    pub description: Option<String>,
    pub subjects: Vec<String>,
    /// Value of the package's unique identifier. Besides identifying the
    /// publication, EPUB uses this as the key material for obfuscated fonts.
    pub unique_identifier: Option<String>,
    pub manifest: Vec<ManifestItem>,
    pub spine: Vec<String>,
    /// `<meta name="cover" content="ID"/>` (epub2 cover pointer).
    pub cover_meta_id: Option<String>,
}

pub(crate) fn parse_opf(xml: &str) -> Opf {
    let mut opf = Opf::default();
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    // Which dc: element's text we're currently collecting.
    let mut cur: Option<&'static str> = None;
    // Whether the current dc:identifier looks like an ISBN.
    let mut ident_is_isbn = false;
    let mut unique_identifier_id: Option<String> = None;
    let mut current_identifier_id: Option<String> = None;
    let mut first_identifier: Option<String> = None;
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                // XML namespace prefixes are arbitrary. Most EPUBs use a
                // default OPF namespace, but valid packages may spell these
                // as `<opf:item>` / `<opf:itemref>` instead. Match the local
                // name so both forms describe the same package.
                match e.local_name().as_ref() {
                    b"package" => unique_identifier_id = attr(&e, b"unique-identifier"),
                    b"title" => cur = Some("title"),
                    b"creator" => {
                        if opf.author.is_none() {
                            cur = Some("author");
                        }
                    }
                    b"publisher" => cur = Some("publisher"),
                    b"date" => {
                        if opf.date.is_none() {
                            cur = Some("date");
                        }
                    }
                    b"language" => cur = Some("language"),
                    b"description" => cur = Some("description"),
                    b"subject" => cur = Some("subject"),
                    b"identifier" => {
                        cur = Some("identifier");
                        current_identifier_id = attr(&e, b"id");
                        ident_is_isbn = attr(&e, b"opf:scheme")
                            .or_else(|| attr(&e, b"scheme"))
                            .map(|s| s.to_ascii_lowercase().contains("isbn"))
                            .unwrap_or(false);
                    }
                    b"item" => opf.manifest.push(read_manifest_item(&e)),
                    b"meta" => read_meta(&e, &mut opf),
                    b"itemref" => {
                        if let Some(idref) = attr(&e, b"idref") {
                            opf.spine.push(idref);
                        }
                    }
                    _ => {}
                }
            }
            // Some producers emit manifest items / metas as self-closing tags.
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                b"item" => opf.manifest.push(read_manifest_item(&e)),
                b"meta" => read_meta(&e, &mut opf),
                b"itemref" => {
                    if let Some(idref) = attr(&e, b"idref") {
                        opf.spine.push(idref);
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) => {
                if let Some(field) = cur {
                    let text = t.xml10_content().unwrap_or_default().to_string();
                    if field == "identifier" {
                        if first_identifier.is_none() {
                            first_identifier = Some(text.clone());
                        }
                        if current_identifier_id.as_deref() == unique_identifier_id.as_deref()
                            && unique_identifier_id.is_some()
                        {
                            opf.unique_identifier = Some(text.clone());
                        }
                    }
                    store_dc(&mut opf, field, &text, ident_is_isbn);
                }
            }
            Ok(Event::End(_)) => {
                cur = None;
                current_identifier_id = None;
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    if opf.unique_identifier.is_none() {
        opf.unique_identifier = first_identifier;
    }
    opf
}

fn store_dc(opf: &mut Opf, field: &str, text: &str, ident_is_isbn: bool) {
    match field {
        "title" if opf.title.is_none() => opf.title = Some(text.to_string()),
        "author" => opf.author = Some(text.to_string()),
        "publisher" if opf.publisher.is_none() => opf.publisher = Some(text.to_string()),
        "date" => opf.date = Some(text.to_string()),
        "language" if opf.language.is_none() => opf.language = Some(text.to_string()),
        "description" if opf.description.is_none() => opf.description = Some(text.to_string()),
        "subject" => {
            if !text.trim().is_empty() {
                opf.subjects.push(text.trim().to_string());
            }
        }
        "identifier" => {
            let digits: String = text.chars().filter(|c| c.is_ascii_digit() || *c == 'X').collect();
            let looks_isbn = ident_is_isbn || digits.len() == 10 || digits.len() == 13;
            if opf.isbn.is_none() && looks_isbn && !digits.is_empty() {
                opf.isbn = Some(digits);
            }
        }
        _ => {}
    }
}

fn read_manifest_item(e: &quick_xml::events::BytesStart) -> ManifestItem {
    ManifestItem {
        id: attr(e, b"id").unwrap_or_default(),
        href: attr(e, b"href").unwrap_or_default(),
        media_type: attr(e, b"media-type").unwrap_or_default(),
        properties: attr(e, b"properties").unwrap_or_default(),
    }
}

fn read_meta(e: &quick_xml::events::BytesStart, opf: &mut Opf) {
    // epub2 cover pointer: <meta name="cover" content="cover-id"/>
    if attr(e, b"name").as_deref() == Some("cover") {
        if let Some(content) = attr(e, b"content") {
            opf.cover_meta_id = Some(content);
        }
    }
}

fn cover_href(opf: &Opf) -> Option<String> {
    // epub3: manifest item flagged properties="cover-image".
    if let Some(item) = opf
        .manifest
        .iter()
        .find(|i| i.properties.split_whitespace().any(|p| p == "cover-image"))
    {
        return Some(item.href.clone());
    }
    // epub2: manifest item whose id matches the cover meta pointer.
    if let Some(id) = &opf.cover_meta_id {
        if let Some(item) = opf.manifest.iter().find(|i| &i.id == id) {
            return Some(item.href.clone());
        }
    }
    // Last resort: any image whose id/href hints at "cover".
    opf.manifest
        .iter()
        .find(|i| {
            i.media_type.starts_with("image/")
                && (i.id.to_ascii_lowercase().contains("cover")
                    || i.href.to_ascii_lowercase().contains("cover"))
        })
        .map(|i| i.href.clone())
}

fn attr(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| a.key.as_ref() == key).map(|a| {
        a.normalized_value(quick_xml::XmlVersion::Explicit1_0)
            .map(|v| v.to_string())
            .unwrap_or_default()
    })
}

// ---------- zip helpers ----------

pub(crate) fn find_opf_path(zip: &mut Archive) -> Result<String> {
    let container = read_entry_string(zip, "META-INF/container.xml")?;
    let mut reader = Reader::from_str(&container);
    let mut buf = Vec::new();
    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.local_name().as_ref() == b"rootfile" => {
                if let Some(fp) = attr(&e, b"full-path") {
                    return Ok(fp);
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    Err(anyhow!("no rootfile in container.xml"))
}

pub(crate) fn read_entry_bytes(zip: &mut Archive, name: &str) -> Result<Vec<u8>> {
    let decoded = urlencoding::decode(name).map(|c| c.into_owned()).unwrap_or_else(|_| name.to_string());
    // Try the exact name, then a URL-decoded variant.
    for candidate in [name.to_string(), decoded.clone()] {
        if let Ok(mut f) = zip.by_name(&candidate) {
            let mut out = Vec::new();
            f.read_to_end(&mut out)?;
            return Ok(out);
        }
    }

    // Plenty of EPUBs were assembled on a case-insensitive filesystem, so an
    // href reads `Images/Cover.jpg` while the archive holds `images/cover.jpg`.
    // The zip index is exact, so scan it before giving up — a missed image is
    // otherwise invisible, and this only runs on the failure path.
    let wanted = decoded.to_lowercase();
    let mut found = None;
    for i in 0..zip.len() {
        if let Ok(f) = zip.by_index(i) {
            if f.name().to_lowercase() == wanted {
                found = Some(f.name().to_string());
                break;
            }
        }
    }
    if let Some(actual) = found {
        let mut f = zip.by_name(&actual)?;
        let mut out = Vec::new();
        f.read_to_end(&mut out)?;
        return Ok(out);
    }

    Err(anyhow!("entry not found: {name}"))
}

pub(crate) fn read_entry_string(zip: &mut Archive, name: &str) -> Result<String> {
    let bytes = read_entry_bytes(zip, name)?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

// ---------- path helpers ----------

pub(crate) fn parent_dir(path: &str) -> String {
    match path.rfind('/') {
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

/// Resolve an OPF-relative href to a zip entry path, collapsing `.`/`..`.
pub(crate) fn resolve(base_dir: &str, href: &str) -> String {
    let href = href.split(['#', '?']).next().unwrap_or(href);
    let combined = if base_dir.is_empty() {
        href.to_string()
    } else {
        format!("{base_dir}/{href}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in combined.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn image_ext(href: &str) -> String {
    let lower = href.to_ascii_lowercase();
    for ext in ["jpg", "jpeg", "png", "gif", "webp", "svg"] {
        if lower.ends_with(&format!(".{ext}")) {
            return if ext == "jpeg" { "jpg".into() } else { ext.into() };
        }
    }
    "jpg".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    use zip::{CompressionMethod, ZipWriter};

    #[test]
    fn parses_namespace_prefixed_opf_manifest_and_spine() {
        let xml = r#"<?xml version="1.0"?>
            <opf:package xmlns:opf="http://www.idpf.org/2007/opf"
                         xmlns:dc="http://purl.org/dc/elements/1.1/">
              <opf:metadata>
                <dc:title>Prefixed Book</dc:title>
                <dc:creator>An Author</dc:creator>
              </opf:metadata>
              <opf:manifest>
                <opf:item id="chapter" href="Text/chapter.xhtml"
                          media-type="application/xhtml+xml"/>
                <opf:item id="cover" href="Images/cover.jpg"
                          media-type="image/jpeg" properties="cover-image"/>
              </opf:manifest>
              <opf:spine>
                <opf:itemref idref="chapter"/>
              </opf:spine>
            </opf:package>"#;

        let opf = parse_opf(xml);
        assert_eq!(opf.title.as_deref(), Some("Prefixed Book"));
        assert_eq!(opf.author.as_deref(), Some("An Author"));
        assert_eq!(opf.manifest.len(), 2);
        assert_eq!(opf.manifest[0].href, "Text/chapter.xhtml");
        assert_eq!(opf.spine, ["chapter"]);
        assert_eq!(cover_href(&opf).as_deref(), Some("Images/cover.jpg"));
    }

    #[test]
    fn reads_the_package_unique_identifier_for_font_obfuscation() {
        let xml = r#"<package unique-identifier="bookid"
                     xmlns:dc="http://purl.org/dc/elements/1.1/">
          <metadata>
            <dc:identifier id="isbn">9780000000000</dc:identifier>
            <dc:identifier id="bookid">urn:uuid:76571D94-E513-4D43-A279-E369313F5A0E</dc:identifier>
          </metadata>
        </package>"#;
        let opf = parse_opf(xml);
        assert_eq!(
            opf.unique_identifier.as_deref(),
            Some("urn:uuid:76571D94-E513-4D43-A279-E369313F5A0E")
        );
    }

    #[test]
    fn extracts_cover_from_namespace_prefixed_package() {
        let path = std::env::temp_dir().join(format!(
            "shelfmark_prefixed_cover_{}.epub",
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
        zip.start_file("OEBPS/content.opf", deflated).unwrap();
        zip.write_all(
            br#"<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
              <opf:manifest>
                <opf:item id="cover" href="Images/cover.jpg" media-type="image/jpeg"
                          properties="cover-image"/>
              </opf:manifest>
              <opf:spine/>
            </opf:package>"#,
        )
        .unwrap();
        zip.start_file("OEBPS/Images/cover.jpg", deflated).unwrap();
        zip.write_all(b"cover bytes").unwrap();
        zip.finish().unwrap();

        let cover = extract_cover(&path).unwrap().expect("cover should be found");
        std::fs::remove_file(&path).ok();
        assert_eq!(cover.ext, "jpg");
        assert_eq!(cover.bytes, b"cover bytes");
    }
}
