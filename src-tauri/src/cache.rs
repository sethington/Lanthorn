//! Cache store: generic JSON blobs (analysis results), sizes, pruning and clearing for the scene/asset caches.
//! Layout under the app cache dir: store/<ns>/<key>.json, live/<key>/{scene.comp.js,ok} (prepared worlds), assets/polyhaven/<id>/.
//! `render/` is the old baked-frame cache: nothing writes it any more, and pruning removes it.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() < 160 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.') && !s.contains("..")
}

fn root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn blob_path(app: &AppHandle, ns: &str, key: &str) -> Result<PathBuf, String> {
    if !safe(ns) || !safe(key) {
        return Err("bad cache key".into());
    }
    Ok(root(app)?.join("store").join(ns).join(format!("{key}.json")))
}

pub fn get(app: &AppHandle, ns: &str, key: &str) -> Option<String> {
    std::fs::read_to_string(blob_path(app, ns, key).ok()?).ok()
}

pub fn put(app: &AppHandle, ns: &str, key: &str, value: &str) -> Result<(), String> {
    let p = blob_path(app, ns, key)?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
    }
    // write whole-or-nothing so a crash never leaves a half-written entry
    let tmp = p.with_extension("tmp");
    std::fs::write(&tmp, value).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &p).map_err(|e| e.to_string())
}

fn dir_size(p: &Path) -> u64 {
    let mut total = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            match e.metadata() {
                Ok(m) if m.is_dir() => total += dir_size(&e.path()),
                Ok(m) => total += m.len(),
                Err(_) => {}
            }
        }
    }
    total
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub render_bytes: u64,
    pub render_scenes: u32,
    pub assets_bytes: u64,
    pub analysis_bytes: u64,
}

pub fn stats(app: &AppHandle) -> Result<Stats, String> {
    let r = root(app)?;
    let (live, old) = (r.join("live"), r.join("render"));
    let scenes = std::fs::read_dir(&live).map(|rd| rd.flatten().filter(|e| e.path().join("ok").exists()).count() as u32).unwrap_or(0);
    Ok(Stats { render_bytes: dir_size(&live) + dir_size(&old), render_scenes: scenes, assets_bytes: dir_size(&r.join("assets")), analysis_bytes: dir_size(&r.join("store")) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pruned {
    pub removed: u32,
    pub freed_bytes: u64,
}

/// Remove the old baked-frame cache, prepared worlds from other runtime versions and abandoned partial ones, then trim the
/// oldest prepared worlds to fit `max_bytes`.
pub fn prune(app: &AppHandle, version: &str, max_bytes: u64) -> Result<Pruned, String> {
    let r = root(app)?;
    let mut removed = 0u32;
    let mut freed = 0u64;
    let old = r.join("render");
    if old.exists() {
        freed += dir_size(&old);
        if std::fs::remove_dir_all(&old).is_ok() {
            removed += 1;
        }
    }
    let mut kept: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    let Ok(rd) = std::fs::read_dir(r.join("live")) else { return Ok(Pruned { removed, freed_bytes: freed }) };
    let prefix = format!("{version}-");
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let ok = p.join("ok");
        let size = dir_size(&p); // the media link is a symlink: metadata() doesn't follow it, so shared assets aren't counted
        let age = |t: SystemTime| SystemTime::now().duration_since(t).unwrap_or_default();
        let stale_version = !name.starts_with(&prefix);
        let abandoned = !ok.exists() && std::fs::metadata(&p).and_then(|m| m.modified()).map(|t| age(t) > Duration::from_secs(3600)).unwrap_or(false);
        if stale_version || abandoned {
            if std::fs::remove_dir_all(&p).is_ok() {
                removed += 1;
                freed += size;
            }
        } else if let Ok(t) = std::fs::metadata(&ok).and_then(|m| m.modified()) {
            kept.push((t, p, size));
        }
    }
    let mut total: u64 = kept.iter().map(|x| x.2).sum();
    kept.sort_by_key(|x| x.0); // oldest first
    for (_, p, size) in kept {
        if total <= max_bytes {
            break;
        }
        if std::fs::remove_dir_all(&p).is_ok() {
            total -= size;
            removed += 1;
            freed += size;
        }
    }
    Ok(Pruned { removed, freed_bytes: freed })
}

pub fn clear(app: &AppHandle, kind: &str) -> Result<u64, String> {
    let r = root(app)?;
    let dir = match kind {
        "renders" => {
            // prepared worlds, and the old baked-frame cache if it is still there
            let old = r.join("render");
            let freed = dir_size(&old) + dir_size(&r.join("live"));
            let _ = std::fs::remove_dir_all(&old);
            let _ = std::fs::remove_dir_all(r.join("live"));
            return Ok(freed);
        }
        "assets" => r.join("assets"),
        "analysis" => r.join("store"),
        _ => return Err("unknown cache kind".into()),
    };
    let size = dir_size(&dir);
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    Ok(size)
}

/// Mark a cache entry as just used, so pruning keeps what the reader is actually using.
pub fn touch(path: &Path) {
    if let Ok(f) = std::fs::OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
}
