//! A grep over a folder of the writer's own files (Markdown and text), for the editor's writing helper: the lines that mention the terms,
//! best first. Read-only, never follows symlinks, skips hidden folders, and stops at sane limits.

use serde::Serialize;
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct FileHit {
    pub path: String,
    pub name: String,
    pub line: usize,
    pub text: String,
    pub score: f32,
}

fn expand(dir: &str) -> PathBuf {
    if let Some(rest) = dir.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(dir)
}

fn mentions(line: &str, term: &str) -> bool {
    // case-insensitive; a term that starts with a letter or digit must start a word
    let mut from = 0;
    while let Some(i) = line[from..].find(term) {
        let at = from + i;
        let starts_word = term.chars().next().map(|c| !c.is_alphanumeric()).unwrap_or(true) || line[..at].chars().next_back().map(|c| !c.is_alphanumeric()).unwrap_or(true);
        if starts_word {
            return true;
        }
        from = at + term.len();
        if from >= line.len() {
            break;
        }
    }
    false
}

pub fn grep(dir: &str, terms: &[String], max: usize) -> Result<Vec<FileHit>, String> {
    let root = expand(dir.trim());
    let meta = std::fs::symlink_metadata(&root).map_err(|_| format!("Can't open {}", root.display()))?;
    if !meta.is_dir() {
        return Err(format!("{} is not a folder", root.display()));
    }
    let terms: Vec<String> = terms.iter().map(|t| t.trim().to_lowercase()).filter(|t| t.chars().count() >= 3).take(8).collect();
    if terms.is_empty() {
        return Ok(vec![]);
    }
    let t0 = Instant::now();
    let mut stack = vec![(root.clone(), 0usize)];
    let mut files = 0usize;
    let mut hits: Vec<FileHit> = vec![];
    while let Some((d, depth)) = stack.pop() {
        if t0.elapsed() > Duration::from_secs(4) || files > 5000 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            let Ok(m) = std::fs::symlink_metadata(e.path()) else { continue };
            if m.file_type().is_symlink() {
                continue;
            }
            if m.is_dir() {
                if depth < 6 {
                    stack.push((e.path(), depth + 1));
                }
                continue;
            }
            let ext = e.path().extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if !matches!(ext.as_str(), "md" | "markdown" | "mdx" | "txt") || m.len() > 2_000_000 {
                continue;
            }
            files += 1;
            let Ok(text) = std::fs::read_to_string(e.path()) else { continue };
            let lines: Vec<&str> = text.lines().collect();
            let mut per: Vec<FileHit> = vec![];
            for (i, l) in lines.iter().enumerate() {
                if l.trim().is_empty() {
                    continue;
                }
                let low = l.to_lowercase();
                let mut s = terms.iter().filter(|t| mentions(&low, t)).count() as f32;
                if s == 0.0 {
                    continue;
                }
                let near = format!("{} {}", if i > 0 { lines[i - 1] } else { "" }, lines.get(i + 1).copied().unwrap_or("")).to_lowercase();
                s += terms.iter().filter(|t| mentions(&near, t)).count() as f32 * 0.25;
                let shown: String = l.trim().chars().take(240).collect();
                per.push(FileHit { path: e.path().to_string_lossy().to_string(), name: name.clone(), line: i + 1, text: shown, score: s });
            }
            per.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
            hits.extend(per.into_iter().take(2));
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal).then(a.path.cmp(&b.path)));
    hits.truncate(max.clamp(1, 12));
    Ok(hits)
}

#[derive(Serialize)]
pub struct FileText {
    pub text: String,
    pub path: String,
    /// modified time, milliseconds since the epoch: a later save checks it so an outside edit is never overwritten unseen
    pub mtime: u64,
}

fn text_ext(p: &std::path::Path) -> bool {
    matches!(p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase().as_str(), "md" | "markdown" | "mdx" | "txt")
}

fn mtime_of(p: &std::path::Path) -> u64 {
    std::fs::metadata(p).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Read a Markdown or text file the writer opened (up to 5 MB).
pub fn read(path: &str) -> Result<FileText, String> {
    let p = expand(path.trim());
    if !text_ext(&p) {
        return Err("Only .md, .markdown, .mdx and .txt files can be opened here.".into());
    }
    let m = std::fs::metadata(&p).map_err(|_| format!("Can't open {}", p.display()))?;
    if !m.is_file() || m.len() > 5_000_000 {
        return Err("That isn't a text file under 5 MB.".into());
    }
    let text = std::fs::read_to_string(&p).map_err(|_| "That file isn't UTF-8 text.".to_string())?;
    Ok(FileText { text, path: p.to_string_lossy().to_string(), mtime: mtime_of(&p) })
}

/// Save to a Markdown or text file. `expect` is the modified time from when the file was read: if the file has changed since, nothing is written
/// ("changed"), so an edit made elsewhere is never overwritten without the writer seeing it. Written to a temporary file and renamed, so a crash never leaves half a file.
pub fn write(path: &str, text: &str, expect: Option<u64>) -> Result<u64, String> {
    let p = expand(path.trim());
    if !text_ext(&p) {
        return Err("Only .md, .markdown, .mdx and .txt files can be saved here.".into());
    }
    if let (Some(e), true) = (expect, p.exists()) {
        if mtime_of(&p) != e {
            return Err("changed".into());
        }
    }
    let dir = p.parent().ok_or("No folder for that file")?;
    let tmp = dir.join(format!(".{}.lanthorn-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("Couldn't save: {e}") })?;
    Ok(mtime_of(&p))
}

/// Save the bytes of a PDF the editor made, to the path the writer chose (a .pdf only; written to a temporary file and renamed).
pub fn write_pdf(path: &str, bytes: &[u8]) -> Result<u64, String> {
    let p = expand(path.trim());
    if p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase() != "pdf" {
        return Err("A PDF must be saved with the .pdf extension.".into());
    }
    if bytes.len() < 8 || &bytes[..5] != b"%PDF-" {
        return Err("That isn't a PDF.".into());
    }
    let dir = p.parent().ok_or("No folder for that file")?;
    let tmp = dir.join(format!(".{}.lanthorn-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, bytes).map_err(|e| format!("Couldn't write: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("Couldn't save: {e}") })?;
    Ok(bytes.len() as u64)
}

/// Save a web page the editor made from a document (an .html or .htm only; written to a temporary file and renamed).
pub fn write_html(path: &str, text: &str) -> Result<u64, String> {
    let p = expand(path.trim());
    if !matches!(p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase().as_str(), "html" | "htm") {
        return Err("A web page must be saved with the .html extension.".into());
    }
    if !text.contains("<html") {
        return Err("That isn't a web page.".into());
    }
    let dir = p.parent().ok_or("No folder for that file")?;
    let tmp = dir.join(format!(".{}.lanthorn-tmp", p.file_name().and_then(|n| n.to_str()).unwrap_or("file")));
    std::fs::write(&tmp, text).map_err(|e| format!("Couldn't write: {e}"))?;
    std::fs::rename(&tmp, &p).map_err(|e| { let _ = std::fs::remove_file(&tmp); format!("Couldn't save: {e}") })?;
    Ok(text.len() as u64)
}
