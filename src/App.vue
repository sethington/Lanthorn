<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, triggerRef, watch } from "vue";
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
import { shiftScene } from "./lib/offset";
import { fmtTokens, recordChapterUsage, tokensOf, usage, useBook } from "./lib/usage";
import { DEFAULT_STYLE, STYLES, STYLE_SYSTEM, defaultStyle, effectiveStyle, getChapterOverride, getOverride, heuristicStyle, isStyle, parseStyle, setChapterOverride, setOverride, styleLabel, styleUser, type StyleId, type StyleSource } from "./lib/style";

// --- the open book: any imported book, one chapter at a time ---
const book = ref<Book | null>(null);
const chapterIdx = ref(0);
let renderGen = 0; // bumped on every chapter change: work started for the previous chapter is then ignored
const LAST_KEY = "lanthorn:last";
const posKey = (id: string) => `lanthorn:pos:${id}`;

// The whole book is one endless text. Sentence ids run through all of it; a chapter keeps the number of its first sentence (`base`).
// Only the chapters around the reading position are in the page (`winFrom`..`winTo`); the rest are spacers of the same height.
type Chap = {
  idx: number; base: number; nsent: number; key: string; chars: number; paras: Sentence[][];
  scenes: LlmScene[]; bible: Bible; state: "idle" | "running" | "done" | "error"; checked: boolean;
  done: number; total: number; cached: number; err: string;
};
const chaps = shallowRef<Chap[]>([]);
const touch = () => triggerRef(chaps);
const sentences = shallowRef<Sentence[]>([]);
const winCenter = ref(0);
const WIN_BEHIND = 1;
const WIN_AHEAD = 2;
const winFrom = computed(() => Math.max(0, winCenter.value - WIN_BEHIND));
const winTo = computed(() => Math.min(chaps.value.length - 1, winCenter.value + WIN_AHEAD));
const heights = reactive<Record<number, number>>({});
const secEls: Record<number, HTMLElement> = {};
let ppc = 0.6; // pixels of height per character of text: estimates the height of chapters not in the page, until they have been seen
const estH = (c: Chap) => Math.round(c.chars * ppc + 260);
function setSec(el: unknown, i: number) { if (el) secEls[i] = el as HTMLElement; else delete secEls[i]; }
function measureAll() {
  let px = 0, ch = 0;
  for (let i = winFrom.value; i <= winTo.value; i++) {
    const el = secEls[i];
    const c = chaps.value[i];
    if (!el || !c) continue;
    heights[i] = el.offsetHeight;
    if (c.chars > 500) { px += el.offsetHeight; ch += c.chars; }
  }
  if (ch > 4000) ppc = px / ch;
}
function chapOf(sid: number): number {
  const cs = chaps.value;
  let lo = 0, hi = cs.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (cs[mid].base <= sid) lo = mid; else hi = mid - 1; }
  return lo;
}
const sentenceEls = ref<HTMLElement[]>([]);
const scroller = ref<HTMLElement | null>(null);
const lineFrac = 0.42; // reading line height within the viewport
const opacities = shallowRef<number[]>([]);
const chapterKey = ref(""); // hash of the chapter text: identity for cached analysis
const meta = reactive({ title: "", author: "" });
const chapter = reactive({ num: "", title: "" });
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
  const ci = chapOf(sid);
  pendingPos = { id: book.value.id, chapter: ci, sid: sid - (chaps.value[ci]?.base ?? 0) }; // the place is kept as chapter + sentence in it
  clearTimeout(posTimer);
  posTimer = window.setTimeout(flushPos, 400);
}
window.addEventListener("beforeunload", flushPos);

function buildChaps(b: Book) {
  let base = 0;
  const all: Sentence[] = [];
  chaps.value = b.chapters.map((ch, idx) => {
    const sents = splitSentences(ch.paragraphs).map((s) => ({ ...s, id: s.id + base }));
    const paras: Sentence[][] = ch.paragraphs.map(() => []);
    sents.forEach((s) => paras[s.para].push(s));
    all.push(...sents);
    const c: Chap = { idx, base, nsent: sents.length, key: hashStr(ch.text), chars: ch.text.length, paras, scenes: [], bible: { characters: [], locations: [] }, state: "idle", checked: false, done: 0, total: 0, cached: 0, err: "" };
    base += sents.length;
    return c;
  });
  sentences.value = all;
  opacities.value = all.map(() => 0.15);
  sentenceEls.value = [];
  for (const k of Object.keys(heights)) delete heights[Number(k)];
  llmScenes.value = [];
  bible.value = { characters: [], locations: [] };
  activeIdx.value = -1;
}

async function openBook(id: string, startChapter?: number) {
  flushPos(); // keep the place in the book we're leaving
  let b: Book | null = null;
  try {
    const raw = await api.libraryGet(id);
    b = raw ? (JSON.parse(raw) as Book) : null;
  } catch { b = null; }
  if (!b || !b.chapters?.length) { view.value = "library"; return; }
  renderGen++; // work for the book we're leaving is abandoned
  useBook(b.id);
  filmReady.value = false;
  restoring = true;
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
  buildChaps(b);
  const gen = renderGen;
  chapterIdx.value = idx;
  winCenter.value = idx;
  applyChapter(idx);
  view.value = "reader";
  await nextTick();
  if (scroller.value) scroller.value.scrollTop = 0;
  await loadCached(chaps.value[idx]); // the chapter we start in comes first: the world needs its scenes
  publish();
  await nextTick();
  if (sid >= 0) await jumpTo(chaps.value[idx].base + Math.min(sid, chaps.value[idx].nsent - 1));
  else if (idx > 0) await scrollToChapter(idx);
  restoring = false;
  update(); // record the place we landed on
  scroller.value?.focus({ preventScroll: true });
  filmReady.value = true; // the world starts at the reader's place
  // the other chapters' saved analyses, then the model for whatever is still missing around the reader, in the background
  for (const c of chaps.value.slice().sort((x, y) => Math.abs(x.idx - idx) - Math.abs(y.idx - idx))) {
    if (gen !== renderGen) return;
    if (!c.checked) { await loadCached(c); publish(); }
  }
  pump();
}

/** Jump to the start of a chapter (the chapter menu, the dev bridge). */
async function openChapter(idx: number, restoreSid = -1) {
  if (!book.value || idx < 0 || idx >= chaps.value.length) return;
  if (restoreSid >= 0) await jumpTo(chaps.value[idx].base + restoreSid);
  else await scrollToChapter(idx);
}
async function scrollToChapter(idx: number) {
  const sc = scroller.value;
  if (!sc) return;
  if (idx < winFrom.value || idx > winTo.value) { winCenter.value = idx; await nextTick(); await nextTick(); }
  const el = secEls[idx];
  if (el) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - 24;
  update();
}
/** What follows from being in chapter idx: its title, its look, its place in the cache. */
function applyChapter(idx: number) {
  const b = book.value;
  const ch = b?.chapters[idx];
  if (!b || !ch) return;
  chapter.num = ch.num ?? "";
  chapter.title = ch.title;
  chapterKey.value = chaps.value[idx]?.key ?? hashStr(ch.text);
  loadChapterStyle();
}

// reading position: which sentence the reading line is in, and how far through it
function update() {
  const el = scroller.value;
  const cs = chaps.value;
  if (!el || !cs.length || !sentences.value.length) return;
  const box = el.getBoundingClientRect();
  const y = box.top + box.height * lineFrac;
  const lo = cs[winFrom.value].base;
  const hi = cs[winTo.value].base + cs[winTo.value].nsent;
  let sid = -1;
  let sfrac = 0;
  let last = -1;
  const ops = opacities.value.slice();
  for (let i = lo; i < hi; i++) {
    const node = sentenceEls.value[i];
    if (!node) continue;
    const r = node.getBoundingClientRect();
    const dist = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    // inside the band: full; fades out above and below
    const band = box.height * 0.03;
    const fade = box.height * 0.32;
    ops[i] = dist <= band ? 1 : Math.max(0.1, 1 - (dist - band) / fade);
    last = i;
    if (sid < 0 && r.bottom >= y) {
      sid = i;
      sfrac = r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0;
    }
  }
  if (sid < 0) { sid = last >= 0 ? last : curSid.value; sfrac = last >= 0 ? 1 : 0; }
  opacities.value = ops;
  const ci = chapOf(sid);
  if (ci !== chapterIdx.value) { chapterIdx.value = ci; applyChapter(ci); }
  if (ci !== winCenter.value) winCenter.value = ci;
  const head = secEls[ci]?.querySelector(".chapterhead") as HTMLElement | null;
  crumbVisible.value = !!head && head.getBoundingClientRect().bottom < box.top + 24;
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

// chapters come and go from the page as the reader moves: keep what they are reading where it is
watch([winFrom, winTo], async () => {
  const sc = scroller.value;
  if (!sc) return;
  measureAll(); // chapters about to leave the page are measured first, so their spacers are exactly as tall
  const a = secEls[chapterIdx.value];
  const top0 = a?.getBoundingClientRect().top;
  await nextTick();
  const a2 = secEls[chapterIdx.value];
  if (a && a2 === a && top0 !== undefined) sc.scrollTop += a.getBoundingClientRect().top - top0;
  measureAll();
  update();
}, { flush: "pre" });

const visualCount = computed(() => curScenes.value.filter((s) => s.visual).length);

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
  for (const sc of curScenes.value) {
    for (const cue of sc.stage ?? []) {
      // sample where the fewest other cues overlap (nearest the middle), and a little way into the sentence
      const others = (llmScenes.value.flatMap((s) => s.stage ?? []) as typeof cue[]).filter((o) => o !== cue);
      let mid = Math.round((cue.at + cue.to) / 2), best = 1e9;
      for (let i = cue.at; i <= cue.to; i++) {
        const n = others.filter((o) => i >= o.at && i <= o.to).length * 100 + Math.abs(i - (cue.at + cue.to) / 2);
        if (n < best) { best = n; mid = i; }
      }
      await jumpTo(mid);
      { const el = sentenceEls.value[mid]; const sc = scroller.value; if (el && sc) sc.scrollTop += Math.min(140, el.getBoundingClientRect().height * 0.6); }
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
// every chapter has its own look (the reader's choice for it, the package's, else the book's): scenes are drawn in their chapter's
const styleVer = ref(0); // bumped when any look choice changes: the worlds are then made again
watch([defaultStyle], () => styleVer.value++);
function styleFor(s: LlmScene): StyleId {
  const ci = s.ch ?? 0;
  const ch = book.value?.chapters[ci];
  const over = ci === chapterIdx.value ? styleChapterOver.value : book.value ? getChapterOverride(book.value.id, ch?.id ?? "") : null;
  return effectiveStyle({ chapter: over, book: styleOver.value, def: defaultStyle.value, pkgChapter: ch?.style, pkgBook: book.value?.package?.style, picked: styleAuto.value.id }).id;
}
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
      if (isStyle(o.id)) { styleAuto.value = { id: o.id, reason: String(o.reason ?? ""), by: "model" }; styleVer.value++; return; }
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
      styleVer.value++;
      api.cachePut("style", b.id, JSON.stringify(p)).catch(() => {});
    }
  } catch { /* no model set up, or it failed: the keyword pick stands */ }
}
function chooseStyle(v: string) {
  const id = isStyle(v) ? v : null;
  styleOver.value = id;
  if (book.value) setOverride(book.value.id, id);
  styleVer.value++;
}
function chooseChapterStyle(v: string) {
  const id = isStyle(v) ? v : null;
  styleChapterOver.value = id;
  if (book.value) setChapterOverride(book.value.id, book.value.chapters[chapterIdx.value]?.id ?? "", id);
  styleVer.value++;
}

const showDetails = ref((() => { try { return localStorage.getItem("lanthorn:details") === "1"; } catch { return false; } })());
function toggleDetails() {
  showDetails.value = !showDetails.value;
  try { localStorage.setItem("lanthorn:details", showDetails.value ? "1" : "0"); } catch { /* optional */ }
}
const llmScenes = ref<LlmScene[]>([]); // every analysed chapter's scenes, joined, in the text's own sentence numbers
const bible = ref<Bible>({ characters: [], locations: [] });
const CHUNK = 40;
const AHEAD = 2; // chapters analysed ahead of the reader

const curChap = computed(() => chaps.value[chapterIdx.value] ?? null);
/** the chapter's progress, for the panel and the drawer */
const analysis = computed(() => {
  const c = curChap.value;
  return { running: c?.state === "running", done: c?.done ?? 0, total: c?.total ?? 0, error: c?.state === "error" ? c.err : "", cached: c?.cached ?? 0, ready: !!c?.scenes.length };
});
const curScenes = computed(() => curChap.value?.scenes ?? []);

/** Join the chapters' scenes (and characters and places) into the book's. */
function publish() {
  const cs = chaps.value;
  llmScenes.value = cs.flatMap((c) => c.scenes);
  const chars = new Map<string, Bible["characters"][number]>();
  const locs = new Map<string, Bible["locations"][number]>();
  for (const c of cs) {
    for (const x of c.bible.characters) if (!chars.has(x.id)) chars.set(x.id, x);
    for (const x of c.bible.locations) if (!locs.has(x.id)) locs.set(x.id, x);
  }
  bible.value = { characters: [...chars.values()], locations: [...locs.values()] };
  touch();
}

const bookKeyOf = (c: Chap) => `${c.key}-${PROMPT_VERSION}`;
const localSentences = (c: Chap) => c.paras.flat().map((s) => ({ ...s, id: s.id - c.base })); // a chapter is analysed in its own numbering

async function cacheRead(key: string): Promise<string | null> {
  try {
    const raw = await api.cacheGet("analysis", key);
    return raw ? (JSON.parse(raw).text as string) : null;
  } catch { return null; }
}

/** A chapter's saved analysis (shipped in a package, or from an earlier run): no model call. */
async function loadCached(c: Chap | undefined) {
  if (!c || c.checked) return;
  c.checked = true;
  const b = book.value;
  if (!b) return;
  const chap = b.chapters[c.idx];
  const take = (scenes: LlmScene[], bb: Bible) => {
    c.scenes = scenes.map((s) => shiftScene(s, c.base, c.idx));
    c.bible = bb;
    c.state = "done";
  };
  // scenes shipped inside a package come first: no analysis needed
  const shipped = chap?.scenes as { scenes?: unknown[]; bible?: Bible } | undefined;
  if (shipped?.scenes?.length && c.nsent) {
    try {
      const chunk = validateChunk(shipped, 0, c.nsent - 1, { characters: [], locations: [] });
      take(chunk.scenes, chunk.bible);
      return;
    } catch (e) {
      debugLog("package-scenes-invalid", String(e instanceof Error ? e.message : e)); // fall through to cached/LLM analysis
    }
  }
  let raw: string | null = null;
  try { raw = await api.cacheGet("book", bookKeyOf(c)); } catch { /* not in the app */ }
  // an analysis made under an older prompt still plays (the director fills in what it lacks)
  for (const v of LEGACY_PROMPT_VERSIONS) {
    if (raw) break;
    try { raw = await api.cacheGet("book", `${c.key}-${v}`); } catch { /* none */ }
  }
  if (!raw) { try { raw = localStorage.getItem(`lanthorn:scenes:${c.key}`); } catch { /* ignore */ } }
  if (!raw && b.title === "The Time Machine" && chap?.num === "IV") {
    // one-time carry-over from before analyses were keyed by chapter text
    try { raw = localStorage.getItem("lanthorn:scenes:/books/time-machine.txt:iv:v0.2"); } catch { /* ignore */ }
    if (raw) api.cachePut("book", bookKeyOf(c), raw).catch(() => {});
  }
  if (!raw) return;
  try {
    const j = JSON.parse(raw);
    take(j.scenes, j.bible);
  } catch { /* corrupt entry: ignore, analysis can be redone */ }
}

/** Analyse one chapter with the model. Scenes appear in the book as each part of the chapter comes back. force = ignore saved replies. */
async function analyzeChapter(c: Chap, force = false) {
  if (c.state === "running" || !c.nsent) return;
  const gen = renderGen;
  c.state = "running";
  c.err = "";
  c.cached = 0;
  c.done = 0;
  const all = localSentences(c);
  const chunks = Math.ceil(all.length / CHUNK);
  c.total = chunks;
  touch();
  let b: Bible = { characters: [], locations: [] };
  let prevEnd: string | null = null;
  const local: LlmScene[] = [];
  const t0 = Date.now();
  try {
    for (let i = 0; i < chunks; i++) {
      const slice = all.slice(i * CHUNK, (i + 1) * CHUNK);
      let chunk;
      for (let attempt = 0; ; attempt++) {
        try {
          // the prompt carries the bible and previous scene, so an unchanged chunk in an unchanged context hits the cache
          const user = buildUser(b, prevEnd, slice);
          const ckey = `${c.key}-${PROMPT_VERSION}-${hashStr(user)}`;
          let text = force || attempt > 0 ? null : await cacheRead(ckey);
          if (text) c.cached++;
          else {
            const r = await api.llmComplete("scene", SYSTEM, user);
            lastModel.value = r.model;
            recordChapterUsage(c.key, r.usage);
            text = r.text;
          }
          chunk = validateChunk(extractJson(text), slice[0].id, slice[slice.length - 1].id, b);
          api.cachePut("analysis", ckey, JSON.stringify({ text })).catch(() => {}); // only valid replies are kept
          break;
        } catch (e) {
          // a malformed reply is worth one retry; a connection error is not
          if (attempt >= 1 || !/JSON|scene|range/.test(String(e))) throw e;
        }
      }
      if (gen !== renderGen) return; // another book was opened while the model was working
      b = chunk.bible;
      chunk.scenes.forEach((sc, k) => (sc.id = `s${local.length + k + 1}`));
      local.push(...chunk.scenes);
      prevEnd = endState(chunk.scenes[chunk.scenes.length - 1]);
      c.scenes = local.map((s) => shiftScene(s, c.base, c.idx));
      c.bible = b;
      c.done = i + 1;
      publish();
      debugLog("analyze", { chapter: c.idx, chunk: i + 1, of: chunks, scenes: chunk.scenes.length });
    }
    const result = JSON.stringify({ scenes: local, bible: b });
    api.cachePut("book", bookKeyOf(c), result).catch(() => {});
    try { localStorage.setItem(`lanthorn:scenes:${c.key}`, result); } catch { /* browser fallback */ }
    c.state = "done";
    debugLog("analyzed", { chapter: c.idx, ms: Date.now() - t0 });
  } catch (e) {
    if (gen === renderGen) {
      c.state = "error";
      c.err = String(e);
      debugLog("analyze-error", { chapter: c.idx, err: String(e) });
    }
  } finally {
    if (gen === renderGen && c.state === "running") c.state = "idle";
    touch();
  }
}

/** Read ahead: the model works through the chapter the reader is in and the ones just after it (and the one just before), one at a time. */
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  const gen = renderGen;
  try {
    for (;;) {
      if (gen !== renderGen) return;
      const ci = chapterIdx.value;
      const order = [0, ...Array.from({ length: AHEAD }, (_, k) => k + 1), -1];
      const next = order.map((d) => chaps.value[ci + d]).find((c) => c && c.checked && c.state === "idle");
      if (!next) return;
      await analyzeChapter(next);
    }
  } finally {
    pumping = false;
  }
}
watch(chapterIdx, () => pump());
function retryChapter(c: Chap | null) {
  if (!c) return;
  c.state = "idle";
  touch();
  pump();
}

async function jumpTo(sentenceId: number) {
  const sc = scroller.value;
  if (!sc || sentenceId < 0 || sentenceId >= sentences.value.length) return;
  const ci = chapOf(sentenceId);
  if (ci < winFrom.value || ci > winTo.value) { winCenter.value = ci; await nextTick(); await nextTick(); }
  const el = sentenceEls.value[sentenceId];
  if (!el) return;
  sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight * lineFrac;
  update();
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
      if (cmd === "analyze") { if (curChap.value) analyzeChapter(curChap.value, true); }
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
  else delete sentenceEls.value[i];
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
        <template v-for="c in chaps" :key="c.idx">
          <section v-if="c.idx >= winFrom && c.idx <= winTo" :ref="(el) => setSec(el, c.idx)" class="chap">
            <header v-if="c.idx === 0" class="booktitle">
              <h1>{{ meta.title }}</h1>
              <p v-if="meta.author" class="author">{{ meta.author }}</p>
            </header>
            <h2 class="chapterhead"><span v-if="book?.chapters[c.idx].num">{{ book?.chapters[c.idx].num }}</span>{{ book?.chapters[c.idx].title }}</h2>
            <p v-for="(ps, pi) in c.paras" :key="pi">
              <span v-for="s in ps" :key="s.id" :ref="(el) => setEl(el, s.id)" class="sent" :style="{ opacity: opacities[s.id] ?? 0.15 }">{{ s.text }}</span>
            </p>
          </section>
          <div v-else class="chapspace" :style="{ height: (heights[c.idx] ?? estH(c)) + 'px' }" />
        </template>
        <div class="pad" />
      </div>
    </section>

    <section class="stage">
      <div class="stagebox">
        <Cutscene
          v-if="book && filmReady && llmScenes.length && view === 'reader'"
          :key="book.id"
          :sentences="sentences"
          :scenes="llmScenes"
          :bible="bible"
          :pkg="book?.package?.assets"
          :sid="curSid"
          :frac="curFrac"
          :style-for="styleFor"
          :style-ver="styleVer"
          host=".stagebox"
        />
        <div v-else class="placeholder">
          <template v-if="analysis.error">
            <p>This part of the book couldn't be turned into scenes.</p>
            <p class="llmerr">{{ analysis.error }}</p>
            <button @click="retryChapter(curChap)">Try again</button>
          </template>
          <p v-else>Setting the scene… <template v-if="analysis.running">{{ analysis.done }}/{{ analysis.total }}</template></p>
        </div>
        <div v-if="llmScenes.length && !analysis.ready && !analysis.error" class="aheadpill">{{ analysis.running ? `Reading ahead ${analysis.done}/${analysis.total}…` : "Reading ahead…" }}</div>
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
          <button :disabled="analysis.running" @click="curChap && analyzeChapter(curChap, true)">
            {{ analysis.running ? `Analyzing ${analysis.done}/${analysis.total}…` : "Re-analyze this chapter" }}
          </button>
        </div>
        <div class="tokens">
          <div class="tokhead">Tokens used</div>
          <div class="tokrow"><span>This chapter</span><span>{{ fmtTokens(tokensOf(usage.data.byChapter[curChap?.key ?? ""])) }}<template v-if="usage.data.byChapter[curChap?.key ?? '']"> · {{ fmtTokens(usage.data.byChapter[curChap?.key ?? ""].output) }} out</template><template v-else> · none (saved)</template></span></div>
          <div class="tokrow"><span>This book</span><span>{{ fmtTokens(tokensOf(usage.data.total)) }} · {{ fmtTokens(usage.data.total.output) }} out · {{ usage.data.total.calls }} calls<template v-if="usage.data.total.cost"> · ${{ usage.data.total.cost.toFixed(2) }}</template></span></div>
          <div v-for="(t, job) in usage.data.byJob" :key="job" class="tokrow sub"><span>{{ job }}</span><span>{{ fmtTokens(tokensOf(t)) }} · {{ t.calls }} calls</span></div>
        </div>
        <p v-if="curScenes.length && !analysis.running" class="dim stats">{{ curScenes.length }} scenes · {{ bible.characters.length }} characters · {{ bible.locations.length }} places · {{ visualCount }} with a picture<template v-if="analysis.cached"> · {{ analysis.cached }}/{{ analysis.total }} chunks from cache</template></p>
        <p v-if="analysis.error" class="llmerr">{{ analysis.error }}</p>
        <ul v-if="curScenes.length" class="scenelist">
          <li v-for="sc in curScenes" :key="sc.id + sc.from" :class="{ hidden: !sc.visual, current: sc === llmScenes[activeIdx] }" @click="jumpTo(sc.from)">
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
.chap { display: flow-root; padding-bottom: 16vh; }
.chapspace { flex: none; }
.aheadpill { position: absolute; right: 24px; bottom: 24px; z-index: 2; background: rgba(0, 0, 0, 0.5); border-radius: 99px; padding: 3px 12px; font: 11px ui-monospace, Menlo, monospace; color: #b8bcc6; pointer-events: none; }
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
.tokens { margin: 12px 0 0; padding: 10px; border: 1px solid #23262d; border-radius: 8px; font: 12px system-ui, sans-serif; color: #b8bcc6; display: grid; gap: 4px; }
.tokhead { color: #8b8f99; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; }
.tokrow { display: flex; justify-content: space-between; gap: 10px; }
.tokrow.sub { color: #6d7280; padding-left: 10px; }
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
