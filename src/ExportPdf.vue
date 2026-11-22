<script setup lang="ts">
// Export the document as a PDF: plain, or designed (the model picks fonts, colours, title page, headings and ornaments to suit the content and
// anything the writer asks for). A preview of the first pages is shown before anything is saved.
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "./lib/api";
import { PLAIN, type Theme, designTheme } from "./lib/pdf/theme";
import { renderPdf } from "./lib/pdf/render";
import { parseDoc } from "./lib/markdown";
import { outline } from "./lib/helper";
import { forPdf, loadImage } from "./lib/images";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps<{ text: string; title: string; dir?: string }>();
const emit = defineEmits<{ (e: "close"): void }>();

const KEY = "lanthorn:pdf-opts";
const saved = (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? "{}"); } catch { return {}; } })();
const style = ref<"plain" | "designed">(saved.style === "plain" ? "plain" : "designed");
const size = ref<"letter" | "a4">(saved.size === "a4" ? "a4" : "letter");
const author = ref<string>(saved.author ?? "");
const dated = ref<boolean>(saved.dated !== false);
const cover = ref<boolean>(saved.cover !== false);
const brief = ref("");
const theme = ref<Theme | null>(null);
const status = ref<"idle" | "designing" | "rendering" | "saving">("idle");
const error = ref("");
const done = ref("");
const donePath = ref("");
const thumbs = ref<string[]>([]);
const pages = ref(0);
let bytes: Uint8Array | null = null;
let gen = 0;

const active = computed<Theme>(() => (style.value === "plain" ? PLAIN : theme.value ?? PLAIN));
const dateText = () => new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
function remember() { try { localStorage.setItem(KEY, JSON.stringify({ style: style.value, size: size.value, author: author.value, dated: dated.value, cover: cover.value })); } catch { /* optional */ } }

async function design(again = "") {
  const g = ++gen;
  error.value = "";
  status.value = "designing";
  try {
    const d = parseDoc(props.text);
    const lines = props.text.split("\n");
    const t = await designTheme({ title: props.title, outline: outline(lines), sample: props.text.replace(/^#.*$/m, "").trim(), words: (props.text.match(/\S+/g) ?? []).length, brief: brief.value }, again);
    if (g !== gen) return;
    theme.value = t;
    void d;
    await rebuild();
  } catch (e) {
    if (g === gen) { error.value = e instanceof Error ? e.message : String(e); status.value = "idle"; }
  }
}
async function rebuild() {
  const g = ++gen;
  status.value = "rendering";
  error.value = "";
  try {
    const t = active.value;
    const out = await renderPdf(props.text, t, { size: size.value, author: author.value.trim(), title: props.title, cover: cover.value && (style.value === "designed" || false), date: dated.value ? dateText() : "", loadImage: async (src) => { const img = await loadImage(src, { dir: props.dir }); return img ? forPdf(img) : null; } });
    if (g !== gen) return;
    bytes = out;
    // thumbnails of the first pages
    const doc = await pdfjs.getDocument({ data: out.slice() }).promise;
    pages.value = doc.numPages;
    const imgs: string[] = [];
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 0.55 });
      const c = document.createElement("canvas");
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      await page.render({ canvasContext: c.getContext("2d")!, viewport: vp, canvas: c } as any).promise;
      imgs.push(c.toDataURL("image/png"));
    }
    if (g !== gen) return;
    thumbs.value = imgs;
    status.value = "idle";
  } catch (e) {
    if (g === gen) { error.value = e instanceof Error ? e.message : String(e); status.value = "idle"; }
  }
}
async function exportNow() {
  if (!bytes) await rebuild();
  if (!bytes) return;
  const base = props.title.replace(/[^\w\- ]+/g, "").trim() || "document";
  let path: string | null = null;
  try { path = await saveDialog({ defaultPath: `${base}.pdf`, filters: [{ name: "PDF", extensions: ["pdf"] }] }); } catch (e) { error.value = String(e); return; }
  if (!path) return;
  if (!/\.pdf$/i.test(path)) path += ".pdf";
  status.value = "saving";
  try {
    const n = await api.fileWritePdf(path, bytes);
    donePath.value = path;
    done.value = `Saved ${(n / 1024).toFixed(0)} KB · ${pages.value} ${pages.value === 1 ? "page" : "pages"}`;
  } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  status.value = "idle";
}
const reveal = () => donePath.value && revealItemInDir(donePath.value).catch(() => {});

watch([style, size, author, dated, cover], () => { remember(); done.value = ""; if (style.value === "plain" || theme.value) rebuild(); });
onMounted(() => { if (style.value === "plain") rebuild(); else design(); });
onBeforeUnmount(() => { gen++; });
const busy = computed(() => status.value !== "idle");
const chips = computed(() => { const t = theme.value; return t ? [`${t.body.font} text`, `${t.heading.font} headings`, t.title.layout + " title", t.title.ornament !== "none" ? t.title.ornament : "", t.page.border !== "none" ? t.page.border + " border" : "", t.body.dropCap ? "drop caps" : "", t.chapterBreak ? "chapters on new pages" : ""].filter(Boolean) : []; });
if (import.meta.env.DEV) (window as any).__pdf = { style, theme, status, error, pages, thumbs, design, rebuild, exportNow, bytes: () => bytes };
</script>

<template>
  <div class="scrim" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
    <div class="card" role="dialog" aria-label="Export PDF">
      <header>
        <strong>Export as PDF</strong>
        <button class="x" title="Close" @click="emit('close')">✕</button>
      </header>
      <div class="cols">
        <div class="opts">
          <div class="seg">
            <button :class="{ on: style === 'plain' }" @click="style = 'plain'">Plain</button>
            <button :class="{ on: style === 'designed' }" @click="style = 'designed'">Designed ✦</button>
          </div>
          <template v-if="style === 'designed'">
            <label class="lbl">Describe the look <em>(optional)</em></label>
            <textarea v-model="brief" rows="2" placeholder="e.g. like a vintage field journal · calm and airy · a crisp technical memo" :disabled="busy" @keydown.meta.enter.prevent="design()" />
            <div class="row">
              <button class="primary" :disabled="busy" @click="design()">{{ theme ? "Design again" : "Design it" }}</button>
              <button v-if="theme" class="ghost" :disabled="busy" @click="design('again')">Something different</button>
            </div>
            <div v-if="theme" class="theme">
              <div class="sw"><i :style="{ background: theme.colors.paper, border: '1px solid #555' }" /><i :style="{ background: theme.colors.ink }" /><i :style="{ background: theme.colors.accent }" /><i :style="{ background: theme.colors.band }" /></div>
              <strong>{{ theme.name }}</strong><span v-if="theme.mood"> · {{ theme.mood }}</span>
              <div class="chips"><span v-for="c in chips" :key="c">{{ c }}</span></div>
            </div>
          </template>
          <label class="lbl">Page</label>
          <div class="seg small"><button :class="{ on: size === 'letter' }" @click="size = 'letter'">Letter</button><button :class="{ on: size === 'a4' }" @click="size = 'a4'">A4</button></div>
          <label class="lbl">Author <em>(optional)</em></label>
          <input v-model="author" placeholder="Your name" />
          <label class="chk"><input v-model="dated" type="checkbox" /> Show today's date</label>
          <label v-if="style === 'designed'" class="chk"><input v-model="cover" type="checkbox" /> Title page</label>
        </div>
        <div class="prev">
          <p v-if="status === 'designing'" class="hint">Designing…</p>
          <p v-else-if="status === 'rendering'" class="hint">Laying out the pages…</p>
          <div v-if="thumbs.length" class="thumbs"><img v-for="(t, i) in thumbs" :key="i" :src="t" :alt="'Page ' + (i + 1)" /></div>
          <p v-else-if="status === 'idle' && style === 'designed' && !theme && !error" class="hint">Press “Design it” and the model will choose a look for this document.</p>
          <p v-if="pages" class="hint small">{{ pages }} {{ pages === 1 ? "page" : "pages" }}{{ thumbs.length < pages ? " · first " + thumbs.length + " shown" : "" }}</p>
        </div>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
      <footer>
        <span v-if="done" class="ok">{{ done }} <button class="linkbtn" @click="reveal">Show in Finder</button></span>
        <span class="grow" />
        <button class="ghost" @click="emit('close')">Close</button>
        <button class="primary" :disabled="busy || (style === 'designed' && !theme)" @click="exportNow">Save PDF…</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: 30; background: rgba(0, 0, 0, 0.62); display: grid; place-items: center; font: 13px system-ui, sans-serif; color: #e9e6dd; }
.card { width: min(860px, calc(100vw - 32px)); height: min(640px, calc(100vh - 56px)); background: #171a21; border: 1px solid #3a3f4a; border-radius: 16px; box-shadow: 0 24px 70px rgba(0, 0, 0, 0.6); display: flex; flex-direction: column; overflow: hidden; }
.cols { flex: 1; }
header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #23272f; }
header strong { font-size: 15px; }
.x { background: transparent; border: 0; color: #7a7e89; font-size: 14px; cursor: pointer; }
.cols { display: grid; grid-template-columns: 290px 1fr; min-height: 0; grid-template-rows: minmax(0, 1fr); }
.opts { padding: 16px 18px; display: flex; flex-direction: column; gap: 9px; border-right: 1px solid #23272f; overflow-y: auto; min-height: 0; }
.opts > * { flex: none; }
.prev { padding: 16px; overflow-y: auto; background: #12151a; min-height: 280px; }
.lbl { color: #8b8f99; font-size: 11.5px; margin-top: 4px; }
.lbl em { color: #5d616c; font-style: normal; }
.seg { display: inline-flex; border: 1px solid #2b2f38; border-radius: 9px; overflow: hidden; width: max-content; }
.seg button { background: transparent; color: #9a9ea8; border: 0; padding: 7px 14px; cursor: pointer; font: 600 12px system-ui, sans-serif; }
.seg button.on { background: #262a33; color: #e8c870; }
.seg.small button { padding: 5px 12px; }
textarea, input[type="text"], input:not([type]) { flex: none; background: #0f1115; color: #e9e6dd; border: 1px solid #2b2f38; border-radius: 8px; padding: 8px 10px; font: 13px system-ui, sans-serif; resize: vertical; }
textarea:focus, input:focus { outline: 1px solid #c9a54a; border-color: #c9a54a; }
.row { display: flex; gap: 8px; flex-wrap: wrap; }
button { font: 600 12px system-ui, sans-serif; border-radius: 8px; cursor: pointer; }
button.primary { background: #c9a54a; color: #15120a; border: 0; padding: 8px 14px; }
button.ghost { background: transparent; color: #aab; border: 1px solid #2b2f38; padding: 7px 12px; }
button:disabled { opacity: 0.5; cursor: default; }
.theme { background: #12151a; border: 1px solid #23272f; border-radius: 10px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
.theme span { color: #8b8f99; }
.sw { display: flex; gap: 5px; }
.sw i { width: 20px; height: 20px; border-radius: 5px; display: block; }
.chips { display: flex; flex-wrap: wrap; gap: 5px; }
.chips span { background: #1d2129; border: 1px solid #2b2f38; border-radius: 99px; padding: 2px 8px; font-size: 11px; color: #b8bcc6; }
.chk { display: flex; gap: 7px; align-items: center; color: #b8bcc6; }
.thumbs { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
.thumbs img { height: min(46vh, 360px); width: auto; border-radius: 4px; box-shadow: 0 6px 22px rgba(0, 0, 0, 0.55); background: #fff; }
.hint { color: #7a7e89; margin: 0 0 10px; }
.hint.small { font-size: 11.5px; margin-top: 10px; }
.err { margin: 0; padding: 8px 18px; color: #e59a9a; background: #2a1717; }
footer { display: flex; gap: 10px; align-items: center; padding: 12px 18px; border-top: 1px solid #23272f; }
.grow { flex: 1; }
.ok { color: #8fd0a0; }
.linkbtn { background: none; border: 0; color: #7fb3ff; text-decoration: underline; padding: 0 0 0 6px; font-weight: 500; }
@media (max-width: 700px) { .cols { grid-template-columns: 1fr; } .opts { border-right: 0; border-bottom: 1px solid #23272f; } }
</style>
