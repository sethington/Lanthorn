//! lanthorn-world: a raea world running with no window, driven over stdin/stdout.
//!
//!   lanthorn-world --once BUNDLE.js DIR W H OUT.png [FRAME] [KEY,KEY,..]   one frame to a PNG (for testing)
//!   lanthorn-world --serve                                                  stream frames, take commands
//!
//! Commands, one JSON object per line on stdin:
//!   {"cmd":"load","bundle":"/path/scene.comp.js","dir":"/path/to/work","w":720,"h":900}
//!   {"cmd":"input","keys":["ArrowLeft"],"pointer":[x,y,true]}     pointer is null when none (x, y in scene pixels)
//!   {"cmd":"narrative","t":0.42}                                    the reader's position (null: the world runs itself)
//!   {"cmd":"fps","fps":30}   {"cmd":"quit"}
//! Output on stdout is binary packets: magic "LWF1" + u32 frame + u32 len + JPEG, and "LWE1" + u32 0 + u32 len + JSON
//! events ({"event":"ready"|"error",...}). Logs go to stderr; nothing else is written to stdout.

use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use raea_runtime_live::Live;

type R<T> = Result<T, String>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.first().map(String::as_str) {
        Some("--once") if args.len() >= 6 => once(&args[1..]),
        Some("--serve") => serve(),
        _ => Err("usage: lanthorn-world --once BUNDLE.js DIR W H OUT.png [FRAME] [KEYS] | --serve".into()),
    };
    if let Err(e) = r {
        eprintln!("lanthorn-world: {e}");
        std::process::exit(1);
    }
}

fn open(js: &Path, dir: &Path, w: u32, h: u32) -> R<(raea_gpu_device::present::Present, Live)> {
    // the GPU device and an offscreen target, then the scene on it, its 3D drawn under the page and waited for
    let stage = raea_gpu_device::present::offscreen(w, h)?;
    let mut live = Live::open_bundle(js, dir, (w, h), false)?;
    live.scene_3d();
    live.wait_3d(120.0)?;
    Ok((stage, live))
}

fn once(a: &[String]) -> R<()> {
    let (js, dir) = (PathBuf::from(&a[0]), PathBuf::from(&a[1]));
    let w: u32 = a[2].parse().map_err(|_| "bad width")?;
    let h: u32 = a[3].parse().map_err(|_| "bad height")?;
    let frame: i64 = a.get(5).and_then(|s| s.parse().ok()).unwrap_or(30);
    let keys: Vec<String> = a.get(6).map(|k| k.split(',').filter(|s| !s.is_empty()).map(String::from).collect()).unwrap_or_default();
    let (_stage, mut live) = open(&js, &dir, w, h)?;
    for f in 0..=frame {
        live.step(f, &keys, None)?;
    }
    live.save_snapshot(Path::new(&a[4]))?;
    eprintln!("wrote {} (frame {frame})", a[4]);
    Ok(())
}

enum Cmd {
    Load { js: PathBuf, dir: PathBuf, w: u32, h: u32 },
    Input { keys: Vec<String>, pointer: Option<(f64, f64, bool)> },
    Narrative(Option<f64>),
    Fps(f64),
    Quit,
}

fn parse(line: &str) -> Option<Cmd> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    Some(match v["cmd"].as_str()? {
        "load" => Cmd::Load { js: v["bundle"].as_str()?.into(), dir: v["dir"].as_str()?.into(), w: v["w"].as_u64()? as u32, h: v["h"].as_u64()? as u32 },
        "input" => Cmd::Input {
            keys: v["keys"].as_array().map(|a| a.iter().filter_map(|k| k.as_str().map(String::from)).collect()).unwrap_or_default(),
            pointer: v["pointer"].as_array().and_then(|p| Some((p.first()?.as_f64()?, p.get(1)?.as_f64()?, p.get(2)?.as_bool()?))),
        },
        "narrative" => Cmd::Narrative(v["t"].as_f64()),
        "fps" => Cmd::Fps(v["fps"].as_f64()?.clamp(1.0, 60.0)),
        "quit" => Cmd::Quit,
        _ => return None,
    })
}

fn packet(magic: &[u8; 4], n: u32, body: &[u8]) -> R<()> {
    let mut out = std::io::stdout().lock();
    out.write_all(magic).and_then(|_| out.write_all(&n.to_le_bytes())).and_then(|_| out.write_all(&(body.len() as u32).to_le_bytes())).and_then(|_| out.write_all(body)).and_then(|_| out.flush()).map_err(|e| e.to_string())
}

fn event(v: serde_json::Value) {
    let _ = packet(b"LWE1", 0, v.to_string().as_bytes());
}

fn jpeg(w: u32, h: u32, rgba: &[u8], quality: u8) -> R<Vec<u8>> {
    // the frame is opaque, so premultiplied RGBA drops its alpha as it is
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in rgba.chunks_exact(4) {
        rgb.extend_from_slice(&px[..3]);
    }
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, quality).encode(&rgb, w, h, image::ExtendedColorType::Rgb8).map_err(|e| e.to_string())?;
    Ok(out)
}

fn serve() -> R<()> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            if let Some(c) = parse(&line) {
                if tx.send(c).is_err() {
                    break;
                }
            }
        }
        let _ = tx.send(Cmd::Quit); // stdin closed: the app is gone
    });

    let mut world: Option<(raea_gpu_device::present::Present, Live, (u32, u32))> = None;
    let (mut keys, mut pointer, mut narrative): (Vec<String>, Option<(f64, f64, bool)>, Option<f64>) = (Vec::new(), None, None);
    let (mut frame, mut fps, mut next) = (0i64, 30.0f64, Instant::now());
    loop {
        loop {
            match rx.try_recv() {
                Ok(Cmd::Quit) | Err(mpsc::TryRecvError::Disconnected) => return Ok(()),
                Ok(Cmd::Load { js, dir, w, h }) => {
                    world = None; // release the old scene and its GPU target first
                    match open(&js, &dir, w, h) {
                        Ok((s, l)) => {
                            world = Some((s, l, (w, h)));
                            frame = 0;
                            event(serde_json::json!({"event": "ready", "w": w, "h": h}));
                        }
                        Err(e) => event(serde_json::json!({"event": "error", "message": e})),
                    }
                }
                Ok(Cmd::Input { keys: k, pointer: p }) => {
                    keys = k;
                    pointer = p;
                }
                Ok(Cmd::Narrative(t)) => narrative = t,
                Ok(Cmd::Fps(f)) => fps = f,
                Err(mpsc::TryRecvError::Empty) => break,
            }
        }
        if let Some((_, live, _)) = world.as_mut() {
            let mut k = keys.clone();
            if let Some(t) = narrative {
                k.push(format!("Narrative:{t:.5}")); // how the reader's position reaches the world's step
            }
            let step = live.step(frame, &k, pointer).and_then(|_| live.snapshot());
            match step {
                Ok((w, h, rgba)) => {
                    if let Err(e) = jpeg(w, h, &rgba, 82).and_then(|j| packet(b"LWF1", frame as u32, &j)) {
                        eprintln!("frame {frame}: {e}");
                        return Ok(()); // stdout closed: the app is gone
                    }
                }
                Err(e) => event(serde_json::json!({"event": "error", "message": e})),
            }
            frame += 1;
        }
        next += Duration::from_secs_f64(1.0 / fps);
        let now = Instant::now();
        if next > now {
            std::thread::sleep(next - now);
        } else {
            next = now; // behind: don't try to catch up
        }
    }
}
