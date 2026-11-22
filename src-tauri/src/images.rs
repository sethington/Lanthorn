//! Images for Markdown documents: read a local file, fetch a web image, keep an inserted or pasted one (next to the document, or in the app's own
//! folder for a document that lives only in the library). Only png, jpeg, gif, webp and bmp, checked by their first bytes and not their names, and size-capped.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct ImageData {
    pub bytes: Vec<u8>,
    pub mime: String,
}

const MAX_LOCAL: u64 = 25_000_000;
const MAX_REMOTE: usize = 15_000_000;

fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.len() > 12 && b.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(("image/png", "png"))
    } else if b.len() > 3 && b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if b.starts_with(b"GIF8") {
        Some(("image/gif", "gif"))
    } else if b.len() > 12 && &b[..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if b.starts_with(b"BM") && b.len() > 30 {
        Some(("image/bmp", "bmp"))
    } else {
        None
    }
}

fn expand(p: &str) -> PathBuf {
    let p = p.trim().strip_prefix("file://").unwrap_or(p.trim());
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

fn checked(bytes: Vec<u8>) -> Result<ImageData, String> {
    match sniff(&bytes) {
        Some((mime, _)) => Ok(ImageData { bytes, mime: mime.into() }),
        None => Err("That isn't a PNG, JPEG, GIF, WebP or BMP image.".into()),
    }
}

pub fn read(path: &str) -> Result<ImageData, String> {
    let p = expand(path);
    let m = std::fs::metadata(&p).map_err(|_| format!("Can't open {}", p.display()))?;
    if !m.is_file() || m.len() > MAX_LOCAL {
        return Err("That isn't an image file under 25 MB.".into());
    }
    checked(std::fs::read(&p).map_err(|e| e.to_string())?)
}

pub async fn fetch(url: &str) -> Result<ImageData, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That doesn't look like a web address.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https images can be loaded.".into());
    }
    let client = reqwest::Client::builder().timeout(Duration::from_secs(25)).redirect(reqwest::redirect::Policy::limited(6)).user_agent("Lanthorn/0.2").build().map_err(|e| e.to_string())?;
    let resp = client.get(parsed).header("Accept", "image/*").send().await.map_err(|e| format!("Couldn't reach that image: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("The site answered with an error (HTTP {}).", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REMOTE {
        return Err("That image is too large.".into());
    }
    checked(bytes.to_vec())
}

/// The folder for images of documents that live only in the library.
pub fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("images");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn plain_name(n: &str) -> bool {
    !n.is_empty() && n.len() < 120 && !n.starts_with('.') && n.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub fn stored(app: &AppHandle, name: &str) -> Result<ImageData, String> {
    if !plain_name(name) {
        return Err("Bad image name.".into());
    }
    read(&store_dir(app)?.join(name).to_string_lossy())
}

fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let clean: String = stem.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' }).collect::<String>().trim_matches('-').chars().take(60).collect();
    let stem = if clean.is_empty() { "image".to_string() } else { clean };
    let mut p = dir.join(format!("{stem}.{ext}"));
    let mut n = 1;
    while p.exists() {
        p = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    p
}

fn dest(app: &AppHandle, dir: Option<String>) -> Result<PathBuf, String> {
    match dir {
        Some(d) if !d.trim().is_empty() => {
            let p = expand(&d);
            std::fs::create_dir_all(&p).map_err(|e| format!("Couldn't make {}: {e}", p.display()))?;
            Ok(p)
        }
        _ => store_dir(app),
    }
}

/// Copy an image file next to the document (`dest_dir`), or into the app's folder; returns the name it was stored under.
pub fn import(app: &AppHandle, src: &str, dest_dir: Option<String>) -> Result<String, String> {
    let img = read(src)?;
    let (_, ext) = sniff(&img.bytes).ok_or("Not an image")?;
    let stem = expand(src).file_stem().and_then(|s| s.to_str()).unwrap_or("image").to_string();
    let to = unique(&dest(app, dest_dir)?, &stem, ext);
    std::fs::write(&to, &img.bytes).map_err(|e| format!("Couldn't save the image: {e}"))?;
    Ok(to.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_string())
}

/// Keep the bytes of a pasted or dropped image; returns the name it was stored under.
pub fn save(app: &AppHandle, bytes: Vec<u8>, dest_dir: Option<String>, stem: Option<String>) -> Result<String, String> {
    if bytes.len() as u64 > MAX_LOCAL {
        return Err("That image is too large.".into());
    }
    let (_, ext) = sniff(&bytes).ok_or("That isn't a PNG, JPEG, GIF, WebP or BMP image.")?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let to = unique(&dest(app, dest_dir)?, &stem.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| format!("image-{now}")), ext);
    std::fs::write(&to, &bytes).map_err(|e| format!("Couldn't save the image: {e}"))?;
    Ok(to.file_name().and_then(|n| n.to_str()).unwrap_or("image").to_string())
}
