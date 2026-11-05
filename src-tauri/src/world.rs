//! The world host: raea's live runtime, loaded as a dynamic library into this process.
//!
//! liblanthorn_world.dylib (world/, built by scripts/build-world.sh) puts a Metal-backed view under the transparent webview and
//! runs a world on its own thread. It is loaded at run time, not linked: it carries the whole engine, so keeping it out of this
//! crate keeps Lanthorn's own builds fast and lets the engine run fully optimised.

use libloading::Library;
use serde_json::Value;
use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

type OpenFn = unsafe extern "C" fn(*mut c_void, *const c_char) -> *mut c_char;
type CmdFn = unsafe extern "C" fn(*const c_char) -> *mut c_char;
type FreeFn = unsafe extern "C" fn(*mut c_char);

struct Api {
    _lib: Library,
    open: OpenFn,
    cmd: CmdFn,
    free: FreeFn,
}
static API: OnceLock<Result<Api, String>> = OnceLock::new();

fn lib_path(app: &AppHandle) -> PathBuf {
    if let Ok(p) = std::env::var("LANTHORN_WORLD_LIB") {
        return p.into();
    }
    if let Ok(r) = app.path().resource_dir() {
        let bundled = r.join("world").join("liblanthorn_world.dylib");
        if bundled.exists() {
            return bundled;
        }
    }
    // development: the build script's output in a raea checkout
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("sites/raea/target/release/liblanthorn_world.dylib")
}

fn api(app: &AppHandle) -> Result<&'static Api, String> {
    API.get_or_init(|| unsafe {
        let path = lib_path(app);
        let lib = Library::new(&path).map_err(|e| format!("couldn't load the world host ({}): {e}", path.display()))?;
        let open: OpenFn = *lib.get(b"lw_open\0").map_err(|e| e.to_string())?;
        let cmd: CmdFn = *lib.get(b"lw_cmd\0").map_err(|e| e.to_string())?;
        let free: FreeFn = *lib.get(b"lw_free\0").map_err(|e| e.to_string())?;
        Ok(Api { _lib: lib, open, cmd, free })
    })
    .as_ref()
    .map_err(|e| e.clone())
}

fn take(api: &Api, p: *mut c_char) -> Result<Value, String> {
    if p.is_null() {
        return Err("the world host returned nothing".into());
    }
    let s = unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned();
    unsafe { (api.free)(p) };
    let v: Value = serde_json::from_str(&s).map_err(|e| e.to_string())?;
    if v["ok"].as_bool() == Some(true) { Ok(v["data"].clone()) } else { Err(v["error"].as_str().unwrap_or("world host error").to_string()) }
}

pub fn available(app: &AppHandle) -> bool {
    api(app).is_ok()
}

/// Run `f` on the main thread (AppKit views must be touched there) and wait for its answer.
fn on_main<T: Send + 'static>(app: &AppHandle, f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(f());
    })
    .map_err(|e| e.to_string())?;
    rx.recv_timeout(std::time::Duration::from_secs(20)).map_err(|_| "the main thread didn't answer".to_string())
}

pub fn open(app: &AppHandle, ns_window: usize, rect: Value) -> Result<Value, String> {
    let api = api(app)?;
    let json = CString::new(rect.to_string()).map_err(|e| e.to_string())?;
    let (open, free) = (api.open, api.free);
    let raw = on_main(app, move || unsafe { open(ns_window as *mut c_void, json.as_ptr()) as usize })?;
    let _ = free;
    take(api, raw as *mut c_char)
}

pub fn cmd(app: &AppHandle, body: Value) -> Result<Value, String> {
    let api = api(app)?;
    let name = body["cmd"].as_str().unwrap_or("").to_string();
    let json = CString::new(body.to_string()).map_err(|e| e.to_string())?;
    let f = api.cmd;
    // anything that touches the view must run on the main thread; input and loading need not
    let raw = if name == "rect" || name == "close" { on_main(app, move || unsafe { f(json.as_ptr()) as usize })? } else { unsafe { f(json.as_ptr()) as usize } };
    take(api, raw as *mut c_char)
}
