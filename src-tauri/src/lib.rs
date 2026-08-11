//! Shelfmark — personal library and reader for ebooks and comics. Rust core entry point:
//! wires up SQLite state, the HTTP client, and the Tauri command surface.

mod comics;
mod commands;
mod covers;
mod db;
mod error;
mod formats;
mod metadata;
mod models;
mod pdf;
mod pdfcover;
mod reader;
mod scanner;

use std::sync::Mutex;
use std::time::Duration;

use commands::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Serves entries out of an open book's archive: an EPUB's stylesheets,
        // images and embedded fonts so the publisher's own typography renders as
        // intended, and a comic's pages. URLs look like
        // `<base>/<book id>/<path inside the zip>`.
        // The book's location comes from the library, never from the request,
        // and `reader::resource` only resolves entries that exist in the zip.
        .register_uri_scheme_protocol("bookres", |ctx, request| {
            let empty = |code: u16| {
                tauri::http::Response::builder()
                    .status(code)
                    .body(Vec::new())
                    .unwrap()
            };
            let raw = request.uri().path().trim_start_matches('/').to_string();
            let decoded = urlencoding::decode(&raw)
                .map(|c| c.into_owned())
                .unwrap_or(raw);
            let Some((id_str, entry)) = decoded.split_once('/') else {
                return empty(400);
            };
            let Ok(id) = id_str.parse::<i64>() else {
                return empty(400);
            };

            let state = ctx.app_handle().state::<AppState>();
            let book = match state.conn.lock() {
                Ok(conn) => db::get_book(&conn, id).ok().flatten(),
                Err(_) => None,
            };
            let Some(book) = book else {
                return empty(404);
            };
            let book_path = std::path::Path::new(&book.path);

            // A PDF has no archive to serve entries from: its pages are
            // rasterised on demand instead, at the width the reader asks for.
            if book.format.eq_ignore_ascii_case("pdf") {
                let Some(index) = pdf::page_index(entry) else {
                    return empty(404);
                };
                let width = pdf::width_from_query(request.uri().query());
                return match pdf::page_png(id, book_path, index, width) {
                    Ok(png) => tauri::http::Response::builder()
                        .header("Content-Type", "image/png")
                        .header("Cache-Control", "max-age=3600")
                        .body(png.to_vec())
                        .unwrap(),
                    Err(_) => empty(404),
                };
            }

            match reader::resource(book_path, entry) {
                Ok((bytes, mime)) => tauri::http::Response::builder()
                    .header("Content-Type", mime)
                    .header("Cache-Control", "max-age=3600")
                    .body(bytes)
                    .unwrap(),
                Err(_) => empty(404),
            }
        })
        .setup(|app| {
            // Library DB + cover cache live in the platform app-data dir.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("library.db");
            let conn = db::open(&db_path)
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            let covers_dir = data_dir.join("covers");
            std::fs::create_dir_all(&covers_dir).ok();

            // In release bundles the per-OS PDFium library ships in the resource
            // dir; point the renderer at it (dev falls back to the working dir).
            if let Ok(resource_dir) = app.path().resource_dir() {
                pdfcover::set_search_dir(resource_dir);
            }

            let http = reqwest::Client::builder()
                .user_agent("Shelfmark/0.4 (personal library manager)")
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;

            app.manage(AppState {
                conn: Mutex::new(conn),
                http,
                covers_dir,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::list_books,
            commands::get_book,
            commands::list_categories,
            commands::dashboard_stats,
            commands::scan_library,
            commands::update_book,
            commands::set_status,
            commands::set_progress,
            commands::set_rating,
            commands::open_book,
            commands::reader_open,
            commands::reader_chapter,
            commands::reader_save_position,
            commands::reader_search,
            commands::comic_open,
            commands::pdf_open,
            commands::pdf_text,
            commands::pdf_search,
            commands::set_reading_direction,
            commands::list_annotations,
            commands::add_annotation,
            commands::update_annotation,
            commands::delete_annotation,
            commands::delete_book,
            commands::search_metadata,
            commands::apply_metadata,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
