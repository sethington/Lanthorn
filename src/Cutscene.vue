<script setup lang="ts">
// The picture in the reader's right-hand panel: a live raea world that follows where the reader is in the text. There is no clock
// and no playback: the reading position (sentence and how far through it) is mapped through the director's timeline to a scene,
// a shot and a time of day, and the world is told. Scroll back and it winds back. Click the picture to take the camera (Esc gives
// it back).
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import Progress from "./Progress.vue";
import { api } from "./lib/api";
import { Player, buildTimeline, type Frame, type Timeline } from "./lib/director";
import { assetsNeeded, resolveScene, sceneKey, type Resolved } from "./lib/resolve";
import type { Bible, Scene } from "./lib/scene";
import type { PackageAsset } from "./lib/book";
import type { Sentence } from "./lib/text";
import { alreadyJudged, applyVerdict, budgetLeft, describeCue, isDropped, judgeSettings, parseVerdict, RUBRIC, widenFor } from "./lib/judge";

// `sid` is the sentence under the reading line, `frac` how far through it (0..1). The picture sits in the element matched by `host`.
const props = defineProps<{ sentences: Sentence[]; scenes: Scene[]; bible: Bible; pkg?: PackageAsset[]; host: string; sid: number; frac: number; styleFor?: (s: Scene) => string | undefined; styleVer?: number }>();

// The picture's shape follows the panel it lives in (portrait panel, portrait picture), so it fills the panel instead of floating
// small in it. Fixed for the life of this film: scenes are built at this size.
function panelSize(): [number, number] {
  const el = document.querySelector(props.host) as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  const a = r && r.height > 50 ? Math.min(1.78, Math.max(0.7, (r.width - 16) / (r.height - 16))) : 1.78;
  const long = 1280;
  return a >= 1 ? [long, Math.round(long / a / 2) * 2] : [Math.round((long * a) / 2) * 2, long];
}
let SIZE: [number, number] = panelSize();
let ASPECT = SIZE[0] / SIZE[1];
const hostReady = () => { const r = (document.querySelector(props.host) as HTMLElement | null)?.getBoundingClientRect(); return !!r && r.width > 60 && r.height > 60; };

let tl: Timeline = buildTimeline([], []);
let player = new Player(tl); // only used as a pure lookup: what the director says at a given time
let beatOf = new Map<number, Timeline["beats"][number]>();

/** The reading position as a time on the director's timeline. */
function targetTime(): number {
  const b = beatOf.get(props.sid) ?? tl.beats.find((x) => x.sentence > props.sid) ?? tl.beats[tl.beats.length - 1];
  if (!b) return 0;
  return b.t0 + Math.min(1, Math.max(0, props.frac)) * (b.t1 - b.t0);
}
let tNow = 0; // eased toward the target so the camera glides when the reader scrolls

// Consecutive scenes in the same place share one world: only a change of place loads a new one, so scrolling between them is
// camera moves, not a reload. A scene with no picture of its own stays in the world before it. A new chapter always starts a new group.
// The book is one endless text: scenes arrive chapter by chapter as they are analysed, so all of this is rebuilt when they do.
type Group = { id: number; scenes: number[]; t0: number; t1: number; ch: number };
const norm = (x: string) => (x ?? "").trim().toLowerCase();
const sameWorld = (a: Scene, b: Scene) => norm(a.location) === norm(b.location) && !!a.interior === !!b.interior && norm(a.weather) === norm(b.weather);
let groups: Group[] = [];
let groupOfScene = new Map<number, number>();
let localShot = new Map<object, number>();
// a group's identity: where it starts and ends in the text (stable while other chapters come and go)
const sig = (g: Group) => `${props.scenes[g.scenes[0]].from}:${props.scenes[g.scenes[g.scenes.length - 1]].to}`;
const cueKey = (g: Group, cue: { k: string; at: number }) => `${sig(g)}|c:${cue.k}:${cue.at}`;
// a group's shots, in the group's own list: the index the world's camera rigs use
const groupShots = (g: Group) => tl.shots.filter((x) => g.scenes.includes(x.scene));
let loadedSig = ""; // the group whose world is on screen
let loadedG: Group | null = null;
function build() {
  tl = buildTimeline(props.sentences, props.scenes);
  player = new Player(tl);
  beatOf = new Map(tl.beats.map((b) => [b.sentence, b]));
  const gs: Group[] = [];
  const gos = new Map<number, number>();
  let cur: Group | null = null;
  props.scenes.forEach((sc, i) => {
    const span = tl.scenes.find((x) => x.index === i);
    if (!span) return;
    const rep = cur ? props.scenes[cur.scenes.find((k) => props.scenes[k].visual) ?? cur.scenes[0]] : null;
    if (cur && cur.ch === (sc.ch ?? 0) && (!sc.visual || !rep || !rep.visual || sameWorld(rep, sc))) {
      cur.scenes.push(i);
      cur.t1 = span.t1;
    } else {
      cur = { id: gs.length, scenes: [i], t0: span.t0, t1: span.t1, ch: sc.ch ?? 0 };
      gs.push(cur);
    }
    gos.set(i, cur.id);
  });
  groups = gs;
  groupOfScene = gos;
  localShot = new Map();
  groups.forEach((g) => groupShots(g).forEach((sh, n) => localShot.set(sh, n)));
  loadedG = loadedSig ? groups.find((g) => sig(g) === loadedSig) ?? null : null;
  if (loadedSig && !loadedG) loadedSig = ""; // that place changed under us: it is loaded again
  tNow = targetTime();
}
build();

const hole = reactive({ x: 0, y: 0, w: 0, h: 0 });
const ui = reactive({ busy: false, up: false, t: 0, beat: -1, fade: 1, controlling: false, status: "Preparing the world…", error: "", phase: "" as "" | "assets" | "bundle" | "engine", pDone: 0, pTotal: 0, pWhat: "", pSince: 0 });
const frame = ref<Frame | null>(null);

// ---- fit the world's frame inside the host element (the stage panel)
function fit() {
  const el = document.querySelector(props.host) as HTMLElement | null;
  if (!el) return { x: 0, y: 0, w: 0, h: 0 };
  const r = el.getBoundingClientRect();
  let w = r.width - 16;
  let h = w / ASPECT;
  if (h > r.height - 16) { h = r.height - 16; w = h * ASPECT; }
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}
let ro: ResizeObserver | null = null;
let settleTimer = 0;
function placeWorld() {
  const r = fit();
  if (r.w < 2) return;
  Object.assign(hole, r);
  api.worldCmd({ cmd: "rect", x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => {});
}
function onResize() {
  placeWorld();
  // the page's layout settles a beat after the window stops moving: place the picture once more then
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(placeWorld, 180);
}

// ---- a group of scenes becomes one world bundle, prepared on demand
type Prep = { bundle: string; dir: string };
const preps = new Map<string, Promise<Prep>>();
const prepKeyOf = new Map<string, string>(); // group -> the key its world is prepared under (progress events carry it)
const repOf = (g: Group) => g.scenes.find((i) => props.scenes[i].visual);
function prepare(gi: number): Promise<Prep> {
  const g0 = groups[gi];
  const key0 = sig(g0);
  let p = preps.get(key0);
  if (!p) {
    const g = g0;
    const rep = props.scenes[repOf(g)!];
    const last = props.scenes[g.scenes[g.scenes.length - 1]];
    // one scene standing for the whole group: the first picture's look, running on to where the last one ends
    const whole: Scene = { ...rep, to: last.to, time: { ...rep.time, end: last.time.end } };
    const span = Math.max(0.001, g.t1 - g.t0);
    const shots = groupShots(g).map((x) => ({ shot: { from: x.from, framing: x.framing, angle: x.angle, focus: x.focus, move: x.move, into: x.into }, p0: (x.t0 - g.t0) / span, p1: (x.t1 - g.t0) / span }));
    // stage cues of every scene in the group, placed on the group's 0..1 progress by where their sentences fall in time
    const stage = g.scenes.flatMap((i) => (props.scenes[i].stage ?? []).filter((cue) => !isDropped(cueKey(g, cue))).map((cue) => {
      const b0 = beatOf.get(cue.at);
      const b1 = beatOf.get(cue.to) ?? b0;
      return { cue, p0: ((b0?.t0 ?? g.t0) - g.t0) / span, p1: ((b1?.t1 ?? g.t1) - g.t0) / span };
    }));
    // acting: each move runs from its sentence to that character's next move (or the end of its scene)
    const acting = g.scenes.flatMap((i) => {
      const list = (props.scenes[i].acting ?? []).slice().sort((a, b) => a.at - b.at);
      const sceneEnd = tl.scenes.find((x) => x.index === i)?.t1 ?? g.t1;
      return list.map((act, k) => {
        const next = list.slice(k + 1).find((n) => n.who === act.who);
        const t0 = beatOf.get(act.at)?.t0 ?? g.t0;
        const t1 = next ? (beatOf.get(next.at)?.t0 ?? sceneEnd) : sceneEnd;
        return { act, p0: (t0 - g.t0) / span, p1: (t1 - g.t0) / span };
      });
    });
    const r: Resolved = resolveScene(whole, props.bible, { pkg: props.pkg, size: SIZE, shots, stage, acting, style: props.styleFor?.(rep) });
    r.live = true;
    r.t0 = 0;
    prepKeyOf.set(key0, `${sceneKey(r)}-cut`);
    p = api.sceneWorld(`${sceneKey(r)}-cut`, JSON.stringify(r), assetsNeeded(r));
    p.catch(() => preps.delete(key0)); // a failed prepare may be retried
    preps.set(key0, p);
  }
  return p;
}

/** The group whose world should be showing for group gi: one with no picture holds the world before it. */
const failedGroups = new Map<string, number>(); // group -> failed attempts; after two, the reader makes do with a neighbour
const usable = (k: number) => repOf(groups[k]) !== undefined && (failedGroups.get(sig(groups[k])) ?? 0) < 2;
function worldGroup(gi: number): number {
  for (let k = gi; k >= 0; k--) if (usable(k)) return k;
  for (let k = gi + 1; k < groups.length; k++) if (usable(k)) return k;
  return -1;
}

let loading = false;
let wantKey = ""; // the prepare key of the place being made now
let unlistenProg: UnlistenFn | null = null;
const stats = { loads: 0, fails: 0, ms: [] as number[], hitchMax: 0, judged: 0 }; // dev: how loading went (read by the soak test)
if (import.meta.env.DEV) (window as any).__lwStats = stats;
async function loadWorld(i: number) {
  loading = true;
  const tStart = performance.now();
  const gOld = groups[i];
  const s = sig(gOld);
  try {
    ui.phase = "assets";
    ui.pDone = 0; ui.pTotal = 0; ui.pWhat = ""; ui.pSince = performance.now();
    wantKey = "";
    const pp = prepare(i); // (this sets the group's prepare key)
    wantKey = prepKeyOf.get(s) ?? "";
    const p = await pp;
    ui.phase = "engine"; ui.pSince = performance.now();
    await api.worldCmd({ cmd: "load", bundle: p.bundle, dir: p.dir, w: SIZE[0], h: SIZE[1] });
    // wait until the engine says that load is done (it can take a second or two)
    const st0 = (await api.worldCmd({ cmd: "status" })) as { sent: number; failed: number };
    for (let n = 0; n < 600; n++) {
      const st = (await api.worldCmd({ cmd: "status" })) as { done: number; failed: number };
      if (st.failed > st0.failed) throw new Error("the world couldn't load this place (see the app log)");
      if (st.done >= st0.sent) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 250)); // let the first frames reach the screen
    loadedSig = s;
    stats.loads++;
    stats.ms.push(Math.round(performance.now() - tStart));
    loadedG = groups.find((g) => sig(g) === s) ?? null;
    ui.up = true;
    ui.status = "";
    ui.error = "";
  } catch (e) {
    ui.error = String(e);
    stats.fails++;
    failedGroups.set(s, (failedGroups.get(s) ?? 0) + 1); // the loop tries again, or (after two failures) moves on without this place
  } finally {
    loading = false;
    ui.phase = "";
  }
  // get the next place's bundle ready while this one is on screen
  const gi = groups.findIndex((g) => sig(g) === s);
  if (gi >= 0) {
    const next = worldGroup(gi + 1 < groups.length ? gi + 1 : gi);
    if (next >= 0 && next !== gi) prepare(next).catch(() => {});
  }
}

// ---- input from the viewer
const keys = new Set<string>();
let pointer: [number, number, boolean] | null = null; // normalised x, y, and whether the button is down
let lastSent = 0;
function release() { ui.controlling = false; pointer = null; keys.clear(); }
function toNorm(e: MouseEvent): [number, number] {
  return [Math.min(1, Math.max(0, (e.clientX - hole.x) / hole.w)), Math.min(1, Math.max(0, (e.clientY - hole.y) / hole.h))];
}
function onDown(e: MouseEvent) { ui.controlling = true; const [x, y] = toNorm(e); pointer = [x, y, true]; }
function onMove(e: MouseEvent) {
  if (ui.controlling && pointer) { const [x, y] = toNorm(e); pointer = [x, y, pointer[2]]; }
}
function closeWorldNow() { api.worldCmd({ cmd: "close" }).catch(() => {}); }
// letting go outside the picture still ends the drag
function onUpAnywhere() { if (ui.controlling && pointer) pointer = [pointer[0], pointer[1], false]; }
function onUp(e: MouseEvent) { if (ui.controlling) { const [x, y] = toNorm(e); pointer = [x, y, false]; } }
const WORLD_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "d", "w", "s"]);
function onKeyDown(e: KeyboardEvent) {
  const tag = (e.target as HTMLElement | null)?.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
  if (e.key === "Escape") { if (ui.controlling) { release(); e.preventDefault(); } return; }
  if (ui.controlling) { const k = e.key.length === 1 ? e.key.toLowerCase() : e.key; if (WORLD_KEYS.has(k)) { keys.add(k); e.preventDefault(); } }
}
function onKeyUp(e: KeyboardEvent) { keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key); }

// ---- the loop
let raf = 0;
let last = 0;
let loops = 0;
let loopErr = "";
let lastTick = 0;
function loop(now: number) {
  loops++;
  if (lastTick) stats.hitchMax = Math.max(stats.hitchMax, now - lastTick);
  lastTick = now;
  try { step(now); } catch (e) { loopErr = String(e); }
}
function step(now: number) {
  const dt = last ? Math.min(1, (now - last) / 1000) : 0;
  last = now;
  // ease toward the reading position; a long jump (a scene list click, a chapter seek) is taken at once
  const target = targetTime();
  const gap = target - tNow;
  tNow = Math.abs(gap) > 25 ? target : tNow + gap * Math.min(1, dt * 5);
  const f = player.at(tNow);
  const gi = groupOfScene.get(f.scene) ?? -1;
  const want = gi >= 0 ? worldGroup(gi) : -1;
  const needLoad = want >= 0 && sig(groups[want]) !== loadedSig;
  if (needLoad && !loading) loadWorld(want);
  if (needLoad && ui.controlling) release(); // the reader moved to another place: the camera goes back to following the text
  frame.value = f;
  const loaded = loadedG ? groups.indexOf(loadedG) : -1;
  if (import.meta.env.DEV) (window as any).__lw = { loaded, loading, want, t: tNow, target };
  ui.t = f.t;
  ui.beat = f.beatIndex;
  // Black only until the first world is up (never the desktop through the pane). After that nothing fades: shots are camera
  // moves, and a change of place holds the last picture until the next world is ready.
  ui.fade = ui.up ? 0 : 1;
  ui.busy = needLoad;

  if (!needLoad && loadedG && now - lastSent > 30) {
    lastSent = now;
    const sh = f.shot ? (localShot.get(f.shot) ?? -1) : -1;
    const narr = loadedG ? Math.min(1, Math.max(0, (tNow - loadedG.t0) / Math.max(0.001, loadedG.t1 - loadedG.t0))) : f.sceneProgress;
    if (import.meta.env.DEV) (window as any).__lwN = { narr, shot: sh, shotp: f.shotProgress, gi: loaded, g0: loadedG?.t0, g1: loadedG?.t1 };
    // the judge's corrections for what is on screen now: a shot that was too tight, a cue that needed more room
    let widen = 0;
    if (!ui.controlling) {
      const si = f.shot ? localShot.get(f.shot) : undefined;
      if (si !== undefined) widen = widenFor(`${sig(loadedG)}|s${si}`);
      for (const i of loadedG.scenes) for (const cue of props.scenes[i].stage ?? []) if (props.sid >= cue.at && props.sid <= cue.to) widen = Math.max(widen, widenFor(cueKey(loadedG, cue)));
    }
    api.worldCmd({
      cmd: "input",
      keys: [...keys, ...(widen > 0.01 ? [`Widen:${widen.toFixed(2)}`] : [])],
      pointer: pointer ?? undefined,
      narrative: loadedG ? Math.min(1, Math.max(0, (tNow - loadedG.t0) / Math.max(0.001, loadedG.t1 - loadedG.t0))) : f.sceneProgress,
      shot: ui.controlling ? undefined : sh,
      shotp: f.shotProgress,
      control: ui.controlling,
    }).catch(() => {});
  }
}

// ---- progress of the place being made: what step, how far
const clock = ref(0);
setInterval(() => (clock.value = performance.now()), 500);
const making = computed(() => {
  if (!ui.phase) return null;
  const secs = Math.max(0, Math.round((clock.value - ui.pSince) / 1000));
  if (ui.phase === "assets") return ui.pTotal > 0 ? { title: "Gathering the models", detail: `${Math.min(ui.pDone + 1, ui.pTotal)} of ${ui.pTotal}${ui.pWhat ? " · " + ui.pWhat.replace(/_/g, " ") : ""}`, value: ui.pDone / ui.pTotal } : { title: "Preparing the place", detail: "", value: undefined };
  if (ui.phase === "bundle") return { title: "Building the place", detail: secs > 2 ? `${secs}s` : "", value: undefined };
  return { title: "Loading it into the world", detail: secs > 2 ? `${secs}s` : "", value: undefined };
});

// ---- what's on screen
const beat = computed(() => (frame.value && frame.value.beatIndex >= 0 ? tl.beats[frame.value.beatIndex] : null));
const speaker = computed(() => (beat.value && beat.value.kind !== "narration" ? beat.value.speaker : ""));

// ---- the picture judge (see lib/judge.ts): looks at what is on screen now and corrects it when it does not suit the text
let judging = false;
let judgeBroken = false;
let movedAt = performance.now();
let lastKey = "";
async function judgeTick() {
  if (judging || judgeBroken || !judgeSettings.on || !budgetLeft() || ui.controlling || loading || !loadedG || !ui.up || document.visibilityState !== "visible") return;
  const f = frame.value;
  const g = loadedG;
  const sid = props.sid;
  if (!f) return;
  let key = "";
  let kind = "shot";
  let what = "the scene the text describes";
  for (const i of g.scenes) {
    for (const cue of props.scenes[i].stage ?? []) {
      if (sid < cue.at || sid > cue.to) continue;
      // effects a still cannot show (flicker, a slow dimming, a shake, a camera move) are not judged: the judge would only guess
      if (cue.k === "flash" || cue.k === "quake" || cue.k === "cam" || (cue.k === "dim" && !(cue.how ?? "").includes("eclipse"))) continue;
      const k = cueKey(g, cue);
      if (isDropped(k) || alreadyJudged(k)) continue;
      key = k; kind = cue.k; what = describeCue(cue);
      break;
    }
    if (key) break;
  }
  if (!key) {
    const si = f.shot ? localShot.get(f.shot) : undefined;
    if (si === undefined) return;
    const k = `${sig(g)}|s${si}`;
    if (alreadyJudged(k)) return;
    key = k;
  }
  if (key !== lastKey) { lastKey = key; movedAt = performance.now(); }
  if (performance.now() - movedAt < 3500 || Math.abs(targetTime() - tNow) > 0.5) return; // the camera is still gliding: look once it has settled
  judging = true;
  try {
    const dir = await api.cacheDir();
    const path = `${dir}/judge-frame.png`;
    await api.worldCmd({ cmd: "snapshot", path });
    await new Promise((r) => setTimeout(r, 1200));
    const text = props.sentences.slice(Math.max(0, sid - 1), sid + 2).map((s) => s.text.trim()).join(" ");
    const c = await api.llmVision("judge", RUBRIC, `Text being read: "${text}"\nThe world was directed to show: ${what}.\nDoes the picture suit it?`, path);
    const v = parseVerdict(c.text);
    if (v) {
      applyVerdict(key, kind, v);
      stats.judged++;
      if (import.meta.env.DEV) fetch("/__debug", { method: "POST", body: JSON.stringify({ kind: "judge", data: { key, kind, ...v } }) }).catch(() => {});
    }
  } catch (e) {
    judgeBroken = true; // no vision model, or it failed: stop for this session rather than loop
    if (import.meta.env.DEV) fetch("/__debug", { method: "POST", body: JSON.stringify({ kind: "judge-error", data: String(e) }) }).catch(() => {});
  } finally {
    judging = false;
  }
}
let judgeTimer = 0;
onMounted(() => { judgeTimer = window.setInterval(judgeTick, 4000); });
onBeforeUnmount(() => clearInterval(judgeTimer));

watch(() => props.scenes, build);
watch(() => props.styleVer, () => {
  // the look changed: every world is made again; the old picture stays up until the new one is ready
  preps.clear();
  failedGroups.clear();
  loadedSig = "";
  loadedG = null;
});

onMounted(async () => {
  if ("__TAURI_INTERNALS__" in window) listen<{ key: string; stage: string; done: number; total: number; what: string }>("world-progress", (e) => {
    const d = e.payload;
    if (d.key !== wantKey || !loading) return;
    ui.phase = d.stage === "bundle" ? "bundle" : "assets";
    ui.pDone = d.done; ui.pTotal = d.total; ui.pWhat = d.what;
  }).then((u) => (unlistenProg = u));
  document.documentElement.classList.add("world");
  window.addEventListener("resize", onResize);
  const hostEl = document.querySelector(props.host);
  if (hostEl) { ro = new ResizeObserver(onResize); ro.observe(hostEl); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("mouseup", onUpAnywhere);
  window.addEventListener("beforeunload", closeWorldNow);
  // coming back from another screen (Settings, the Library) the page is laid out a moment after this mounts: wait for the panel to have a
  // size, then take the film's shape from it
  for (let n = 0; n < 60 && !hostReady(); n++) await new Promise((r) => setTimeout(r, 50));
  SIZE = panelSize();
  ASPECT = SIZE[0] / SIZE[1];
  Object.assign(hole, fit());
  const dbg = (m: unknown) => { if (import.meta.env.DEV) fetch("/__debug", { method: "POST", body: JSON.stringify({ kind: "cut-mount", data: m }) }).catch(() => {}); };
  dbg({ opening: { ...hole } });
  try {
    let o;
    for (let attempt = 0; ; attempt++) {
      try {
        o = await api.worldOpen(hole.x, hole.y, hole.w, hole.h, SIZE[0], SIZE[1]);
        break;
      } catch (e) {
        const msg = String(e);
        if (attempt >= 8) throw e;
        if (msg.includes("already open")) await api.worldCmd({ cmd: "close" }).catch(() => {}); // a page reload leaves the native view behind: close it and open our own
        else if (msg.includes("window and a rect")) { await new Promise((r) => setTimeout(r, 150)); Object.assign(hole, fit()); } // the panel had no size yet: look again
        else throw e;
      }
    }
    dbg({ opened: o });
    placeWorld();
  } catch (e) {
    dbg({ openFailed: String(e) });
    ui.error = `The live world isn't available: ${e}`;
    return;
  }
  // a timer, not requestAnimationFrame: the world keeps following the text even when the window is covered (the page is then 'hidden')
  raf = window.setInterval(() => loop(performance.now()), 16);
});
onBeforeUnmount(() => {
  unlistenProg?.();
  clearInterval(raf);
  ro?.disconnect();
  window.removeEventListener("resize", onResize);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("keyup", onKeyUp);
  window.removeEventListener("mouseup", onUpAnywhere);
  window.removeEventListener("beforeunload", closeWorldNow);
  api.worldCmd({ cmd: "close" }).catch(() => {});
  document.documentElement.classList.remove("world");
});

defineExpose({ ui });

// dev only: a heartbeat for the debug bridge (what the director says, and what the world reports)
let beatTimer = 0;
onMounted(() => {
  if (!import.meta.env.DEV) return;
  beatTimer = window.setInterval(async () => {
    const st = await api.worldCmd({ cmd: "status" }).catch((e) => String(e));
    fetch("/__debug", { method: "POST", body: JSON.stringify({ kind: "cut", data: { t: +ui.t.toFixed(1), sid: props.sid, frac: +props.frac.toFixed(2), scene: frame.value?.scene, shot: frame.value?.shotIndex, beat: ui.beat, fade: +ui.fade.toFixed(2), loaded: loadedG ? groups.indexOf(loadedG) : -1, loading, controlling: ui.controlling, n: (window as any).__lwN, hole: { ...hole }, size: SIZE, loops, loopErr, vis: document.visibilityState, status: ui.status, error: ui.error, world: st } }) }).catch(() => {});
  }, 2000);
});
onBeforeUnmount(() => clearInterval(beatTimer));
</script>

<template>
  <div class="cut">
    <!-- the world shows through this hole; the rest of the page is painted around it -->
    <div class="cuthole" :style="{ left: hole.x + 'px', top: hole.y + 'px', width: hole.w + 'px', height: hole.h + 'px' }" />
    <div class="frame" :style="{ left: hole.x + 'px', top: hole.y + 'px', width: hole.w + 'px', height: hole.h + 'px' }" @mousemove="onMove" @mouseup="onUp">
      <!-- clicks in the picture take the camera -->
      <div class="pick" :class="{ taking: ui.controlling }" @mousedown="onDown" />
      <div class="dim" :style="{ opacity: ui.fade }" />
      <div v-if="ui.status || ui.error" class="loading">
        <template v-if="ui.error">{{ ui.error }}</template>
        <Progress v-else big :title="making?.title ?? ui.status" :detail="making?.detail" :value="making?.value" />
      </div>
      <div v-if="ui.busy && ui.up" class="busy"><Progress :title="making?.title ?? 'Moving on…'" :detail="making?.detail" :value="making?.value" /></div>
      <div v-if="ui.controlling" class="hint">You have the camera · drag to look · W/S zoom · A/D slide · Esc to follow the text again</div>
      <div v-if="speaker && !ui.controlling" class="who">{{ speaker }}</div>
    </div>
  </div>
</template>

<style scoped>
.cut { display: contents; }
.cuthole { position: fixed; z-index: -1; border-radius: 10px; background: transparent; box-shadow: 0 0 0 200vmax var(--bg); pointer-events: none; }
.frame { position: fixed; border-radius: 10px; overflow: hidden; user-select: none; font-family: system-ui, sans-serif; color: #f2eee4; }
.pick { position: absolute; inset: 0; cursor: grab; }
.pick.taking { cursor: grabbing; }
.dim { position: absolute; inset: 0; background: #000; pointer-events: none; transition: opacity 0.12s linear; }
.loading { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; padding: 20px; color: #8b8f99; font: 12px ui-monospace, Menlo, monospace; pointer-events: none; word-break: break-word; }
.busy { position: absolute; right: 10px; bottom: 10px; background: rgba(0, 0, 0, 0.55); border-radius: 10px; padding: 8px 12px; width: 190px; font: 11px ui-monospace, Menlo, monospace; color: #b8bcc6; pointer-events: none; }
.hint { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); background: rgba(0, 0, 0, 0.55); border-radius: 99px; padding: 5px 12px; font: 11px ui-monospace, Menlo, monospace; color: #c9c4b6; pointer-events: none; white-space: nowrap; }
.who { position: absolute; left: 14px; top: 12px; font: 600 10px/1 system-ui, sans-serif; letter-spacing: 0.22em; text-transform: uppercase; color: #d8b45a; text-shadow: 0 1px 4px #000; pointer-events: none; }
</style>
