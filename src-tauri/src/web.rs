//! Fetch a web page for "paste a link". The webview can't fetch arbitrary sites (CORS), so Rust does it.
//! The text is extracted and treated as untrusted in the frontend: only textContent is ever kept.

use serde::Serialize;
use std::time::Duration;

const MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub final_url: String,
    pub content_type: String,
    pub html: String,
}

pub async fn fetch_page(url: &str) -> Result<Page, String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "That doesn't look like a web address.".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("Only http and https links can be opened.".into());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 Lanthorn/0.1")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(parsed).header("Accept", "text/html,application/xhtml+xml").send().await.map_err(|e| format!("Couldn't reach that page: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("The site answered with an error (HTTP {status})."));
    }
    let final_url = resp.url().to_string();
    let content_type = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
    if !content_type.is_empty() && !content_type.contains("html") && !content_type.contains("text/plain") && !content_type.contains("xml") {
        return Err(format!("That link isn't a web page ({content_type})."));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("That page is too large to import.".into());
    }
    Ok(Page { final_url, content_type, html: String::from_utf8_lossy(&bytes).into_owned() })
}
