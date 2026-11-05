use crate::settings::{self, Provider, Settings};
use serde::Serialize;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::AsyncWriteExt;

const TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    /// what the provider says the call cost, when it says (the Claude CLI does)
    pub cost: f64,
}

fn usage_of(v: &Value) -> Usage {
    let u = &v["usage"];
    let n = |k: &str| u[k].as_u64().unwrap_or(0);
    Usage {
        input: n("input_tokens") + n("prompt_tokens"),
        output: n("output_tokens") + n("completion_tokens"),
        cache_read: n("cache_read_input_tokens"),
        cache_write: n("cache_creation_input_tokens"),
        cost: v["total_cost_usd"].as_f64().unwrap_or(0.0),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Completion {
    pub text: String,
    pub provider_id: String,
    /// the model that actually answered, when the provider says
    pub model: String,
    pub ms: u128,
    pub usage: Usage,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub ms: u128,
    pub sample: String,
    pub model: String,
    pub error: Option<String>,
}

pub fn resolve<'a>(s: &'a Settings, job: &str) -> Result<(&'a Provider, Option<String>), String> {
    let route = s
        .routing
        .get(job)
        .ok_or_else(|| format!("no provider routed for job '{job}': pick one in Settings"))?;
    let p = s
        .providers
        .iter()
        .find(|p| p.id == route.provider)
        .ok_or_else(|| format!("provider '{}' no longer exists: pick another in Settings", route.provider))?;
    let model = route.model.clone().filter(|m| !m.is_empty()).or_else(|| p.model.clone().filter(|m| !m.is_empty()));
    Ok((p, model))
}

/// Run a command through the user's login shell so node/python resolve as they do in a terminal.
pub async fn run_cli(path: &str, args: Vec<String>, stdin: Option<&str>, cwd: &std::path::Path) -> Result<(String, String, bool), String> {
    let mut cmd = tokio::process::Command::new("/bin/zsh");
    cmd.arg("-lc").arg("exec \"$@\"").arg("lanthorn").arg(path);
    cmd.args(args);
    cmd.current_dir(cwd);
    cmd.stdin(std::process::Stdio::piped());
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start {path}: {e}"))?;
    if let Some(mut si) = child.stdin.take() {
        if let Some(text) = stdin {
            let _ = si.write_all(text.as_bytes()).await;
        }
        drop(si);
    }
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("timed out after {}s", TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    Ok((
        String::from_utf8_lossy(&out.stdout).to_string(),
        String::from_utf8_lossy(&out.stderr).to_string(),
        out.status.success(),
    ))
}

async fn complete_agent(app: &AppHandle, p: &Provider, model: Option<&str>, system: &str, user: &str) -> Result<(String, Option<String>, Usage), String> {
    let cwd = settings::work_dir(app)?;
    let path = p.path.clone().ok_or("agent has no path")?;
    match p.cli.as_deref() {
        Some("claude") => {
            // tools off, no session, no user hooks/plugins; our system prompt replaces the (large) default
            let mut args: Vec<String> = ["-p", "--tools", "", "--no-session-persistence", "--setting-sources", "", "--output-format", "json", "--system-prompt"]
                .iter()
                .map(|s| s.to_string())
                .collect();
            args.push(system.to_string());
            if let Some(m) = model {
                args.push("--model".into());
                args.push(m.to_string());
            }
            let (out, err, ok) = run_cli(&path, args, Some(user), &cwd).await?;
            let v: Value = serde_json::from_str(out.trim()).map_err(|_| format!("claude returned non-JSON: {}", trunc(&format!("{out}{err}"))))?;
            if v["is_error"].as_bool().unwrap_or(!ok) {
                return Err(v["result"].as_str().unwrap_or("claude reported an error").to_string());
            }
            let used = v["modelUsage"].as_object().and_then(|m| m.keys().next().cloned());
            let usage = usage_of(&v);
            v["result"].as_str().map(|s| (s.to_string(), used, usage)).ok_or_else(|| "claude returned no result".into())
        }
        Some("hermes") => {
            let prompt = format!("{system}\n\n{user}");
            let mut args: Vec<String> = vec!["-z".into(), prompt];
            if let Some(m) = model {
                args.push("-m".into());
                args.push(m.to_string());
            }
            let (out, err, ok) = run_cli(&path, args, None, &cwd).await?;
            if !ok || out.trim().is_empty() {
                return Err(trunc(&format!("{out}{err}")));
            }
            if out.contains("API call failed") {
                return Err(trunc(&out));
            }
            Ok((out.trim().to_string(), None, Usage::default()))
        }
        Some("codex") => {
            // `codex exec` reads the prompt from stdin ("-"), runs in a read-only sandbox, and writes the final
            // message to a file, which is cleaner than scraping its progress output. Untested until a Codex is installed.
            let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let out_file = cwd.join(format!("codex-{stamp}.txt"));
            let mut args: Vec<String> = ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--output-last-message"].iter().map(|s| s.to_string()).collect();
            args.push(out_file.to_string_lossy().to_string());
            if let Some(m) = model {
                args.push("-m".into());
                args.push(m.to_string());
            }
            args.push("-".into());
            let prompt = format!("{system}\n\n{user}");
            let (out, err, ok) = run_cli(&path, args, Some(&prompt), &cwd).await?;
            let last = std::fs::read_to_string(&out_file).ok();
            let _ = std::fs::remove_file(&out_file);
            match last.map(|t| t.trim().to_string()).filter(|t| !t.is_empty()) {
                Some(t) => Ok((t, None, Usage::default())),
                None if ok && !out.trim().is_empty() => Ok((out.trim().to_string(), None, Usage::default())),
                None => Err(trunc(&format!("codex gave no answer. {err}{out}"))),
            }
        }
        Some(other) => Err(format!("the {other} adapter isn't built yet")),
        None => Err("agent has no cli".into()),
    }
}

async fn complete_endpoint(p: &Provider, model: Option<&str>, system: &str, user: &str) -> Result<(String, Usage), String> {
    let base = p.base_url.clone().filter(|b| !b.is_empty()).ok_or("endpoint has no base URL")?;
    let model = model.map(|m| m.to_string()).ok_or("endpoint has no model: set one in Settings")?;
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let client = reqwest::Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())?;
    let key = settings::secret_get(&p.id);
    let attempt = |json_mode: bool| {
        let mut body = json!({
            "model": model,
            "temperature": 0.2,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        });
        if json_mode {
            body["response_format"] = json!({"type": "json_object"});
        }
        let mut req = client.post(&url).json(&body);
        if let Some(k) = &key {
            req = req.bearer_auth(k);
        }
        req
    };
    let mut resp = attempt(true).send().await.map_err(|e| format!("can't reach {url}: {e}"))?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        // some local servers reject response_format; retry plain
        resp = attempt(false).send().await.map_err(|e| e.to_string())?;
    }
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", trunc(&text)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("non-JSON reply: {}", trunc(&text)))?;
    let usage = usage_of(&v);
    v["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| (s.to_string(), usage))
        .ok_or_else(|| format!("no content in reply: {}", trunc(&text)))
}

fn trunc(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() > 400 { format!("{}…", t.chars().take(400).collect::<String>()) } else { t.to_string() }
}

pub async fn complete_with(app: &AppHandle, p: &Provider, model: Option<String>, system: &str, user: &str) -> Result<Completion, String> {
    let t = Instant::now();
    let asked = model.clone().unwrap_or_default();
    let (text, used, usage) = match p.kind.as_str() {
        "agent" => complete_agent(app, p, model.as_deref(), system, user).await?,
        "endpoint" => { let (x, u) = complete_endpoint(p, model.as_deref(), system, user).await?; (x, None, u) }
        other => return Err(format!("unknown provider kind '{other}'")),
    };
    Ok(Completion { text, provider_id: p.id.clone(), model: used.unwrap_or(asked), ms: t.elapsed().as_millis(), usage })
}

pub async fn test(app: &AppHandle, p: &Provider, model: Option<String>) -> TestResult {
    let t = Instant::now();
    match complete_with(app, p, model, "Reply with JSON only.", "{\"reply\":\"ok\"}").await {
        Ok(c) => TestResult { ok: true, ms: c.ms, sample: trunc(&c.text), model: c.model, error: None },
        Err(e) => TestResult { ok: false, ms: t.elapsed().as_millis(), sample: String::new(), model: String::new(), error: Some(e) },
    }
}

/// Ask an OpenAI-compatible server which models it offers (GET {base}/models). Uses the saved key for a saved
/// provider, or the one passed for a not-yet-saved endpoint.
pub async fn endpoint_models(provider: Option<&Provider>, base_url: Option<String>, key: Option<String>) -> Result<Vec<String>, String> {
    let base = provider
        .and_then(|p| p.base_url.clone())
        .or(base_url)
        .filter(|b| !b.is_empty())
        .ok_or("no base URL")?;
    let key = provider.and_then(|p| settings::secret_get(&p.id)).or(key).filter(|k| !k.is_empty());
    let url = format!("{}/models", base.trim_end_matches('/'));
    let client = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let mut req = client.get(&url);
    if let Some(k) = key {
        req = req.bearer_auth(k);
    }
    let resp = req.send().await.map_err(|e| format!("can't reach {url}: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", trunc(&text)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| format!("non-JSON reply: {}", trunc(&text)))?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .or_else(|| v["models"].as_array()) // some local servers use "models"
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().or_else(|| m["name"].as_str()).map(String::from)).collect())
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Err("the server returned no models".into());
    }
    Ok(ids)
}

/// Ask a vision question about one image. Only the Claude Code CLI can do this here: it is given the Read tool and the image's folder.
pub async fn describe_image(app: &AppHandle, p: &Provider, model: Option<String>, system: &str, user: &str, image: &std::path::Path) -> Result<Completion, String> {
    let t = Instant::now();
    if p.kind != "agent" || p.cli.as_deref() != Some("claude") {
        return Err("looking at pictures needs the Claude Code CLI as the model".into());
    }
    let dir = image.parent().ok_or("bad image path")?.to_string_lossy().to_string();
    let path = p.path.clone().ok_or("agent has no path")?;
    let cwd = settings::work_dir(app)?;
    let mut args: Vec<String> = ["-p", "--tools", "Read", "--allowedTools", "Read", "--add-dir", dir.as_str(), "--no-session-persistence", "--setting-sources", "", "--output-format", "json", "--system-prompt"]
        .iter()
        .map(|x| x.to_string())
        .collect();
    args.push(system.to_string());
    if let Some(m) = model.as_deref() {
        args.push("--model".into());
        args.push(m.to_string());
    }
    let prompt = format!("{user}\n\nThe picture is the file {}. Read it, then answer.", image.display());
    let (out, err, ok) = run_cli(&path, args, Some(&prompt), &cwd).await?;
    let v: Value = serde_json::from_str(out.trim()).map_err(|_| format!("claude returned non-JSON: {}", trunc(&format!("{out}{err}"))))?;
    if v["is_error"].as_bool().unwrap_or(!ok) {
        return Err(v["result"].as_str().unwrap_or("claude reported an error").to_string());
    }
    let used = v["modelUsage"].as_object().and_then(|m| m.keys().next().cloned());
    let usage = usage_of(&v);
    let text = v["result"].as_str().ok_or("claude returned no result")?.to_string();
    Ok(Completion { text, provider_id: p.id.clone(), model: used.unwrap_or_else(|| model.unwrap_or_default()), ms: t.elapsed().as_millis(), usage })
}
