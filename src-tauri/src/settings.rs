use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const JOBS: [&str; 3] = ["scan", "bible", "scene"];
const KEY_SERVICE: &str = "ai.lanthorn.app";

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    /// "agent" (a CLI that runs its own loop) or "endpoint" (OpenAI-compatible HTTP)
    pub kind: String,
    #[serde(default)]
    pub cli: Option<String>,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// an agent the user pointed us at by path; a rescan must not drop it
    #[serde(default)]
    pub manual: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Route {
    pub provider: String,
    /// model for this job; empty = the provider's default
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub providers: Vec<Provider>,
    /// job -> route
    pub routing: HashMap<String, Route>,
    #[serde(default)]
    pub initialized: bool,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

pub fn work_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("work");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Find an agent CLI the way the user's own shell would (a GUI app does not inherit the shell PATH).
pub async fn which(cli: &str) -> Option<String> {
    let out = tokio::process::Command::new("/bin/zsh")
        .args(["-lc", &format!("command -v {cli}")])
        .output()
        .await
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let last = s.lines().last().unwrap_or("").trim().to_string();
    if out.status.success() && last.starts_with('/') { Some(last) } else { None }
}

pub async fn detect_agents() -> Vec<Provider> {
    let mut found = Vec::new();
    for (cli, name) in [("claude", "Claude Code"), ("hermes", "Hermes Agent"), ("codex", "Codex CLI")] {
        if let Some(path) = which(cli).await {
            found.push(Provider {
                id: format!("agent-{cli}"),
                name: name.into(),
                kind: "agent".into(),
                cli: Some(cli.into()),
                path: Some(path),
                base_url: None,
                model: None,
                manual: false,
            });
        }
    }
    found
}

fn defaults_routing(providers: &[Provider]) -> HashMap<String, Route> {
    // prefer a provider with a working adapter: claude, then hermes, then the rest
    let pick = ["agent-claude", "agent-hermes"]
        .iter()
        .find_map(|id| providers.iter().find(|p| p.id == *id))
        .or_else(|| providers.first());
    let mut m = HashMap::new();
    if let Some(p) = pick {
        // cheap by default: these jobs are structured extraction, not deep reasoning
        let model = if p.cli.as_deref() == Some("claude") { Some("sonnet".to_string()) } else { None };
        for j in JOBS {
            m.insert(j.to_string(), Route { provider: p.id.clone(), model: model.clone() });
        }
    }
    m
}

pub async fn load(app: &AppHandle) -> Result<Settings, String> {
    let path = settings_path(app)?;
    let mut s: Settings = match std::fs::read_to_string(&path) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => Settings::default(),
    };
    if !s.initialized {
        s.providers = detect_agents().await;
        s.routing = defaults_routing(&s.providers);
        s.initialized = true;
        save(app, &s)?;
    }
    Ok(s)
}

pub fn save(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
}

// secrets live in the OS keychain, never in settings.json
fn entry(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEY_SERVICE, id).map_err(|e| e.to_string())
}

pub fn secret_set(id: &str, value: &str) -> Result<(), String> {
    entry(id)?.set_password(value).map_err(|e| e.to_string())
}

pub fn secret_get(id: &str) -> Option<String> {
    entry(id).ok()?.get_password().ok()
}

pub fn secret_delete(id: &str) -> Result<(), String> {
    match entry(id)?.delete_credential() {
        Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
