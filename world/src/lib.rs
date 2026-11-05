//! lanthorn-world as a library, loaded into Lanthorn's own process.
//!
//! It puts a Metal-backed view *under* the app's (transparent) webview and runs a raea world on its own thread,
//! presenting straight into that view's layer: no window of its own, no readback, no compression.
//! Lanthorn talks to it through three C functions carrying JSON:
//!
//!   lw_open(nswindow, {"x","y","w","h"})   create the view at a rect (CSS points, top-left origin). MAIN THREAD.
//!   lw_cmd({"cmd": ...})                    "load" {bundle,dir,w,h} | "input" {...} | "rect" {x,y,w,h} (MAIN THREAD) | "close" (MAIN THREAD)
//!   lw_free(ptr)                            free a string a call returned
//! Every call returns a JSON string: {"ok":true,...} or {"ok":false,"error":"..."}.

use std::ffi::{c_char, c_void, CStr, CString};
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use objc2::encode::{Encode, Encoding};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use raea_runtime_live::Live;

#[repr(C)]
#[derive(Clone, Copy)]
struct Pt { x: f64, y: f64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Sz { w: f64, h: f64 }
#[repr(C)]
#[derive(Clone, Copy)]
struct Rc { o: Pt, s: Sz }
unsafe impl Encode for Pt { const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]); }
unsafe impl Encode for Sz { const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]); }
unsafe impl Encode for Rc { const ENCODING: Encoding = Encoding::Struct("CGRect", &[Pt::ENCODING, Sz::ENCODING]); }

#[derive(Clone, Default)]
struct Input {
    keys: Vec<String>,
    pointer: Option<(f64, f64, bool)>, // normalised 0..1 across the world
    narrative: Option<f64>,
    shot: Option<(i64, f64)>,
    fade: f64,
    control: bool,
}

enum Msg {
    Load { js: PathBuf, dir: PathBuf, w: u32, h: u32 },
    Input(Input),
    Size(u32, u32),
    Fps(f64),
    Snap(PathBuf),
    Quit,
}

struct Host {
    tx: mpsc::Sender<Msg>,
    view: usize,
    content: usize,
    window: usize,
    scale: f64,
    thread: Option<std::thread::JoinHandle<()>>,
}

static HOST: Mutex<Option<Host>> = Mutex::new(None);

fn ok(v: serde_json::Value) -> *mut c_char {
    out(serde_json::json!({"ok": true, "data": v}))
}
fn err(e: impl std::fmt::Display) -> *mut c_char {
    out(serde_json::json!({"ok": false, "error": e.to_string()}))
}
fn out(v: serde_json::Value) -> *mut c_char {
    CString::new(v.to_string()).unwrap_or_default().into_raw()
}
fn text(p: *const c_char) -> Result<serde_json::Value, String> {
    if p.is_null() {
        return Err("null argument".into());
    }
    let s = unsafe { CStr::from_ptr(p) }.to_str().map_err(|e| e.to_string())?;
    serde_json::from_str(s).map_err(|e| format!("bad JSON: {e}"))
}

#[unsafe(no_mangle)]
pub extern "C" fn lw_free(p: *mut c_char) {
    if !p.is_null() {
        drop(unsafe { CString::from_raw(p) });
    }
}

/// CSS points (top-left origin, inside the page) -> an NSView frame (bottom-left origin, in the window's content view).
/// The page starts below the title bar (the web view spans the whole window but insets its content), so the page's top is
/// the top of the window's `contentLayoutRect`, not of the content view.
unsafe fn frame_for(content: *mut AnyObject, x: f64, y: f64, w: f64, h: f64) -> Rc {
    let win: *mut AnyObject = unsafe { msg_send![content, window] };
    let cf: Rc = unsafe { msg_send![content, frame] };
    let mut base = Rc { o: Pt { x: 0.0, y: 0.0 }, s: cf.s };
    if !win.is_null() {
        let clr: Rc = unsafe { msg_send![win, contentLayoutRect] };
        if clr.s.h > 1.0 && clr.s.h <= cf.s.h + 0.5 {
            base = clr;
        }
    }
    Rc { o: Pt { x: base.o.x + x, y: base.o.y + base.s.h - (y + h) }, s: Sz { w, h } }
}

#[unsafe(no_mangle)]
pub extern "C" fn lw_open(window: *mut c_void, json: *const c_char) -> *mut c_char {
    let args = match text(json) {
        Ok(v) => v,
        Err(e) => return err(e),
    };
    let mut host = HOST.lock().unwrap();
    if host.is_some() {
        return err("a world is already open");
    }
    let (x, y, w, h) = (args["x"].as_f64().unwrap_or(0.0), args["y"].as_f64().unwrap_or(0.0), args["w"].as_f64().unwrap_or(0.0), args["h"].as_f64().unwrap_or(0.0));
    if window.is_null() || w < 2.0 || h < 2.0 {
        return err("needs a window and a rect");
    }
    unsafe {
        let win = window as *mut AnyObject;
        let content: *mut AnyObject = msg_send![win, contentView];
        if content.is_null() {
            return err("the window has no content view");
        }
        let scale: f64 = msg_send![win, backingScaleFactor];
        let rect = frame_for(content, x, y, w, h);
        let view: *mut AnyObject = msg_send![class!(NSView), alloc];
        let view: *mut AnyObject = msg_send![view, initWithFrame: rect];
        let layer: *mut AnyObject = msg_send![class!(CAMetalLayer), layer];
        let _: *mut AnyObject = msg_send![layer, retain];
        let _: () = msg_send![layer, setOpaque: true];
        let _: () = msg_send![layer, setContentsScale: scale];
        let _: () = msg_send![view, setLayer: layer];
        let _: () = msg_send![view, setWantsLayer: true];
        // below every sibling, so the (transparent) webview and its HTML draw over the world
        let _: () = msg_send![content, addSubview: view, positioned: -1isize, relativeTo: std::ptr::null_mut::<AnyObject>()];

        let (tx, rx) = mpsc::channel::<Msg>();
        // the surface is made once at the picture's own size (or the pane's, if none is given) and is scaled to fit when the pane changes
        let (pw, ph) = match (args["pw"].as_f64(), args["ph"].as_f64()) {
            (Some(a), Some(b)) if a >= 2.0 && b >= 2.0 => (a as u32, b as u32),
            _ => ((w * scale).round() as u32, (h * scale).round() as u32),
        };
        let layer_ptr = layer as usize;
        let thread = std::thread::Builder::new().name("lanthorn-world".into()).spawn(move || render_thread(rx, layer_ptr, pw, ph)).ok();
        *host = Some(Host { tx, view: view as usize, content: content as usize, window: window as usize, scale, thread });
    }
    let scale = host.as_ref().map(|h| h.scale).unwrap_or(1.0);
    ok(serde_json::json!({"scale": scale}))
}

/// Loads sent / finished / failed, so the host can tell when a scene is on screen.
static LOADS: [std::sync::atomic::AtomicU64; 3] = [std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0), std::sync::atomic::AtomicU64::new(0)];
static FRAMES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[unsafe(no_mangle)]
pub extern "C" fn lw_cmd(json: *const c_char) -> *mut c_char {
    let v = match text(json) {
        Ok(v) => v,
        Err(e) => return err(e),
    };
    let mut guard = HOST.lock().unwrap();
    let Some(h) = guard.as_mut() else { return err("no world is open") };
    let f = |k: &str| v[k].as_f64().unwrap_or(0.0);
    match v["cmd"].as_str().unwrap_or("") {
        "load" => {
            let (Some(js), Some(dir)) = (v["bundle"].as_str(), v["dir"].as_str()) else { return err("load needs bundle and dir") };
            LOADS[0].fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let _ = h.tx.send(Msg::Load { js: js.into(), dir: dir.into(), w: f("w") as u32, h: f("h") as u32 });
            ok(serde_json::json!({}))
        }
        "input" => {
            let i = Input {
                keys: v["keys"].as_array().map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect()).unwrap_or_default(),
                pointer: v["pointer"].as_array().and_then(|p| Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?, p.get(2).map(|d| d.as_bool().unwrap_or_else(|| d.as_f64().unwrap_or(0.0) != 0.0))?))),
                narrative: v["narrative"].as_f64(),
                shot: v["shot"].as_i64().map(|s| (s, v["shotp"].as_f64().unwrap_or(0.0))),
                fade: f("fade"),
                control: v["control"].as_bool().unwrap_or(false),
            };
            let _ = h.tx.send(Msg::Input(i));
            ok(serde_json::json!({}))
        }
        "geom" => unsafe {
            let view = h.view as *mut AnyObject;
            let layer: *mut AnyObject = msg_send![view, layer];
            let vf: Rc = msg_send![view, frame];
            let vb: Rc = msg_send![view, bounds];
            let lf: Rc = msg_send![layer, frame];
            let lb: Rc = msg_send![layer, bounds];
            let lp: Pt = msg_send![layer, position];
            let ap: Pt = msg_send![layer, anchorPoint];
            let cs: f64 = msg_send![layer, contentsScale];
            let ds: Sz = msg_send![layer, drawableSize];
            let r = |c: Rc| vec![c.o.x, c.o.y, c.s.w, c.s.h];
            let content = h.content as *mut AnyObject;
            let cfr: Rc = msg_send![content, frame];
            let mut web = vec![];
            if let Some(wk) = objc2::runtime::AnyClass::get(c"WKWebView") {
                let subs: *mut AnyObject = msg_send![content, subviews];
                let n: usize = msg_send![subs, count];
                for i in 0..n {
                    let v: *mut AnyObject = msg_send![subs, objectAtIndex: i];
                    let is: bool = msg_send![v, isKindOfClass: wk];
                    let f: Rc = msg_send![v, frame];
                    web.push(serde_json::json!({"i": i, "web": is, "frame": r(f)}));
                }
            }
            let wf: Rc = msg_send![h.window as *mut AnyObject, frame];
            return ok(serde_json::json!({"content": r(cfr), "subviews": web, "window": r(wf)}));
            #[allow(unreachable_code)]
            ok(serde_json::json!({"viewFrame": r(vf), "viewBounds": r(vb), "layerFrame": r(lf), "layerBounds": r(lb), "position": [lp.x, lp.y], "anchor": [ap.x, ap.y], "contentsScale": cs, "drawable": [ds.w, ds.h], "scale": h.scale}))
        },
        "status" => {
            let o = std::sync::atomic::Ordering::SeqCst;
            ok(serde_json::json!({"sent": LOADS[0].load(o), "done": LOADS[1].load(o), "failed": LOADS[2].load(o), "frames": FRAMES.load(o)}))
        }
        "snapshot" => {
            let Some(path) = v["path"].as_str() else { return err("snapshot needs a path") };
            let _ = h.tx.send(Msg::Snap(path.into()));
            ok(serde_json::json!({}))
        }
        "fps" => {
            let _ = h.tx.send(Msg::Fps(f("fps").clamp(1.0, 60.0)));
            ok(serde_json::json!({}))
        }
        "rect" => unsafe {
            let content = h.content as *mut AnyObject;
            let rect = frame_for(content, f("x"), f("y"), f("w"), f("h"));
            // the view's root layer follows the view's frame by itself (placing it by hand sent it to the window's corner)
            let _: () = msg_send![h.view as *mut AnyObject, setFrame: rect];
            let scale: f64 = msg_send![h.window as *mut AnyObject, backingScaleFactor];
            h.scale = scale;
            let _ = h.tx.send(Msg::Size((f("w") * scale).round() as u32, (f("h") * scale).round() as u32));
            ok(serde_json::json!({}))
        },
        "close" => unsafe {
            let _ = h.tx.send(Msg::Quit);
            let view = h.view as *mut AnyObject;
            let _: () = msg_send![view, removeFromSuperview];
            // not joined: the render thread may be in the middle of loading a scene (seconds), and this runs on the app's main thread.
            // It sees Quit as soon as the load finishes and ends by itself.
            drop(h.thread.take());
            *guard = None;
            ok(serde_json::json!({}))
        },
        other => err(format!("unknown command '{other}'")),
    }
}

fn render_thread(rx: mpsc::Receiver<Msg>, layer: usize, pw: u32, ph: u32) {
    // everything the engine owns lives on this thread: its GPU device, the scene and its JavaScript
    let mut stage = match unsafe { raea_gpu_device::present::raw(wgpu::SurfaceTargetUnsafe::CoreAnimationLayer(layer as *mut c_void), pw, ph, true) } {
        Ok(s) => s,
        Err(e) => {
            eprintln!("lanthorn-world: no presenter: {e}");
            return;
        }
    };
    let mut live: Option<Live> = None;
    let mut cur_key = PathBuf::new();
    let mut parked: Vec<(PathBuf, Live)> = Vec::new();
    let keep: usize = std::env::var("LANTHORN_WORLD_CACHE").ok().and_then(|v| v.parse().ok()).unwrap_or(1);
    let mut input = Input::default();
    let (mut frame, mut fps, mut next) = (0i64, 30.0f64, Instant::now());
    loop {
        loop {
            match rx.try_recv() {
                Ok(Msg::Quit) | Err(mpsc::TryRecvError::Disconnected) => return,
                Ok(Msg::Load { js, dir, w, h }) => {
                    let _ = stage.set_transparent(false); // drops a drawable the window may be holding (a covered window never frees it)
                    // a world loaded a moment ago comes straight back: the last few are kept (LANTHORN_WORLD_CACHE, 1 by default; 0 keeps none)
                    if let Some(pos) = parked.iter().position(|(k, _)| *k == js) {
                        let (_, l) = parked.remove(pos);
                        if let Some(cur) = live.take() {
                            parked.push((cur_key.clone(), cur));
                        }
                        live = Some(l);
                        cur_key = js.clone();
                        frame = 0;
                        FRAMES.store(0, std::sync::atomic::Ordering::SeqCst);
                        LOADS[1].fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        eprintln!("lanthorn-world: back to a kept world ({} parked)", parked.len());
                        continue;
                    }
                    if let Some(cur) = live.take() {
                        if keep > 0 {
                            parked.push((cur_key.clone(), cur));
                            while parked.len() > keep {
                                parked.remove(0); // the oldest goes
                            }
                        }
                    }
                    let t0 = Instant::now();
                    match Live::open_bundle(&js, &dir, (w, h), false).and_then(|mut l| {
                        eprintln!("lanthorn-world: bundle opened in {} ms", t0.elapsed().as_millis());
                        l.scene_3d();
                        l.wait_3d(120.0)?;
                        eprintln!("lanthorn-world: assets ready in {} ms", t0.elapsed().as_millis());
                        Ok(l)
                    }) {
                        Ok(l) => {
                            live = Some(l);
                            cur_key = js.clone();
                            frame = 0;
                            FRAMES.store(0, std::sync::atomic::Ordering::SeqCst);
                            LOADS[1].fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                        Err(e) => {
                            eprintln!("lanthorn-world: load failed ({}): {e}", js.display());
                            LOADS[2].fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                        }
                    }
                }
                Ok(Msg::Input(i)) => input = i,
                // the pane changing size only moves and scales the layer: the surface keeps the size it was made at
                Ok(Msg::Size(..)) => {}
                Ok(Msg::Fps(f)) => fps = f,
                Ok(Msg::Snap(p)) => {
                    if let Some(l) = live.as_mut() {
                        if let Err(e) = l.save_snapshot(&p) {
                            eprintln!("lanthorn-world: snapshot failed: {e}");
                        }
                    }
                }
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if let Some(l) = live.as_mut() {
            let mut keys = input.keys.clone();
            if let Some(t) = input.narrative {
                keys.push(format!("Narrative:{t:.5}"));
            }
            if let Some((s, p)) = input.shot {
                keys.push(format!("Shot:{s}"));
                keys.push(format!("ShotP:{p:.5}"));
            }
            if input.fade > 0.001 {
                keys.push(format!("Fade:{:.4}", input.fade));
            }
            if input.control {
                keys.push("Control:1".into());
            }
            let pointer = input.pointer.map(|(x, y, d)| (x * l.w as f64, y * l.h as f64, d));
            if let Err(e) = l.step(frame, &keys, pointer).and_then(|_| l.present(&mut stage, true).map(|_| ())) {
                eprintln!("lanthorn-world: frame {frame}: {e}");
            }
            frame += 1;
            FRAMES.store(frame as u64, std::sync::atomic::Ordering::SeqCst);
        }
        next += Duration::from_secs_f64(1.0 / fps);
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now;
        }
    }
}
