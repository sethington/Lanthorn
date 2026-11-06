//! Scene preparation for the live world: fetch the CC0 assets a scene needs (Poly Haven), lay out a working directory with the
//! generic runtime and the resolved scene, and bundle it (`raea bundle --composition-bundle`), cached by scene key.
//! Mirrors scripts/ph.mjs. (The baked-frame path, `raea render` to JPEG clips, was removed once the world played live.)

use crate::{llm, settings};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

// one render per scene key at a time: concurrent callers wait, then find the finished cache
static LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> = OnceLock::new();
fn key_lock(key: &str) -> Arc<tokio::sync::Mutex<()>> {
    let m = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    m.lock().unwrap().entry(key.to_string()).or_default().clone()
}

const RUNTIME: &str = include_str!("../../runtime/scene.tsx");
/// Generated art the runtime draws (scripts/make-moon.py): written into the asset folder next to the downloaded models.
macro_rules! moon {
    ($($n:literal),*) => { &[$(($n, include_bytes!(concat!("../../runtime/moon/moon_", $n, ".png")) as &[u8])),*] };
}
const MOON: &[(&str, &[u8])] = moon!("00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12", "13", "14", "15");

/// The people: Anny bodies (scripts/make-people.sh), written as media/characters/<name>/ next to the downloaded models.
macro_rules! person {
    ($($n:literal),*) => { &[$(($n, [
        ("body.glb", include_bytes!(concat!("../../runtime/characters/", $n, "/body.glb")) as &[u8]),
        ("body.hull.glb", include_bytes!(concat!("../../runtime/characters/", $n, "/body.hull.glb")) as &[u8]),
        ("joint.glb", include_bytes!(concat!("../../runtime/characters/", $n, "/joint.glb")) as &[u8]),
        ("skeleton.json", include_bytes!(concat!("../../runtime/characters/", $n, "/skeleton.json")) as &[u8]),
        ("clips.json", include_bytes!(concat!("../../runtime/characters/", $n, "/clips.json")) as &[u8]),
    ])),*] };
}
const PEOPLE: &[(&str, [(&str, &[u8]); 5])] = person!("man", "woman", "kid");

/// Release builds ship the embedded runtime. Debug builds read it from disk so editing runtime/scene.tsx
/// takes effect on the next render without a Rust rebuild (tauri dev only watches src-tauri).
fn runtime_src() -> String {
    if cfg!(debug_assertions) {
        if let Ok(s) = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../runtime/scene.tsx")) {
            return s;
        }
    }
    RUNTIME.to_string()
}

#[derive(Deserialize, Clone, Debug)]
pub struct AssetReq {
    pub kind: String,
    pub id: String,
    pub res: String,
}

fn safe(s: &str) -> bool {
    !s.is_empty() && s.len() < 120 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

async fn download(client: &reqwest::Client, url: &str, dest: &Path) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    if let Some(p) = dest.parent() {
        std::fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    let resp = client.get(url).send().await.map_err(|e| format!("{url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("{url}: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    // write via a temp name so an interrupted download never looks complete
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = dest.with_extension(format!("part{stamp}"));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, dest).map_err(|e| e.to_string())
}

fn rel_ok(rel: &str) -> bool {
    !rel.starts_with('/') && !rel.split('/').any(|p| p == ".." || p.is_empty())
}

/// The engine's image-based light isn't blurred by a surface's roughness, so a sky with a sun in it makes everything look wet and glittery
/// (a coat gets mirror highlights; the ground sparkles). The sun is the directional light's job: cap the sky's brightness so the sky
/// lights things softly. Radiance .hdr (RGBE, run-length coded) in, the same out with every pixel's brightest channel held to `CAP`.
fn tame_hdri(path: &Path) -> Result<(), String> {
    const CAP: f32 = 6.0;
    let mark = path.with_extension("hdr.tamed");
    if mark.exists() {
        return Ok(());
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    // header: lines up to a blank line, then "-Y h +X w"
    let mut pos = 0usize;
    let mut header = Vec::new();
    loop {
        let end = data[pos..].iter().position(|b| *b == b'\n').ok_or("bad hdr header")? + pos;
        let line = &data[pos..end];
        pos = end + 1;
        if line.is_empty() {
            break;
        }
        header.push(String::from_utf8_lossy(line).to_string());
    }
    let end = data[pos..].iter().position(|b| *b == b'\n').ok_or("bad hdr size line")? + pos;
    let size = String::from_utf8_lossy(&data[pos..end]).to_string();
    pos = end + 1;
    let parts: Vec<&str> = size.split_whitespace().collect();
    if parts.len() != 4 || parts[0] != "-Y" || parts[2] != "+X" {
        return Err("unsupported hdr orientation".into());
    }
    let h: usize = parts[1].parse().map_err(|_| "bad hdr height")?;
    let w: usize = parts[3].parse().map_err(|_| "bad hdr width")?;
    let mut px = vec![0u8; w * h * 4];
    for y in 0..h {
        let row = &mut px[y * w * 4..(y + 1) * w * 4];
        if (8..32768).contains(&w) && data.len() > pos + 4 && data[pos] == 2 && data[pos + 1] == 2 && (data[pos + 2] & 0x80) == 0 {
            pos += 4; // new-style RLE: each channel in turn
            for c in 0..4 {
                let mut x = 0;
                while x < w {
                    let n = *data.get(pos).ok_or("short hdr")? as usize;
                    pos += 1;
                    if n > 128 {
                        let v = *data.get(pos).ok_or("short hdr")?;
                        pos += 1;
                        for _ in 0..(n - 128) {
                            row[x * 4 + c] = v;
                            x += 1;
                        }
                    } else {
                        for _ in 0..n {
                            row[x * 4 + c] = *data.get(pos).ok_or("short hdr")?;
                            pos += 1;
                            x += 1;
                        }
                    }
                }
            }
        } else {
            let n = w * 4;
            row.copy_from_slice(data.get(pos..pos + n).ok_or("short hdr")?);
            pos += n;
        }
    }
    // cap
    for p in px.chunks_mut(4) {
        let e = p[3] as i32 - 136; // value = mantissa/256 * 2^(e-128)
        if p[3] == 0 {
            continue;
        }
        let scale = (2.0f32).powi(e);
        let m = p[0].max(p[1]).max(p[2]) as f32 * scale;
        if m > CAP {
            let k = CAP / m;
            let (r, g, b) = (p[0] as f32 * scale * k, p[1] as f32 * scale * k, p[2] as f32 * scale * k);
            let mx = r.max(g).max(b);
            if mx <= 1e-32 {
                p.copy_from_slice(&[0, 0, 0, 0]);
                continue;
            }
            // frexp
            let ex = mx.log2().floor() as i32 + 1;
            let f = (2.0f32).powi(-ex) * 256.0;
            p[0] = (r * f).min(255.0) as u8;
            p[1] = (g * f).min(255.0) as u8;
            p[2] = (b * f).min(255.0) as u8;
            p[3] = (ex + 128) as u8;
        }
    }
    // write: the same header, flat-coded through literal runs (valid RLE)
    let mut out = Vec::with_capacity(data.len() + h * 16);
    for l in &header {
        out.extend_from_slice(l.as_bytes());
        out.push(b'\n');
    }
    out.push(b'\n');
    out.extend_from_slice(format!("-Y {h} +X {w}\n").as_bytes());
    for y in 0..h {
        out.extend_from_slice(&[2, 2, (w >> 8) as u8, (w & 255) as u8]);
        for c in 0..4 {
            let mut x = 0;
            while x < w {
                let n = (w - x).min(128);
                out.push(n as u8);
                for i in 0..n {
                    out.push(px[(y * w + x + i) * 4 + c]);
                }
                x += n;
            }
        }
    }
    std::fs::write(path, out).map_err(|e| e.to_string())?;
    std::fs::write(mark, "1").map_err(|e| e.to_string())?;
    Ok(())
}

async fn fetch_asset(client: &reqwest::Client, root: &Path, a: &AssetReq) -> Result<(), String> {
    if !safe(&a.id) || !["1k", "2k"].contains(&a.res.as_str()) {
        return Err(format!("bad asset request {}/{}", a.kind, a.id));
    }
    let dir = root.join(&a.id);
    // already fetched at this resolution? (a model or sky may exist at another one)
    let want = match a.kind.as_str() {
        "hdri" => format!("{}_{}.hdr", a.id, a.res),
        "model" => format!("{}_{}.gltf", a.id, a.res),
        _ => String::new(),
    };
    if dir.join("license.json").exists() && (want.is_empty() || dir.join(&want).exists()) {
        if a.kind == "hdri" {
            let _ = tame_hdri(&dir.join(&want)); // (a sky fetched by an earlier build is capped the first time it is used)
        }
        return Ok(());
    }
    let files: Value = client
        .get(format!("https://api.polyhaven.com/files/{}", a.id))
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| format!("asset index for {}: {e}", a.id))?;
    let main;
    match a.kind.as_str() {
        "model" => {
            let g = &files["gltf"][&a.res]["gltf"];
            let url = g["url"].as_str().ok_or_else(|| format!("no glTF at {} for {}", a.res, a.id))?;
            main = url.rsplit('/').next().unwrap_or("model.gltf").to_string();
            download(client, url, &dir.join(&main)).await?;
            if let Some(inc) = g["include"].as_object() {
                for (rel, f) in inc {
                    if !rel_ok(rel) {
                        continue;
                    }
                    if let Some(u) = f["url"].as_str() {
                        download(client, u, &dir.join(rel)).await?;
                    }
                }
            }
        }
        "hdri" => {
            let url = files["hdri"][&a.res]["hdr"]["url"].as_str().ok_or_else(|| format!("no HDR at {} for {}", a.res, a.id))?;
            main = url.rsplit('/').next().unwrap_or("sky.hdr").to_string();
            download(client, url, &dir.join(&main)).await?;
            let _ = tame_hdri(&dir.join(&main));
        }
        "texture" => {
            for (key, out) in [("Diffuse", "diff.jpg"), ("nor_gl", "nor.jpg"), ("arm", "arm.jpg")] {
                let u = files[key][&a.res]["jpg"]["url"].as_str().ok_or_else(|| format!("no {key} at {} for {}", a.res, a.id))?;
                download(client, u, &dir.join(out)).await?;
            }
            main = "diff.jpg".into();
        }
        other => return Err(format!("unknown asset kind {other}")),
    }
    let lic = serde_json::json!({ "id": a.id, "source": format!("https://polyhaven.com/a/{}", a.id), "license": "CC0-1.0", "main": main });
    std::fs::write(dir.join("license.json"), lic.to_string()).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
pub struct WorldOut {
    pub bundle: String,
    pub dir: String,
}

/// Prepare a scene to run live in the embedded world: fetch its assets, lay out a working dir and bundle the
/// composition (`raea bundle --composition-bundle`, about 0.3 s). Cached by key.
pub async fn world_bundle(app: &AppHandle, key: &str, resolved: &str, assets: Vec<AssetReq>) -> Result<WorldOut, String> {
    if !safe(key) {
        return Err("bad scene key".into());
    }
    let lock = key_lock(key);
    let _guard = lock.lock().await;
    let root = cache_root(app)?;
    let work = root.join("live").join(key);
    let bundle = work.join("scene.comp.js");
    let out = WorldOut { bundle: bundle.to_string_lossy().into(), dir: work.to_string_lossy().into() };
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(300)).build().map_err(|e| e.to_string())?;
    let asset_root = root.join("assets");
    // progress for the reader: which step of making this place, and how far through it
    let say = |stage: &str, done: usize, total: usize, what: &str| {
        let _ = app.emit("world-progress", serde_json::json!({"key": key, "stage": stage, "done": done, "total": total, "what": what}));
    };
    let total = assets.len();
    for (i, a) in assets.iter().enumerate() {
        say("assets", i, total, &a.id);
        fetch_asset(&client, &asset_root.join("polyhaven"), a).await?; // a no-op when already there at this resolution
    }
    say("assets", total, total, "");
    crate::package::ensure_link(app, &asset_root)?;
    {
        let dir = asset_root.join("lanthorn").join("moon");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (n, bytes) in MOON {
            let f = dir.join(format!("moon_{n}.png"));
            if std::fs::metadata(&f).map(|m| m.len() as usize != bytes.len()).unwrap_or(true) {
                std::fs::write(&f, bytes).map_err(|e| e.to_string())?;
            }
        }
    }
    for (name, files) in PEOPLE {
        let dir = asset_root.join("characters").join(name);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (f, bytes) in files {
            let path = dir.join(f);
            if std::fs::metadata(&path).map(|m| m.len() as usize != bytes.len()).unwrap_or(true) {
                std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
            }
        }
    }
    if bundle.exists() && work.join("ok").exists() {
        crate::cache::touch(&work.join("ok"));
        return Ok(out);
    }
    let _ = std::fs::remove_dir_all(&work);
    std::fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    std::fs::write(work.join("scene.tsx"), runtime_src()).map_err(|e| e.to_string())?;
    std::fs::write(work.join("scene.json"), resolved).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::os::unix::fs::symlink(&asset_root, work.join("media")).map_err(|e| e.to_string())?;
    #[cfg(not(unix))]
    return Err("live worlds on this platform aren't supported yet".into());
    say("bundle", 0, 1, "");
    let raea = settings::which("raea").await.ok_or("raea isn't installed: run  curl -fsSL https://raea.io/install | sh")?;
    let args = vec!["bundle".to_string(), "scene.tsx".into(), "--composition-bundle".into(), "-o".into(), bundle.to_string_lossy().into()];
    let (so, se, ok) = llm::run_cli(&raea, args, None, &work).await?;
    let log = format!("{so}{se}");
    if !ok || !log.contains("APPLIED") {
        return Err(format!("raea bundle failed: {}", log.lines().rev().take(4).collect::<Vec<_>>().join(" | ")));
    }
    std::fs::write(work.join("ok"), "1").map_err(|e| e.to_string())?;
    Ok(out)
}
