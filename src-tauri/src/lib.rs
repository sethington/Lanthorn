mod cache;
mod library;
mod package;
mod llm;
mod render;
mod settings;
mod world;
mod web;

use settings::Settings;
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Emitter, Manager};

#[tauri::command]
async fn settings_load(app: AppHandle) -> Result<Settings, String> {
    settings::load(&app).await
}

#[tauri::command]
async fn settings_save(app: AppHandle, settings: Settings) -> Result<(), String> {
    settings::save(&app, &settings)
}

/// Re-scan for installed agent CLIs; keeps providers the user added by hand.
#[tauri::command]
async fn agents_detect(app: AppHandle) -> Result<Settings, String> {
    let mut s = settings::load(&app).await?;
    let found = settings::detect_agents().await;
    s.providers.retain(|p| p.kind != "agent" || p.manual || found.iter().any(|f| f.id == p.id));
    for f in found {
        match s.providers.iter_mut().find(|p| p.id == f.id) {
            Some(existing) if !existing.manual => existing.path = f.path, // refresh path, keep the user's model choice
            Some(_) => {}
            None => s.providers.push(f),
        }
    }
    settings::save(&app, &s)?;
    Ok(s)
}

#[tauri::command]
fn secret_set(id: String, value: String) -> Result<(), String> {
    settings::secret_set(&id, &value)
}

#[tauri::command]
fn secret_exists(id: String) -> bool {
    settings::secret_get(&id).is_some()
}

#[tauri::command]
fn secret_delete(id: String) -> Result<(), String> {
    settings::secret_delete(&id)
}

#[tauri::command]
async fn llm_test(app: AppHandle, provider_id: String, model: Option<String>) -> Result<llm::TestResult, String> {
    let s = settings::load(&app).await?;
    let p = s.providers.iter().find(|p| p.id == provider_id).ok_or("unknown provider")?;
    let model = model.filter(|m| !m.is_empty()).or_else(|| p.model.clone().filter(|m| !m.is_empty()));
    Ok(llm::test(&app, p, model).await)
}

#[tauri::command]
async fn endpoint_models(app: AppHandle, provider_id: Option<String>, base_url: Option<String>, key: Option<String>) -> Result<Vec<String>, String> {
    let s = settings::load(&app).await?;
    let p = provider_id.as_ref().and_then(|id| s.providers.iter().find(|p| &p.id == id));
    llm::endpoint_models(p, base_url, key).await
}

#[tauri::command]
fn library_list(app: AppHandle) -> Vec<library::Meta> {
    library::list(&app)
}

#[tauri::command]
fn library_get(app: AppHandle, id: String) -> Option<String> {
    library::get(&app, &id)
}

#[tauri::command]
fn library_save(app: AppHandle, id: String, json: String) -> Result<library::Meta, String> {
    library::save(&app, &id, &json)
}

#[tauri::command]
fn library_delete(app: AppHandle, id: String) -> Result<(), String> {
    library::delete(&app, &id)
}

/// Install a .lanthorn package. The bytes arrive as the raw request body (not JSON), so large packages stay fast.
#[tauri::command]
fn package_install(app: AppHandle, request: tauri::ipc::Request<'_>) -> Result<package::Installed, String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => package::install(&app, bytes),
        _ => Err("expected the package's bytes".into()),
    }
}

#[tauri::command]
fn package_remove(app: AppHandle, id: String) -> Result<(), String> {
    package::remove(&app, &id)
}

#[tauri::command]
fn world_available(app: AppHandle) -> bool {
    world::available(&app)
}

/// Open the world's native view under the webview at a rect (CSS points, top-left origin).
#[tauri::command]
async fn world_open(app: AppHandle, window: tauri::WebviewWindow, x: f64, y: f64, w: f64, h: f64, pw: Option<f64>, ph: Option<f64>) -> Result<serde_json::Value, String> {
    let ptr = window.ns_window().map_err(|e| e.to_string())? as usize;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || world::open(&app2, ptr, serde_json::json!({"x": x, "y": y, "w": w, "h": h, "pw": pw, "ph": ph})))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn world_cmd(app: AppHandle, body: serde_json::Value) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || world::cmd(&app, body)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn fetch_page(url: String) -> Result<web::Page, String> {
    web::fetch_page(&url).await
}

#[tauri::command]
async fn llm_complete(app: AppHandle, job: String, system: String, user: String) -> Result<llm::Completion, String> {
    let s = settings::load(&app).await?;
    let (p, model) = llm::resolve(&s, &job)?;
    llm::complete_with(&app, p, model, &system, &user).await
}

#[tauri::command]
async fn llm_vision(app: AppHandle, job: String, system: String, user: String, image: String) -> Result<llm::Completion, String> {
    let s = settings::load(&app).await?;
    let (p, model) = llm::resolve(&s, &job)?;
    // only a picture inside the app's own folders (checked on the real path, so `..` can't get out): this can't read arbitrary files
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.canonicalize().map_err(|e| e.to_string())?;
    let path = std::path::PathBuf::from(&image).canonicalize().map_err(|e| e.to_string())?;
    if path.extension().map(|e| e != "png").unwrap_or(true) || !path.starts_with(&cache) {
        return Err("pictures must be PNGs in the app's cache folder".into());
    }
    llm::describe_image(&app, p, model, &system, &user, &path).await
}

#[tauri::command]
fn cache_dir(app: AppHandle) -> Result<String, String> {
    let d = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d.to_string_lossy().to_string())
}

#[tauri::command]
fn cache_get(app: AppHandle, ns: String, key: String) -> Option<String> {
    cache::get(&app, &ns, &key)
}

#[tauri::command]
fn cache_put(app: AppHandle, ns: String, key: String, value: String) -> Result<(), String> {
    cache::put(&app, &ns, &key, &value)
}

#[tauri::command]
fn cache_stats(app: AppHandle) -> Result<cache::Stats, String> {
    cache::stats(&app)
}

#[tauri::command]
fn cache_prune(app: AppHandle, version: String, max_bytes: u64) -> Result<cache::Pruned, String> {
    cache::prune(&app, &version, max_bytes)
}

#[tauri::command]
fn cache_clear(app: AppHandle, kind: String) -> Result<u64, String> {
    cache::clear(&app, &kind)
}

#[tauri::command]
async fn scene_world(app: AppHandle, key: String, resolved: String, assets: Vec<render::AssetReq>) -> Result<render::WorldOut, String> {
    render::world_bundle(&app, &key, &resolved, assets).await
}

#[tauri::command]
async fn render_available() -> bool {
    settings::which("raea").await.is_some()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // the standard app menu, plus "Settings…" (⌘,) under the app name, where macOS users look for it
            let handle = app.handle();
            let settings = MenuItem::with_id(handle, "open-settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
            let menu = Menu::default(handle)?;
            #[cfg(target_os = "macos")]
            if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
                // Settings… and Library… live under the app name; Open Book… (⌘O) is also under File
                let library = MenuItem::with_id(handle, "open-library", "Library…", true, Some("CmdOrCtrl+L"))?;
                app_menu.insert(&settings, 2)?;
                app_menu.insert(&library, 3)?;
                app_menu.insert(&PredefinedMenuItem::separator(handle)?, 4)?;
            }
            #[cfg(not(target_os = "macos"))]
            {
                let _ = (&settings, MenuItemKind::MenuItem, PredefinedMenuItem::separator(handle)?);
            }
            // File > Open Book… (⌘O) shows the library, where books are opened, imported or dropped
            let open_book = MenuItem::with_id(handle, "open-library", "Open Book…", true, Some("CmdOrCtrl+O"))?;
            for item in menu.items()? {
                if let MenuItemKind::Submenu(sm) = item {
                    if sm.text()? == "File" {
                        sm.insert(&open_book, 0)?;
                        sm.insert(&PredefinedMenuItem::separator(handle)?, 1)?;
                    }
                }
            }
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                match event.id().as_ref() {
                    "open-settings" => { let _ = app.emit("open-settings", ()); }
                    "open-library" => { let _ = app.emit("open-library", ()); }
                    _ => {}
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_load,
            settings_save,
            agents_detect,
            secret_set,
            secret_exists,
            secret_delete,
            llm_test,
            llm_complete,
            llm_vision,
            cache_dir,
            endpoint_models,
            library_list,
            library_get,
            library_save,
            library_delete,
            fetch_page,
            world_available,
            world_open,
            world_cmd,
            package_install,
            package_remove,
            scene_world,
            cache_get,
            cache_put,
            cache_stats,
            cache_prune,
            cache_clear,
            render_available
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
