<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import Library from "./Library.vue";
import Settings from "./Settings.vue";
import Cutscene from "./Cutscene.vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./lib/api";
import { engine, setSound, soundLevel, soundOn } from "./lib/audio";
import { lastModel, modelBadge, reloadSettings } from "./lib/state";
import { LEGACY_PROMPT_VERSIONS, PROMPT_VERSION, SYSTEM, buildUser, endState, extractJson, validateChunk, type Bible, type Scene as LlmScene } from "./lib/scene";
import type { Book } from "./lib/book";
import { importFile, importHtml, importText } from "./lib/import";
import { RUNTIME_VERSION } from "./lib/resolve";
import { hashStr, splitSentences, type Sentence } from "./lib/text";
import { DEFAULT_STYLE, STYLES, STYLE_SYSTEM, defaultStyle, effectiveStyle, getChapterOverride, getOverride, heuristicStyle, isStyle, parseStyle, setChapterOverride, setOverride, styleLabel, styleUser, type StyleId, type StyleSource } from "./lib/style";

// --- the open book: any imported book, one chapter at a time ---
const book = ref<Book | null>(null);
const chapterIdx = ref(0);
let renderGen = 0; // bumped on every chapter change: work started for the previous chapter is then ignored
const LAST_KEY = "lanthorn:last";
const posKey = (id: string) => `lanthorn:pos:${id}`;

const paragraphs = ref<string[]>([]);
const sentences = ref<Sentence[]>([]);
const sentenceEls = ref<HTMLElement[]>([]);
const scroller = ref<HTMLElement | null>(null);
const lineFrac = 0.42; // reading line height within the viewport
const opacities = ref<number[]>([]);
const status = ref("loading");
const chapterKey = ref(""); // hash of the chapter text: identity for cached analysis
const meta = reactive({ title: "", author: "" });
const chapter = reactive({ num: "", title: "" });
const titleBlock = ref<HTMLElement | null>(null);
const chapterHead = ref<HTMLElement | null>(null);
const crumbVisible = ref(false);

const activeIdx = ref(-1); // scene the reading line is in
const sceneProgress = ref(0);

let posTimer = 0;
let pendingPos: { id: string; chapter: number; sid: number } | null = null;
let restoring = false; // don't record the reset-to-top while a place is being restored
function flushPos() {
  clearTimeout(posTimer);
  if (!pendingPos) return;
  const p = pendingPos;
  pendingPos = null;
  try { localStorage.setItem(posKey(p.id), JSON.stringify({ chapter: p.chapter, sid: p.sid })); } catch { /* optional */ }
}
function savePos(sid: number) {
  if (!book.value || sid < 0 || restoring) return;
  pendingPos = { id: book.value.id, chapter: chapterIdx.value, sid };
  clearTimeout(posTimer);
  posTimer = window.setTimeout(flushPos, 400);
}
window.addEventListener("beforeunload", flushPos);

async function openBook(id: string, startChapter?: number) {
  flushPos(); // keep the place in the book we're leaving
  let b: Book | null = null;
  try {
    const raw = await api.libraryGet(id);
    b = raw ? (JSON.parse(raw) as Book) : null;
  } catch { b = null; }
  if (!b || !b.chapters?.length) { view.value = "library"; return; }
  book.value = b;
  loadStyle(b);
  meta.title = b.title;
  meta.author = b.author;
  try { localStorage.setItem(LAST_KEY, id); } catch { /* optional */ }
  let idx = startChapter ?? 0;
  let sid = -1;
  if (startChapter === undefined) {
    try {
      const p = JSON.parse(localStorage.getItem(posKey(id)) ?? "null");
      if (p) { idx = Math.min(Math.max(0, p.chapter ?? 0), b.chapters.length - 1); sid = p.sid ?? -1; }
    } catch { /* no saved place */ }
  }
  view.value = "reader";
  await nextTick();
  await openChapter(idx, sid);
}

async function openChapter(idx: number, restoreSid = -1) {
  const b = book.value;
  if (!b || idx < 0 || idx >= b.chapters.length) return;
  flushPos();
  filmReady.value = false;
  restoring = true;
  try { await openChapterInner(b, idx, restoreSid); } finally { restoring = false; }
  update(); // record the place we landed on
  await nextTick();
  filmReady.value = true; // the world starts at the reader's place
}
async function openChapterInner(b: Book, idx: number, restoreSid: number) {
  renderGen++; // abandon renders and analysis still running for the previous chapter
  analysis.running = false;
  analysis.error = "";
  chapterIdx.value = idx;
  loadChapterStyle();
  const ch = b.chapters[idx];
  chapter.num = ch.num ?? "";
  chapter.title = ch.title;
  chapterKey.value = hashStr(ch.text); // same key as before for the same text, so earlier analyses and renders still apply
  paragraphs.value = ch.paragraphs;
  sentences.value = splitSentences(ch.paragraphs);
  opacities.value = sentences.value.map(() => 0.15);
  sentenceEls.value = [];
  llmScenes.value = [];
  bible.value = { characters: [], locations: [] };
  activeIdx.value = -1;
  await nextTick();
  status.value = "ready";
  if (scroller.value) scroller.value.scrollTop = 0;
  await restoreAnalysis();
  if (restoreSid >= 0) { await nextTick(); jumpTo(restoreSid); }
  update();
  scroller.value?.focus({ preventScroll: true });
}

// reading position: which sentence the reading line is in, and how far through it
function update() {
  const el = scroller.value;
  if (!el || !sentenceEls.value.length) return;
  const box = el.getBoundingClientRect();
  const y = box.top + box.height * lineFrac;
  let sid = sentences.value.length - 1;
  let sfrac = 1;
  let found = false;
  const ops: number[] = [];
  sentenceEls.value.forEach((node, i) => {
    if (!node) return;
    const r = node.getBoundingClientRect();
    const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    // inside the band: full; fades out above and below
    const band = box.height * 0.03;
    const fade = box.height * 0.32;
    ops.push(dist <= band ? 1 : Math.max(0.1, 1 - (dist - band) / fade));
    if (!found && r.bottom >= y) {
      sid = i;
      sfrac = r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0;
      found = true;
    }
  });
  opacities.value = ops;
  const tb = titleBlock.value ?? chapterHead.value;
  crumbVisible.value = !!tb && el.scrollTop > tb.offsetTop + tb.offsetHeight - 24;
  savePos(sid);
  curSid.value = sid;
  curFrac.value = sfrac;

  const idx = llmScenes.value.findIndex((s) => sid >= s.from && sid <= s.to);
  activeIdx.value = idx;
  if (idx >= 0) {
    const s = llmScenes.value[idx];
    sceneProgress.value = Math.min(1, Math.max(0, (sid - s.from + sfrac) / (s.to - s.from + 1)));
  }
  engine.onPosition(idx >= 0 ? llmScenes.value[idx] : null, sid, sceneProgress.value);
}

const visualCount = computed(() => llmScenes.value.filter((s) => s.visual).length);

const maskStyle = computed(() => {
  const line = lineFrac * 100;
  return { "--line": `${line}%` } as Record<string, string>;
});


// --- LLM scene pass (slice 1: results are shown, not yet compiled to frames) ---
const view = ref<"reader" | "settings" | "library">("library");
const curSid = ref(0); // the sentence under the reading line
const filmReady = ref(false); // the chapter is open and the reader's place is restored: only then does the world start

const curFrac = ref(0); // how far through that sentence

// --- dev: the critic. Visits each stage cue of this chapter, takes a picture of the world there and asks a vision model whether it
// shows what the text describes. Findings go to the debug log (and the cache), to tune the cue prompt and the cue code with.
function describeCue(c: { k: string; what?: string; how?: string }): string {
  const w = c.what ?? "";
  switch (c.k) {
    case "moon": return `the moon changing phase (${c.how ?? "new to full"})`;
    case "sun": return /red|halt|huge|giant|set|dying|low/.test(c.how ?? "") ? "a huge dull-red sun low on the horizon" : "the sun racing across the sky as a streak of light with a trail";
    case "creature": return `a ${w || "creature"} ${c.how === "circle" ? "circling" : "walking or flying across the view"}`;
    case "grow": return `${w || "things"} springing up around the scene`;
    case "streak": return "white speed lines rushing past the camera";
    case "flash": return `the light flickering (${c.how ?? "strobe"})`;
    case "dim": return c.how === "eclipse" ? "an eclipse: a black disc with a bright ring in a darkened sky" : "the light failing, the scene growing dark";
    case "cam": return `a camera move (${c.how ?? ""})`;
    case "quake": return "the ground shaking";
    default: return c.k;
  }
}
async function critic() {
  const out: unknown[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  for (const sc of llmScenes.value) {
    for (const cue of sc.stage ?? []) {
      const mid = Math.round((cue.at + cue.to) / 2);
      jumpTo(mid);
      await sleep(1500);
      for (let i = 0; i < 60; i++) { const w = (window as any).__lw; if (w && !w.loading && w.loaded === w.want && w.want >= 0 && Math.abs(w.t - w.target) < 0.4) break; await sleep(1000); }
      await sleep(2500); // let the camera finish gliding
      const dir = await api.cacheDir().catch(() => "");
      if (!dir) { debugLog("critic-error", "no cache dir"); return; }
      const path = `${dir}/critic-${cue.k}-${cue.at}.png`;
      await api.worldCmd({ cmd: "snapshot", path });
      await sleep(1500);
      const text = sentences.value.filter((s) => s.id >= cue.at && s.id <= cue.to).map((s) => s.text.trim()).join(" ");
      try {
        const c = await api.llmVision("scan", 'You judge one frame from a 3D illustration that follows a book. Judge ONLY whether the directed element is visible and recognisable in this frame. A still cannot show motion, flicker or change over time, and the frame may be at any point in the change (a moon half-lit is fine for new-to-full): accept any point. Ignore details of the text that are not the directed element. Reply with one JSON object only: {"shows":bool,"sees":"<=15 words of what is visible","fix":"<=15 words: what would make the element clearer, or empty"}', `Text being read: "${text}"\nThe world was directed to show: ${describeCue(cue)}.\nDoes the picture clearly show what that text describes?`, path);
        const v = extractJson(c.text) as Record<string, unknown>;
        out.push({ cue: `${cue.k}:${cue.what ?? ""}:${cue.how ?? ""}`, at: cue.at, ...v });
        debugLog("critic", { cue: `${cue.k} ${cue.what ?? ""} ${cue.how ?? ""}`, at: cue.at, ...v });
      } catch (e) { debugLog("critic-error", { cue: cue.k, err: String(e) }); }
    }
  }
  debugLog("critic-done", out);
}

// --- the picture's look: picked from the book's text, always overridable ---
const styleAuto = ref<{ id: StyleId; reason: string; by: "model" | "keywords" }>({ id: DEFAULT_STYLE, reason: "", by: "keywords" });
const styleOver = ref<StyleId | null>(null); // the reader's choice for this book
const styleChapterOver = ref<StyleId | null>(null); // ...and for this chapter
const styleNow = computed(() => effectiveStyle({ chapter: styleChapterOver.value, book: styleOver.value, def: defaultStyle.value, pkgChapter: book.value?.chapters[chapterIdx.value]?.style, pkgBook: book.value?.package?.style, picked: styleAuto.value.id }));
const style = computed<StyleId>(() => styleNow.value.id);
const SOURCE_TEXT: Record<StyleSource, string> = { chapter: "your choice for this chapter", book: "your choice for this book", default: "your default look", "package-chapter": "the package's look for this chapter", package: "the package's look", picked: "" };
function loadChapterStyle() {
  styleChapterOver.value = book.value ? getChapterOverride(book.value.id, book.value.chapters[chapterIdx.value]?.id ?? "") : null;
}
async function loadStyle(b: Book) {
  styleOver.value = getOverride(b.id);
  styleAuto.value = { ...heuristicStyle(b), by: "keywords" }; // at once, no model needed
  try {
    const raw = await api.cacheGet("style", b.id);
    if (raw) {
      const o = JSON.parse(raw);
      if (isStyle(o.id)) { styleAuto.value = { id: o.id, reason: String(o.reason ?? ""), by: "model" }; return; }
    }
  } catch { /* not cached */ }
  // ask the book-scan model once per book (and once per session if it fails): its pick is cached
  const tried = `lanthorn:style-tried:${b.id}`;
  try { if (sessionStorage.getItem(tried)) return; sessionStorage.setItem(tried, "1"); } catch { /* optional */ }
  try {
    const c = await api.llmComplete("scan", STYLE_SYSTEM, styleUser(b));
    const p = parseStyle(c.text);
    if (p && book.value?.id === b.id) {
      styleAuto.value = { ...p, by: "model" };
      api.cachePut("style", b.id, JSON.stringify(p)).catch(() => {});
    }
  } catch { /* no model set up, or it failed: the keyword pick stands */ }
}
function chooseStyle(v: string) {
  const id = isStyle(v) ? v : null;
  styleOver.value = id;
  if (book.value) setOverride(book.value.id, id);
}
function chooseChapterStyle(v: string) {
  const id = isStyle(v) ? v : null;
  styleChapterOver.value = id;
  if (book.value) setChapterOverride(book.value.id, book.value.chapters[chapterIdx.value]?.id ?? "", id);
}

const showDetails = ref((() => { try { return localStorage.getItem("lanthorn:details") === "1"; } catch { return false; } })());
function toggleDetails() {
  showDetails.value = !showDetails.value;
  try { localStorage.setItem("lanthorn:details", showDetails.value ? "1" : "0"); } catch { /* optional */ }
}
const llmScenes = ref<LlmScene[]>([]);
const bible = ref<Bible>({ characters: [], locations: [] });
const analysis = reactive({ running: false, done: 0, total: 0, error: "", ms: 0, cached: 0 });
const CHUNK = 40;
const cacheKey = () => `lanthorn:scenes:${chapterKey.value}`;

const bookKey = () => `${chapterKey.value}-${PROMPT_VERSION}`;

async function cacheRead(key: string): Promise<string | null> {
  try {
    const raw = await api.cacheGet("analysis", key);
    return raw ? (JSON.parse(raw).text as string) : null;
  } catch { return null; }
}

/** force = ignore cached model replies (still refreshes them). */
async function analyze(force = false) {
  if (analysis.running || !sentences.value.length) return;
  const gen = renderGen;
  analysis.running = true;
  analysis.error = "";
  analysis.ms = 0;
  analysis.cached = 0;
  llmScenes.value = [];
  const all = sentences.value;
  const chunks = Math.ceil(all.length / CHUNK);
  analysis.total = chunks;
  analysis.done = 0;
  let b: Bible = { characters: [], locations: [] };
  let prevEnd: string | null = null;
  try {
    for (let i = 0; i < chunks; i++) {
      const slice = all.slice(i * CHUNK, (i + 1) * CHUNK);
      let chunk;
      for (let attempt = 0; ; attempt++) {
        try {
          // the prompt carries the bible and previous scene, so an unchanged chunk in an unchanged context hits the cache
          const user = buildUser(b, prevEnd, slice);
          const ckey = `${chapterKey.value}-${PROMPT_VERSION}-${hashStr(user)}`;
          let text = force || attempt > 0 ? null : await cacheRead(ckey);
          if (text) analysis.cached++;
          else {
            const c = await api.llmComplete("scene", SYSTEM, user);
            lastModel.value = c.model;
            analysis.ms += c.ms;
            text = c.text;
          }
          chunk = validateChunk(extractJson(text), slice[0].id, slice[slice.length - 1].id, b);
          api.cachePut("analysis", ckey, JSON.stringify({ text })).catch(() => {}); // only valid replies are kept
          break;
        } catch (e) {
          // a malformed reply is worth one retry; a connection error is not
          if (attempt >= 1 || !/JSON|scene|range/.test(String(e))) throw e;
        }
      }
      if (gen !== renderGen) return; // chapter changed while the model was working
      b = chunk.bible;
      bible.value = b;
      chunk.scenes.forEach((sc, k) => (sc.id = `s${llmScenes.value.length + k + 1}`));
      llmScenes.value = [...llmScenes.value, ...chunk.scenes];
      prevEnd = endState(chunk.scenes[chunk.scenes.length - 1]);
      analysis.done = i + 1;
      debugLog("analyze", { chunk: i + 1, of: chunks, scenes: chunk.scenes.length });
    }
    const result = JSON.stringify({ scenes: llmScenes.value, bible: bible.value });
    api.cachePut("book", bookKey(), result).catch(() => {});
    try { localStorage.setItem(cacheKey(), result); } catch { /* browser fallback */ }
  } catch (e) {
    if (gen === renderGen) {
      analysis.error = String(e);
      debugLog("analyze-error", String(e));
    }
  } finally {
    if (gen === renderGen) analysis.running = false;
  }
}

function jumpTo(sentenceId: number) {
  const el = sentenceEls.value[sentenceId];
  const sc = scroller.value;
  if (!el || !sc) return;
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight * lineFrac;
}

// dev only: poll for commands dropped in by the debug bridge (lets an agent drive the native window)
async function restoreAnalysis() {
  // scenes shipped inside a package come first: no analysis needed
  const shipped = book.value?.chapters[chapterIdx.value]?.scenes as { scenes?: unknown[]; bible?: Bible } | undefined;
  if (shipped?.scenes?.length && sentences.value.length) {
    try {
      const chunk = validateChunk(shipped, 0, sentences.value.length - 1, { characters: [], locations: [] });
      llmScenes.value = chunk.scenes;
      bible.value = chunk.bible;
      return;
    } catch (e) {
      debugLog("package-scenes-invalid", String(e instanceof Error ? e.message : e)); // fall through to cached/LLM analysis
    }
  }
  let raw: string | null = null;
  try { raw = await api.cacheGet("book", bookKey()); } catch { /* not in the app */ }
  // an analysis made under an older prompt still plays (the director fills in what it lacks)
  for (const v of LEGACY_PROMPT_VERSIONS) {
    if (raw) break;
    try { raw = await api.cacheGet("book", `${chapterKey.value}-${v}`); } catch { /* none */ }
  }
  if (!raw) { try { raw = localStorage.getItem(cacheKey()); } catch { /* ignore */ } }
  if (!raw && book.value?.title === "The Time Machine" && chapter.num === "IV") {
    // one-time carry-over from before analyses were keyed by chapter text
    try { raw = localStorage.getItem("lanthorn:scenes:/books/time-machine.txt:iv:v0.2"); } catch { /* ignore */ }
    if (raw) api.cachePut("book", bookKey(), raw).catch(() => {});
  }
  if (!raw) return;
  try {
    const j = JSON.parse(raw);
    llmScenes.value = j.scenes;
    bible.value = j.bible;
  } catch { /* corrupt entry: ignore, analysis can be redone */ }
}

// dev only: import from the bridge so importers can be tested on real files and pages without driving the UI
async function devImport(spec: string) {
  try {
    let b: Book;
    if (spec === "sample") b = importText(await (await fetch("/books/time-machine.txt")).text(), "time-machine.txt");
    else if (spec.startsWith("public:")) {
      const name = spec.slice(7);
      b = await importFile(new File([await (await fetch(`/books/${name}`)).blob()], name));
    } else if (spec.startsWith("url:")) {
      const page = await api.fetchPage(spec.slice(4));
      b = importHtml(page.html, page.finalUrl, "url", page.finalUrl);
    } else throw new Error("unknown import spec");
    await api.librarySave(b.id, JSON.stringify(b));
    const words = b.chapters.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
    debugLog("import", {
      id: b.id, title: b.title, author: b.author, kind: b.source.kind, chapters: b.chapters.length, words,
      first: b.chapters.slice(0, 4).map((c) => [c.num ?? "", c.title, c.paragraphs.length]),
      sample: b.chapters[Math.min(1, b.chapters.length - 1)].paragraphs[0]?.slice(0, 120),
    });
    await openBook(b.id);
  } catch (e) {
    debugLog("import-error", String(e instanceof Error ? e.message : e));
  }
}

const timers: number[] = [];
function pollCommands() {
  if (!import.meta.env.DEV) return;
  timers.push(window.setInterval(async () => {
    try {
      const cmd = (await (await fetch("/__debug/cmd")).text()).trim();
      if (!cmd) return;
      if (cmd === "analyze") analyze(false);
      else if (cmd.startsWith("eval:")) { try { debugLog("eval", new Function(`return (${cmd.slice(5)})`)()); } catch (e) { debugLog("eval", "ERR " + e); } }
      else if (cmd.startsWith("world:cmd:")) api.worldCmd(JSON.parse(cmd.slice(10))).then((r) => debugLog("world-cmd", r)).catch((e) => debugLog("world-error", String(e)));
      else if (cmd.startsWith("world:input:")) api.worldCmd({ cmd: "input", ...JSON.parse(cmd.slice(12)) }).catch((e) => debugLog("world-error", String(e)));
      else if (cmd === "details") toggleDetails();
      else if (cmd === "cachetest") {
        (async () => {
          await api.cachePut("test", "k1", '{"a":1}');
          const got = await api.cacheGet("test", "k1");
          const stats = await api.cacheStats();
          debugLog("cachetest", { got, stats });
        })().catch((e) => debugLog("cachetest-error", String(e)));
      }
      else if (cmd === "top") { if (scroller.value) scroller.value.scrollTop = 0; }
      else if (cmd === "sound") setSound(!soundOn.value);
      else if (cmd.startsWith("spot:")) engine.test(cmd.slice(5));
      else if (cmd === "settings") view.value = "settings";
      else if (cmd === "library") view.value = "library";
      else if (cmd.startsWith("import:")) devImport(cmd.slice(7));
      else if (cmd === "keycheck") { const ch = book.value?.chapters[chapterIdx.value]; debugLog("keycheck", { chapterKey: chapterKey.value, num: ch?.num, title: ch?.title, scenes: llmScenes.value.length }); }
      else if (cmd.startsWith("openbook:")) openBook(cmd.slice(9));
      else if (cmd.startsWith("chapter:")) openChapter(Number(cmd.slice(8)));
      else if (cmd === "reader") view.value = "reader";
      else if (cmd.startsWith("jump:")) jumpTo(Number(cmd.slice(5)));
      else if (cmd === "critic") critic();
      else if (cmd === "dump") debugLog("dump", { scenes: llmScenes.value, bible: bible.value });
      debugLog("cmd", cmd);
    } catch { /* bridge not running */ }
  }, 1500));
}

function debugLog(kind: string, data: unknown) {
  if (!import.meta.env.DEV) return;
  fetch("/__debug", { method: "POST", body: JSON.stringify({ kind, data }) }).catch(() => {});
}

const unlistenMenus: UnlistenFn[] = [];
let scrollRO: ResizeObserver | null = null;
function onEscape(e: KeyboardEvent) {
  if (e.key === "Escape" && view.value === "settings") { view.value = book.value ? "reader" : "library"; reloadSettings(); }
  else if (e.key === "Escape" && view.value === "library" && book.value) view.value = "reader";
}

onMounted(async () => {
  // Lanthorn > Settings… (⌘,) in the macOS menu bar; only exists inside the app
  if ("__TAURI_INTERNALS__" in window) {
    listen("open-settings", () => { view.value = "settings"; }).then((u) => unlistenMenus.push(u));
    listen("open-library", () => { view.value = "library"; }).then((u) => unlistenMenus.push(u));
  }
  window.addEventListener("keydown", onEscape);
  // the text's brightness is computed from where each sentence is: recompute when the panel's size changes (a window resize reflows it)
  if (scroller.value) { scrollRO = new ResizeObserver(() => update()); scrollRO.observe(scroller.value); }
  window.addEventListener("error", (e) => debugLog("error", { msg: e.message, src: e.filename }));
  window.addEventListener("unhandledrejection", (e) => debugLog("rejection", String(e.reason)));
  pollCommands();
  reloadSettings();
  api.cachePrune(RUNTIME_VERSION, 3 * 1024 ** 3).catch(() => {}); // drops the old baked-frame cache and prepared scenes from older engine versions
  if (soundOn.value) {
    // browsers only start audio after a user gesture: resume on the first one
    const kick = () => { setSound(true); window.removeEventListener("pointerdown", kick); window.removeEventListener("keydown", kick); };
    window.addEventListener("pointerdown", kick);
    window.addEventListener("keydown", kick);
  }
  debugLog("boot", { ua: navigator.userAgent, w: innerWidth, h: innerHeight, tauri: "__TAURI_INTERNALS__" in window });
  timers.push(window.setInterval(
    () =>
      debugLog("state", {
        scene: activeIdx.value,
        style: [style.value, styleNow.value.source, styleAuto.value.id, styleAuto.value.by],
        progress: Number(sceneProgress.value.toFixed(3)),
        sound: { on: soundOn.value, ctx: engine.ctx?.state ?? "none", level: Number(soundLevel.value.toFixed(4)), unresolved: [...engine.unresolved] },
        scrollTop: scroller.value?.scrollTop,
        w: innerWidth,
        h: innerHeight,
      }),
    2000,
  ));
  let last: string | null = null;
  try { last = localStorage.getItem(LAST_KEY); } catch { /* none */ }
  if (last) await openBook(last);
  else view.value = "library";
});
onBeforeUnmount(() => {
  timers.forEach((t) => clearInterval(t));
  unlistenMenus.forEach((u) => u());
  window.removeEventListener("keydown", onEscape);
  scrollRO?.disconnect();
});

function setEl(el: unknown, i: number) {
  if (el) sentenceEls.value[i] = el as HTMLElement;
}
</script>

<template>
  <div class="crumb" :class="{ show: crumbVisible && view === 'reader' }">
    <strong>{{ meta.title }}</strong><span>{{ chapter.num ? chapter.num + ". " : "" }}{{ chapter.title }}</span>
  </div>
  <div class="topbar">
    <button v-if="view === 'reader'" class="pill" title="Your books (⌘O)" @click="view = 'library'">Library</button>
    <button v-if="view === 'reader'" class="pill" :class="{ on: showDetails }" title="Scene details" @click="toggleDetails">Details<template v-if="llmScenes.length"> · {{ llmScenes.length }}</template></button>
    <button v-if="view === 'reader'" class="pill" :class="{ on: soundOn }" :title="soundOn ? 'Sound on: click to mute' : 'Turn sound on'" @click="setSound(!soundOn)">Sound {{ soundOn ? "on" : "off" }}</button>
    <button class="pill" :title="view === 'settings' ? 'Back to reading' : 'Model settings'" @click="view = view === 'settings' ? 'reader' : 'settings'; if (view === 'reader') reloadSettings()">{{ modelBadge }}</button>
  </div>
  <Settings v-if="view === 'settings'" @close="view = book ? 'reader' : 'library'; reloadSettings()" />
  <Library v-if="view === 'library'" :current-id="book?.id" @open="openBook($event)" @close="view = 'reader'" />
  <div v-show="view === 'reader'" class="app">
    <section class="reader" :style="maskStyle">
      <div ref="scroller" class="scroll" tabindex="0" @scroll.passive="update">
        <div class="pad top" />
        <header v-if="chapterIdx === 0" ref="titleBlock" class="booktitle">
          <h1>{{ meta.title }}</h1>
          <p v-if="meta.author" class="author">{{ meta.author }}</p>
        </header>
        <h2 ref="chapterHead" class="chapterhead"><span v-if="chapter.num">{{ chapter.num }}</span>{{ chapter.title }}</h2>
        <p v-for="(_, pi) in paragraphs" :key="pi">
          <template v-for="(s, si) in sentences" :key="s.id">
            <span
              v-if="s.para === pi"
              :ref="(el) => setEl(el, si)"
              class="sent"
              :style="{ opacity: opacities[si] ?? 0.15 }"
              >{{ s.text }}</span
            >
          </template>
        </p>
        <nav v-if="book && book.chapters.length > 1" class="chapnav">
          <button v-if="chapterIdx > 0" @click="openChapter(chapterIdx - 1)">← {{ book.chapters[chapterIdx - 1].title }}</button>
          <button v-if="chapterIdx < book.chapters.length - 1" @click="openChapter(chapterIdx + 1)">{{ book.chapters[chapterIdx + 1].title }} →</button>
        </nav>
        <div class="pad" />
      </div>
    </section>

    <section class="stage">
      <div class="stagebox">
        <Cutscene
          v-if="book && filmReady && llmScenes.length && view === 'reader'"
          :key="chapterKey + ':' + llmScenes.length + ':' + style"
          :sentences="sentences"
          :scenes="llmScenes"
          :bible="bible"
          :pkg="book?.package?.assets"
          :sid="curSid"
          :frac="curFrac"
          :style="style"
          host=".stagebox"
        />
        <div v-else class="placeholder">
          <p>Generate scenes for this chapter</p>
          <button :disabled="analysis.running" @click="analyze(false)">{{ analysis.running ? `Analyzing ${analysis.done}/${analysis.total}…` : "Analyze chapter" }}</button>
          <p v-if="analysis.error" class="llmerr">{{ analysis.error }}</p>
        </div>
      </div>

      <aside v-if="showDetails" class="drawer">
        <label v-if="book && book.chapters.length > 1" class="chapsel">
          <span>Chapter</span>
          <select :value="chapterIdx" @change="openChapter(Number(($event.target as HTMLSelectElement).value))">
            <option v-for="(c, i) in book.chapters" :key="c.id" :value="i">{{ c.num ? c.num + ". " : "" }}{{ c.title }}</option>
          </select>
        </label>
        <label class="chapsel">
          <span>Look: {{ styleLabel(style) }}<template v-if="styleNow.source !== 'picked'"> · {{ SOURCE_TEXT[styleNow.source] }}</template><template v-else> · {{ styleAuto.by === "model" ? "chosen from the book" : "picked from the text" }}<template v-if="styleAuto.reason"> ({{ styleAuto.reason }})</template></template></span>
          <select :value="styleChapterOver ?? 'auto'" @change="chooseChapterStyle(($event.target as HTMLSelectElement).value)">
            <option value="auto">This chapter: same as the book</option>
            <option v-for="st in STYLES" :key="st.id" :value="st.id">This chapter: {{ st.label }}</option>
          </select>
          <select :value="styleOver ?? 'auto'" @change="chooseStyle(($event.target as HTMLSelectElement).value)">
            <option value="auto">This book: automatic</option>
            <option v-for="st in STYLES" :key="st.id" :value="st.id">This book: {{ st.label }}: {{ st.blurb }}</option>
          </select>
        </label>
        <div class="llmbar">
          <button :disabled="analysis.running" @click="analyze(llmScenes.length > 0)">
            {{ analysis.running ? `Analyzing ${analysis.done}/${analysis.total}…` : llmScenes.length ? "Re-analyze chapter" : "Analyze chapter" }}
          </button>
        </div>
        <p v-if="llmScenes.length && !analysis.running" class="dim stats">{{ llmScenes.length }} scenes · {{ bible.characters.length }} characters · {{ bible.locations.length }} places · {{ visualCount }} with a picture<template v-if="analysis.cached"> · {{ analysis.cached }}/{{ analysis.total }} chunks from cache</template></p>
        <p v-if="analysis.error" class="llmerr">{{ analysis.error }}</p>
        <ul v-if="llmScenes.length" class="scenelist">
          <li v-for="(sc, si) in llmScenes" :key="sc.id + sc.from" :class="{ hidden: !sc.visual, current: si === activeIdx }" @click="jumpTo(sc.from)">
            <span class="rng">{{ sc.from }}–{{ sc.to }}</span>
            <span class="kind">{{ sc.visual ? sc.kind : "no visual" }}</span>
            <span class="what">{{ sc.location }}<template v-if="sc.visual"> · {{ sc.time.start }}<template v-if="sc.time.end !== sc.time.start">→{{ sc.time.end }}</template> · {{ sc.mood }}</template></span>
          </li>
        </ul>
      </aside>
    </section>
  </div>
</template>

<style>
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --ink: #e9e6dd;
}
html, body, #app { height: 100%; margin: 0; background: var(--bg); }
.app { display: grid; grid-template-columns: minmax(340px, 1fr) minmax(380px, 1.5fr); grid-template-rows: minmax(0, 1fr); height: 100vh; overflow: hidden; color: var(--ink); }
.reader { position: relative; min-width: 0; min-height: 0; height: 100%; padding-top: 40px; box-sizing: border-box; }
.scroll { height: 100%; overflow-y: auto; padding: 0 clamp(24px, 6vw, 72px); scrollbar-width: none; -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 28px); mask-image: linear-gradient(to bottom, transparent 0, #000 28px); }
.scroll::-webkit-scrollbar { display: none; }
.scroll:focus { outline: none; }
.pad { height: 45vh; }
.pad.top { height: 20vh; }
.booktitle { max-width: 34em; margin: 0 auto 6vh; text-align: center; }
.booktitle h1 { font: 600 clamp(34px, 5.2vw, 52px)/1.1 "Iowan Old Style", Palatino, Georgia, serif; margin: 0 0 14px; letter-spacing: -0.01em; }
.booktitle .author { margin: 0 auto !important; font: 15px/1.4 system-ui, sans-serif !important; letter-spacing: 0.22em; text-transform: uppercase; color: #8b8f99; }
.chapterhead { max-width: 34em; margin: 0 auto 2.2em; font: italic 400 26px/1.3 "Iowan Old Style", Palatino, Georgia, serif; color: #b8b2a2; }
.chapterhead span { font-style: normal; font-size: 14px; letter-spacing: 0.2em; color: #6d7280; margin-right: 14px; }
.crumb { position: fixed; top: 9px; left: 16px; z-index: 20; display: flex; gap: 10px; align-items: baseline; font: 11px ui-monospace, Menlo, monospace; color: #8b8f99; opacity: 0; transform: translateY(-4px); transition: opacity 0.25s, transform 0.25s; pointer-events: none; max-width: calc(100% - 420px); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.crumb.show { opacity: 1; transform: none; }
.chapnav { max-width: 34em; margin: 4vh auto 0; display: flex; gap: 10px; justify-content: space-between; }
.chapnav button { background: transparent; color: #b8bcc6; border: 1px solid #2b2f38; border-radius: 10px; padding: 10px 14px; font: 13px system-ui, sans-serif; cursor: pointer; max-width: 48%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chapnav button:hover { border-color: #5a4a22; color: var(--ink); }
.chapsel { display: grid; gap: 4px; margin-bottom: 12px; color: #8b8f99; font: 12px system-ui, sans-serif; }
.chapsel select { background: #0f1115; color: var(--ink); border: 1px solid #2b2f38; border-radius: 8px; padding: 7px 10px; font: 13px system-ui, sans-serif; width: 100%; }
.crumb strong { color: #b8bcc6; font-weight: 600; }
.scroll p {
  font: 21px/1.75 "Iowan Old Style", "Palatino", Georgia, serif;
  margin: 0 0 1.4em;
  max-width: 34em;
  margin-left: auto;
  margin-right: auto;
}
.sent { transition: opacity 0.12s linear; }
.stage { position: relative; display: flex; align-items: center; justify-content: center; padding: 44px 16px 16px; min-width: 0; min-height: 0; overflow: hidden; box-sizing: border-box; }
html.world, html.world body, html.world #app { background: transparent !important; }
.stagebox { display: grid; position: relative; width: 100%; height: 100%; align-items: center; justify-items: center; }
.placeholder { grid-area: 1 / 1; text-align: center; color: #6d7280; font: 13px system-ui, sans-serif; z-index: 1; display: grid; gap: 10px; justify-items: center; }
.ghostbtn { background: transparent !important; color: #b8bcc6 !important; border: 1px solid #2b2f38 !important; }
.topbar { position: fixed; top: 8px; right: 12px; z-index: 20; display: flex; gap: 6px; }
.pill { font: 11px ui-monospace, Menlo, monospace; color: #8b8f99; background: rgba(15, 17, 21, 0.75); border: 1px solid #23262d; border-radius: 99px; padding: 2px 10px; cursor: pointer; }
.pill:hover { color: var(--ink); border-color: #3a3f4a; }
.pill.play { color: #c9a54a; border-color: #5a4a22; }
.pill.on { color: #c9a54a; border-color: #5a4a22; }
.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(380px, 92%); background: rgba(12, 14, 18, 0.95); backdrop-filter: blur(8px); border-left: 1px solid #1f232a; padding: 44px 14px 14px; overflow-y: auto; z-index: 5; box-sizing: border-box; font: 12px system-ui, sans-serif; }
.stats { margin: 10px 0 0; }
.scenelist li.current { background: #1a1d24; color: #e9e6dd; }
.err { color: #e59a9a; }
.llm { font: 12px system-ui, sans-serif; }
.llmbar { display: flex; align-items: center; gap: 10px; }
.llmbar button { background: #c9a54a; color: #15120a; border: 0; border-radius: 8px; padding: 6px 12px; font: 600 12px system-ui, sans-serif; cursor: pointer; }
.llmbar button:disabled { opacity: 0.55; cursor: default; }
.dim { color: #6d7280; }
.llmerr { color: #e59a9a; background: #2a1717; border-radius: 8px; padding: 8px 10px; margin: 8px 0 0; word-break: break-word; }
.scenelist { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 2px; }
.scenelist li { display: grid; grid-template-columns: 76px 70px 1fr auto; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; color: #b8bcc6; align-items: baseline; }
.scenelist li:hover { background: #171a20; }
.scenelist li.hidden { color: #5b606c; }
.rng { font: 11px ui-monospace, Menlo, monospace; color: #6d7280; white-space: nowrap; }
.kind { color: #c9a54a; }
.what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
