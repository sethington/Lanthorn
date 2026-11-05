//! The user's imported books. Lives in the app *data* dir (not the cache): clearing caches never deletes books.
//! library/<id>.json holds one book; library/index.json holds the metadata list.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    pub id: String,
    pub title: String,
    pub author: String,
    pub chapters: u32,
    pub updated: u64,
    /// where it came from: epub, text, markdown, html or url
    #[serde(default)]
    pub kind: String,
}

fn safe(id: &str) -> bool {
    !id.is_empty() && id.len() < 120 && id != "index" && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app.path().app_data_dir().map_err(|e| e.to_string())?.join("library");
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

fn read_index(app: &AppHandle) -> Vec<Meta> {
    dir(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join("index.json")).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn write_atomic(path: &PathBuf, text: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn write_index(app: &AppHandle, items: &[Meta]) -> Result<(), String> {
    let text = serde_json::to_string(items).map_err(|e| e.to_string())?;
    write_atomic(&dir(app)?.join("index.json"), &text)
}

pub fn list(app: &AppHandle) -> Vec<Meta> {
    let mut v = read_index(app);
    v.sort_by(|a, b| b.updated.cmp(&a.updated));
    v
}

pub fn get(app: &AppHandle, id: &str) -> Option<String> {
    if !safe(id) {
        return None;
    }
    std::fs::read_to_string(dir(app).ok()?.join(format!("{id}.json"))).ok()
}

pub fn save(app: &AppHandle, id: &str, json: &str) -> Result<Meta, String> {
    if !safe(id) {
        return Err("bad book id".into());
    }
    let v: Value = serde_json::from_str(json).map_err(|e| format!("not a book: {e}"))?;
    let meta = Meta {
        id: id.to_string(),
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        author: v["author"].as_str().unwrap_or("").to_string(),
        chapters: v["chapters"].as_array().map(|a| a.len() as u32).unwrap_or(0),
        kind: v["source"]["kind"].as_str().unwrap_or("").to_string(),
        updated: SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    };
    write_atomic(&dir(app)?.join(format!("{id}.json")), json)?;
    let mut items = read_index(app);
    items.retain(|m| m.id != id);
    items.push(meta.clone());
    write_index(app, &items)?;
    Ok(meta)
}

pub fn delete(app: &AppHandle, id: &str) -> Result<(), String> {
    if !safe(id) {
        return Err("bad book id".into());
    }
    let _ = std::fs::remove_file(dir(app)?.join(format!("{id}.json")));
    let mut items = read_index(app);
    items.retain(|m| m.id != id);
    write_index(app, &items)
}
