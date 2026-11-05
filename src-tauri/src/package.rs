//! `.lanthorn` packages: a zip with a manifest, chapter text, optional pre-made scenes and bundled assets.
//! Everything in an archive is untrusted. This module is the single place that validates one: paths, sizes, file types
//! and the manifest. Only data is accepted (text, JSON, models, images); no script or executable type is ever extracted.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Cursor, Read};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};
use zip::ZipArchive;

const MAX_ENTRIES: usize = 5000;
const MAX_TOTAL: u64 = 600 * 1024 * 1024;
const MAX_ENTRY: u64 = 200 * 1024 * 1024;
const MAX_MANIFEST: u64 = 1024 * 1024;
const MAX_TEXT: u64 = 8 * 1024 * 1024;
const MAX_SCENES: u64 = 4 * 1024 * 1024;
/// the only file types an archive may put on disk (assets/). Models and their parts, textures, skies, sound.
const ASSET_EXT: &[&str] = &["gltf", "glb", "bin", "jpg", "jpeg", "png", "webp", "ktx2", "hdr", "exr", "ogg", "wav", "mp3", "json"];

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChapterDef {
    pub id: String,
    #[serde(default)]
    pub num: Option<String>,
    pub title: String,
    pub text: String,
    #[serde(default)]
    pub scenes: Option<String>,
    /// the look this chapter is drawn in (the reader can always override it)
    #[serde(default)]
    pub style: Option<String>,
}

/// The looks the app draws (src/lib/style.ts).
pub const STYLES: &[&str] = &["cinematic", "storybook", "cartoon", "dream", "noir", "pixel"];

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AssetDef {
    pub id: String,
    pub kind: String,
    pub path: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// metres; glTF has no real-world scale of its own, so the author states the height
    #[serde(default)]
    pub height: Option<f64>,
    pub license: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub license: Option<String>,
    #[serde(default)]
    pub creator: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    /// the look the author recommends for the whole book (the reader can always override it)
    #[serde(default)]
    pub style: Option<String>,
    pub chapters: Vec<ChapterDef>,
    #[serde(default)]
    pub assets: Vec<AssetDef>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedChapter {
    pub id: String,
    pub text: String,
    pub scenes: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Installed {
    pub manifest: Manifest,
    pub chapters: Vec<LoadedChapter>,
    pub assets_installed: u32,
}

fn safe_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 64 && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit()) && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// A path inside the archive: relative, no `..`, no empty parts, no backslashes, and under one of the allowed folders.
fn safe_path(p: &str, under: &str) -> bool {
    !p.is_empty()
        && !p.starts_with('/')
        && !p.contains('\\')
        && !p.contains('\0')
        && p.starts_with(under)
        && p.split('/').all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn ext_of(p: &str) -> String {
    p.rsplit('.').next().unwrap_or("").to_lowercase()
}

fn read_entry(z: &mut ZipArchive<Cursor<&[u8]>>, name: &str, max: u64) -> Result<Vec<u8>, String> {
    let mut f = z.by_name(name).map_err(|_| format!("'{name}' is listed but missing from the package"))?;
    if f.size() > max {
        return Err(format!("'{name}' is too large"));
    }
    let mut buf = Vec::new();
    // size() is declared by the archive and can lie: cap the actual read as well
    f.by_ref().take(max + 1).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > max {
        return Err(format!("'{name}' is too large"));
    }
    Ok(buf)
}

fn packages_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("packages");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

pub fn install(app: &AppHandle, bytes: &[u8]) -> Result<Installed, String> {
    let mut z = ZipArchive::new(Cursor::new(bytes)).map_err(|_| "That isn't a valid .lanthorn package (not a zip archive).".to_string())?;
    if z.len() > MAX_ENTRIES {
        return Err("This package has too many files.".into());
    }
    // pass 1: every entry's name and declared size, before reading anything
    let mut names: HashSet<String> = HashSet::new();
    let mut total: u64 = 0;
    for i in 0..z.len() {
        let f = z.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().to_string();
        if f.enclosed_name().is_none() || !safe_path(&name, "") {
            return Err(format!("Unsafe file path in package: {name}"));
        }
        if f.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) {
            return Err(format!("Symbolic links aren't allowed: {name}"));
        }
        total = total.saturating_add(f.size());
        if f.size() > MAX_ENTRY || total > MAX_TOTAL {
            return Err("This package is too large (limit 600 MB unpacked).".into());
        }
        names.insert(name);
    }

    let manifest_bytes = read_entry(&mut z, "manifest.json", MAX_MANIFEST).map_err(|_| "The package has no manifest.json.".to_string())?;
    let manifest: Manifest = serde_json::from_slice(&manifest_bytes).map_err(|e| format!("manifest.json isn't valid: {e}"))?;
    if manifest.format != "lanthorn" || manifest.version != 1 {
        return Err(format!("Unsupported package format ({} v{}). This app reads lanthorn v1.", manifest.format, manifest.version));
    }
    if !safe_id(&manifest.id) {
        return Err("manifest 'id' must be lowercase letters, digits, '-' or '_' (max 64).".into());
    }
    if manifest.title.trim().is_empty() || manifest.title.len() > 200 {
        return Err("manifest needs a 'title' (up to 200 characters).".into());
    }
    if manifest.chapters.is_empty() || manifest.chapters.len() > 2000 {
        return Err("manifest needs between 1 and 2000 chapters.".into());
    }
    for (what, st) in std::iter::once(("manifest".to_string(), &manifest.style)).chain(manifest.chapters.iter().map(|c| (format!("chapter '{}'", c.id), &c.style))) {
        if let Some(v) = st {
            if !STYLES.contains(&v.as_str()) {
                return Err(format!("{what}: style '{v}' isn't one of {}.", STYLES.join(", ")));
            }
        }
    }

    // chapters: ids unique, files present, text and scenes read within limits
    let mut seen: HashSet<&str> = HashSet::new();
    let mut chapters = Vec::new();
    for c in &manifest.chapters {
        if !safe_id(&c.id) || !seen.insert(c.id.as_str()) {
            return Err(format!("chapter id '{}' is invalid or repeated.", c.id));
        }
        if !safe_path(&c.text, "chapters/") || !names.contains(&c.text) || !(c.text.ends_with(".txt") || c.text.ends_with(".md")) {
            return Err(format!("chapter '{}': text must be a .txt or .md file under chapters/ that exists in the package.", c.id));
        }
        let text = String::from_utf8_lossy(&read_entry(&mut z, &c.text, MAX_TEXT)?).into_owned();
        let scenes = match &c.scenes {
            Some(sp) => {
                if !safe_path(sp, "scenes/") || !names.contains(sp) || !sp.ends_with(".json") {
                    return Err(format!("chapter '{}': scenes must be a .json file under scenes/ that exists in the package.", c.id));
                }
                Some(String::from_utf8_lossy(&read_entry(&mut z, sp, MAX_SCENES)?).into_owned())
            }
            None => None,
        };
        chapters.push(LoadedChapter { id: c.id.clone(), text, scenes });
    }

    // assets: declared, licensed, whitelisted types; extracted under packages/<id>/assets/
    let mut aseen: HashSet<&str> = HashSet::new();
    for a in &manifest.assets {
        if !safe_id(&a.id) || !aseen.insert(a.id.as_str()) {
            return Err(format!("asset id '{}' is invalid or repeated.", a.id));
        }
        if a.kind != "model" {
            return Err(format!("asset '{}': kind '{}' isn't supported yet (v1 supports 'model').", a.id, a.kind));
        }
        if a.license.trim().is_empty() {
            return Err(format!("asset '{}' needs a 'license' (for example CC0-1.0, CC-BY-4.0, or your own terms).", a.id));
        }
        if !safe_path(&a.path, "assets/") || !names.contains(&a.path) || !matches!(ext_of(&a.path).as_str(), "gltf" | "glb") {
            return Err(format!("asset '{}': path must be a .gltf or .glb under assets/ that exists in the package.", a.id));
        }
        if let Some(h) = a.height {
            if !(0.001..=2000.0).contains(&h) {
                return Err(format!("asset '{}': height must be between 0.001 and 2000 metres.", a.id));
            }
        }
    }
    // Validate every asset file's type BEFORE touching the disk: a refused package must never damage an installed one.
    let asset_files: Vec<String> = names.iter().filter(|n| n.starts_with("assets/")).cloned().collect();
    for name in &asset_files {
        if !ASSET_EXT.contains(&ext_of(name).as_str()) {
            return Err(format!("File type not allowed in assets/: {name} (only models, images, skies and sound; no scripts or programs)."));
        }
    }
    // Extract into a temporary folder, then swap it in, so a failure part-way leaves the old package intact.
    let root = packages_dir(app)?;
    let dest = root.join(&manifest.id);
    let staging = root.join(format!(".installing-{}", manifest.id));
    let _ = std::fs::remove_dir_all(&staging);
    let mut installed = 0u32;
    let result: Result<(), String> = (|| {
        for name in &asset_files {
            let data = read_entry(&mut z, name, MAX_ENTRY)?;
            let out = staging.join(name);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&out, data).map_err(|e| e.to_string())?;
            installed += 1;
        }
        std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?; // a package may have no assets
        Ok(())
    })();
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&staging, &dest).map_err(|e| e.to_string())?;
    Ok(Installed { manifest, chapters, assets_installed: installed })
}

pub fn remove(app: &AppHandle, id: &str) -> Result<(), String> {
    if !safe_id(id) {
        return Err("bad package id".into());
    }
    let d = packages_dir(app)?.join(id);
    if d.exists() {
        std::fs::remove_dir_all(d).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Make `<cache>/assets/pkg` point at the packages folder, so a render can reach bundled assets as `media/pkg/<id>/…`.
#[cfg(unix)]
pub fn ensure_link(app: &AppHandle, asset_root: &std::path::Path) -> Result<(), String> {
    let target = packages_dir(app)?;
    let link = asset_root.join("pkg");
    if std::fs::read_link(&link).map(|t| t == target).unwrap_or(false) {
        return Ok(());
    }
    let _ = std::fs::remove_file(&link);
    std::fs::create_dir_all(asset_root).map_err(|e| e.to_string())?;
    std::os::unix::fs::symlink(&target, &link).map_err(|e| e.to_string())
}
#[cfg(not(unix))]
pub fn ensure_link(_app: &AppHandle, _asset_root: &std::path::Path) -> Result<(), String> {
    Ok(())
}
