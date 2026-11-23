<script setup lang="ts">
// The Markdown editor: CodeMirror 6 with a toolbar, a live preview, search and replace, and "rewrite this": select a passage (or put the cursor in a
// block), say why it should change, and the language model rewrites it; the change is shown as a word diff to accept or refuse.
// A document is saved in the library as a book (its chapters made from the headings), so the reader opens it like any other.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { markdown, markdownKeymap, markdownLanguage } from "@codemirror/lang-markdown";
import { HighlightStyle, bracketMatching, syntaxHighlighting } from "@codemirror/language";
import { openSearchPanel, search, searchKeymap } from "@codemirror/search";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import { diffLines, diffWords } from "diff";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { IMAGE_EXTS, STORE_PREFIX, blobUrl, loadImage } from "./lib/images";
import { api } from "./lib/api";
import type { Book } from "./lib/book";
import { baseName, docToBook, fileDocId, markdownOfBook, md, newDocId, parseDoc, plainOf } from "./lib/markdown";
import { type Doc, type Suggestion, helpWith, loadCorpus, recordTaste } from "./lib/helper";
import { fmtTokens, tokensOf, usage, useBook } from "./lib/usage";
import ExportPdf from "./ExportPdf.vue";
import { exportHtml } from "./lib/htmlExport";
import { renderDocx } from "./lib/docx";
import { forPdf } from "./lib/images";
import { type Version, ago, removeVersion, snapshot, versions } from "./lib/history";

const props = defineProps<{ docId?: string | null; file?: string | null }>();
const emit = defineEmits<{ (e: "close"): void; (e: "read", id: string): void; (e: "open-doc", id: string): void; (e: "open-file", path: string): void }>();

// ---- the document
const id = ref(props.file ? fileDocId(props.file) : props.docId || newDocId());
const filePath = ref<string>(props.file ?? ""); // the file on disk this document lives in ("" for one that lives only in the library)
let fileTime = 0; // its modified time when we last read or wrote it
const conflict = ref(""); // set when the file was changed outside while we hold edits
const notice = ref("");
const prev = shallowRef<Pick<Book, "imported" | "author"> | undefined>();
const text = ref("");
const loaded = ref(false);
const saveState = ref<"saved" | "dirty" | "saving" | "error">("saved");
const saveError = ref("");
const mode = ref<"edit" | "split" | "preview">((localStorage.getItem("lanthorn:ed-mode") as any) || "split");
const showLines = ref(localStorage.getItem("lanthorn:ed-lines") !== "0");
const title = computed(() => parseDoc(text.value).title || "Untitled");
const words = computed(() => (plainOf(text.value).match(/\S+/g) ?? []).length);
const readMins = computed(() => Math.max(1, Math.round(words.value / 230)));
const cursor = reactive({ line: 1, col: 1, sel: 0 });

let saveTimer = 0;
let lastSnap = 0;
async function saveNow(overwrite = false) {
  window.clearTimeout(saveTimer);
  if (!loaded.value) return;
  saveState.value = "saving";
  try {
    // the file is the source of truth: written first, and only if nobody else has changed it since we read it
    if (filePath.value) {
      try { fileTime = await api.fileWrite(filePath.value, text.value, overwrite ? undefined : fileTime || undefined); conflict.value = ""; }
      catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (m === "changed") { conflict.value = "This file was changed outside Lanthorn since you opened it."; saveState.value = "error"; saveError.value = "not saved to the file"; return; }
        throw e;
      }
    }
    const book = docToBook(text.value, id.value, prev.value, filePath.value || undefined);
    prev.value = { imported: book.imported, author: book.author };
    await api.librarySave(book.id, JSON.stringify(book));
    saveState.value = "saved";
    saveError.value = "";
    if (Date.now() - lastSnap > 5 * 60_000) { lastSnap = Date.now(); snapshot(id.value, text.value, "autosave"); } // (now and then, not on every save)
  } catch (e) {
    saveState.value = "error";
    saveError.value = e instanceof Error ? e.message : String(e);
  }
}
/** Put what is on disk into the editor (after an outside change), as one undoable edit. */
async function reloadFromDisk() {
  if (!filePath.value || !view) return;
  try {
    const f = await api.fileRead(filePath.value);
    fileTime = f.mtime;
    conflict.value = "";
    await snapshot(id.value, text.value, "before loading the file's version");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: f.text }, userEvent: "input.reload" });
    saveState.value = "saved";
  } catch (e) { saveError.value = e instanceof Error ? e.message : String(e); }
}
/** When the window comes back: a file changed outside is taken in at once if there is nothing unsaved, else it is a conflict. */
async function checkDisk() {
  if (!filePath.value || !loaded.value || saveState.value === "saving") return;
  try {
    const f = await api.fileRead(filePath.value);
    if (f.mtime === fileTime || f.text === text.value) { fileTime = f.mtime; return; }
    if (saveState.value === "dirty" || conflict.value) conflict.value = "This file was changed outside Lanthorn while you have unsaved edits.";
    else { await reloadFromDisk(); notice.value = "Reloaded: the file changed outside Lanthorn."; setTimeout(() => (notice.value = ""), 3500); }
  } catch { /* the file may be gone: the next save will say so */ }
}
async function saveAs() {
  const suggested = `${title.value.replace(/[^\w\- ]+/g, "").trim() || "document"}.md`;
  let path: string | null = null;
  try { path = await saveDialog({ defaultPath: filePath.value || suggested, filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }] }); } catch { path = null; }
  if (!path) return;
  if (!/\.(md|markdown|mdx|txt)$/i.test(path)) path += ".md";
  try {
    // the document's images come with it: the ones kept in the app's folder are copied to images/ beside the new file
    const dir = path.replace(/\/[^/]*$/, "");
    const refs = Array.from(new Set(Array.from(text.value.matchAll(/\]\(<?lanthorn-img\/([\w.\-]+)>?\)/g)).map((m) => m[1])));
    if (refs.length && view) {
      let t = text.value;
      for (const n of refs) {
        try {
          const img = await api.imageStored(n);
          const nn = await api.imageSave(Uint8Array.from(img.bytes), `${dir}/images`, n.replace(/\.[a-z0-9]+$/i, ""));
          t = t.split(`${STORE_PREFIX}${n}`).join(`images/${nn}`);
        } catch { /* a missing image stays as it was */ }
      }
      if (t !== text.value) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, userEvent: "input.images" });
    }
    fileTime = await api.fileWrite(path, text.value);
    filePath.value = path;
    conflict.value = "";
    await saveNow();
    notice.value = `Saved to ${baseName(path)}`;
    setTimeout(() => (notice.value = ""), 3000);
  } catch (e) { saveState.value = "error"; saveError.value = e instanceof Error ? e.message : String(e); }
}
function touched() {
  saveState.value = "dirty";
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveNow, 800);
}

// ---- CodeMirror
const host = ref<HTMLElement | null>(null);
const paneEl = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
const lineComp = new Compartment();

const setRewriteRange = StateEffect.define<{ from: number; to: number } | null>();
const rewriteRange = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setRewriteRange)) return e.value;
    if (v && tr.docChanged) return { from: tr.changes.mapPos(v.from, 1), to: tr.changes.mapPos(v.to, -1) };
    return v;
  },
  provide: (f) => EditorView.decorations.from(f, (r): DecorationSet => (r && r.to > r.from ? Decoration.set([Decoration.mark({ class: "cm-rewriting" }).range(r.from, r.to)]) : Decoration.none)),
});

const setFocusRange = StateEffect.define<{ from: number; to: number } | null>();
const focusRange = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setFocusRange)) return e.value && e.value.to > e.value.from ? Decoration.set([Decoration.mark({ class: "cm-focus" }).range(e.value.from, e.value.to)]) : Decoration.none;
    return tr.docChanged ? Decoration.none : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const hl = HighlightStyle.define([
  { tag: t.heading1, color: "#e8c870", fontWeight: "700", fontSize: "1.45em" },
  { tag: t.heading2, color: "#e2c585", fontWeight: "700", fontSize: "1.25em" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], color: "#d8c79a", fontWeight: "700" },
  { tag: t.strong, fontWeight: "700", color: "#f2efe6" },
  { tag: t.emphasis, fontStyle: "italic", color: "#ddd8c8" },
  { tag: t.strikethrough, textDecoration: "line-through", color: "#8b8f99" },
  { tag: t.link, color: "#7fb3ff", textDecoration: "underline" },
  { tag: t.url, color: "#6c92c8" },
  { tag: t.monospace, color: "#9fd0b8", fontFamily: "ui-monospace, Menlo, monospace" },
  { tag: t.quote, color: "#9a9684", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "#6d7280" },
  { tag: t.list, color: "#c9a54a" },
  { tag: t.comment, color: "#6d7280" },
]);

const theme = EditorView.theme(
  {
    "&": { height: "100%", color: "#e9e6dd", backgroundColor: "transparent", fontSize: "16px" },
    ".cm-scroller": { fontFamily: '"Iowan Old Style", Palatino, Georgia, serif', lineHeight: "1.75", padding: "20px 0 40vh" },
    ".cm-content": { maxWidth: "46em", margin: "0 auto", padding: "0 28px", caretColor: "#e8c870" },
    ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "#4a4f5a", fontFamily: "ui-monospace, Menlo, monospace", fontSize: "11px" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#8b8f99" },
    "&.cm-focused": { outline: "none" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": { backgroundColor: "rgba(201,165,74,0.32) !important" },
    ".cm-cursor": { borderLeftColor: "#e8c870" },
    ".cm-focus": { backgroundColor: "rgba(232,200,112,0.22)", borderBottom: "2px solid #e8c870" },
    ".cm-rewriting": { backgroundColor: "rgba(127,179,255,0.18)", borderBottom: "2px solid #7fb3ff" },
    ".cm-panels": { backgroundColor: "#171a21", color: "#e9e6dd", border: "none", fontFamily: "system-ui, sans-serif" },
    ".cm-panels-top": { borderBottom: "1px solid #2b2f38" },
    ".cm-search": { padding: "8px 12px", display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", fontSize: "12.5px" },
    ".cm-search input, .cm-search button": { font: "12.5px system-ui, sans-serif", borderRadius: "6px" },
    ".cm-search input": { background: "#0f1115", color: "#e9e6dd", border: "1px solid #2b2f38", padding: "4px 8px" },
    ".cm-search button": { background: "#262a33", color: "#d6d3c8", border: "1px solid #343945", padding: "4px 10px", cursor: "pointer" },
    ".cm-search label": { color: "#9a9ea8", display: "inline-flex", gap: "4px", alignItems: "center" },
    ".cm-searchMatch": { backgroundColor: "rgba(201,165,74,0.28)" },
    ".cm-searchMatch-selected": { backgroundColor: "rgba(201,165,74,0.6)" },
    ".cm-placeholder": { color: "#5d616c" },
  },
  { dark: true },
);

// ---- formatting commands
type V = EditorView;
function wrap(v: V, open: string, close = open): boolean {
  v.dispatch(
    v.state.changeByRange((r) => {
      const s = v.state.sliceDoc(r.from, r.to);
      const before = v.state.sliceDoc(Math.max(0, r.from - open.length), r.from);
      const after = v.state.sliceDoc(r.to, r.to + close.length);
      if (before === open && after === close) return { changes: [{ from: r.from - open.length, to: r.from }, { from: r.to, to: r.to + close.length }], range: r.map(v.state.changes([{ from: r.from - open.length, to: r.from }, { from: r.to, to: r.to + close.length }]), -1) };
      if (s.startsWith(open) && s.endsWith(close) && s.length >= open.length + close.length) return { changes: { from: r.from, to: r.to, insert: s.slice(open.length, s.length - close.length) }, range: { anchor: r.from, head: r.to - open.length - close.length } as any };
      return { changes: [{ from: r.from, insert: open }, { from: r.to, insert: close }], range: r.empty ? { anchor: r.from + open.length, head: r.from + open.length } as any : { anchor: r.from, head: r.to + open.length + close.length } as any };
    }),
  );
  v.focus();
  return true;
}
function eachLine(v: V, f: (text: string, index: number) => string): boolean {
  const { from, to } = v.state.selection.main;
  const a = v.state.doc.lineAt(from), b = v.state.doc.lineAt(to);
  const changes = [];
  for (let n = a.number, k = 0; n <= b.number; n++, k++) {
    const ln = v.state.doc.line(n);
    changes.push({ from: ln.from, to: ln.to, insert: f(ln.text, k) });
  }
  v.dispatch({ changes });
  v.focus();
  return true;
}
const HEAD = /^#{1,6}\s+/;
const heading = (v: V, n: number) => eachLine(v, (s) => { const m = HEAD.exec(s); const cur = m ? m[0].trim().length : 0; const body = s.replace(HEAD, ""); return cur === n ? body : "#".repeat(n) + " " + body; });
const prefixToggle = (v: V, re: RegExp, make: (k: number) => string) => {
  const lines: string[] = [];
  const { from, to } = v.state.selection.main;
  for (let n = v.state.doc.lineAt(from).number; n <= v.state.doc.lineAt(to).number; n++) lines.push(v.state.doc.line(n).text);
  const all = lines.every((l) => re.test(l) || !l.trim());
  return eachLine(v, (s, k) => (all ? s.replace(re, "") : s.trim() ? make(k) + s.replace(/^(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|>\s?)/, "") : s));
};
function link(v: V) {
  const r = v.state.selection.main;
  const sel = v.state.sliceDoc(r.from, r.to);
  const label = sel || "link text";
  v.dispatch({ changes: { from: r.from, to: r.to, insert: `[${label}](url)` }, selection: { anchor: r.from + label.length + 3, head: r.from + label.length + 6 } });
  v.focus();
  return true;
}
function codeBlock(v: V) {
  const r = v.state.selection.main;
  const sel = v.state.sliceDoc(r.from, r.to);
  v.dispatch({ changes: { from: r.from, to: r.to, insert: "```\n" + sel + "\n```" }, selection: { anchor: r.from + 4, head: r.from + 4 + sel.length } });
  v.focus();
  return true;
}
function insertAtLine(v: V, s: string) {
  const r = v.state.selection.main;
  const ln = v.state.doc.lineAt(r.to);
  v.dispatch({ changes: { from: ln.to, insert: s }, selection: { anchor: ln.to + s.length } });
  v.focus();
  return true;
}
const cmds = {
  bold: () => view && wrap(view, "**"),
  italic: () => view && wrap(view, "*"),
  strike: () => view && wrap(view, "~~"),
  code: () => view && wrap(view, "`"),
  h1: () => view && heading(view, 1),
  h2: () => view && heading(view, 2),
  h3: () => view && heading(view, 3),
  quote: () => view && prefixToggle(view, /^>\s?/, () => "> "),
  bullet: () => view && prefixToggle(view, /^[-*+]\s+(?!\[[ xX]\])/, () => "- "),
  numbered: () => view && prefixToggle(view, /^\d+\.\s+/, (k) => `${k + 1}. `),
  task: () => view && prefixToggle(view, /^[-*+]\s+\[[ xX]\]\s+/, () => "- [ ] "),
  link: () => view && link(view),
  codeblock: () => view && codeBlock(view),
  rule: () => view && insertAtLine(view, "\n\n---\n\n"),
  table: () => view && insertAtLine(view, "\n\n| Column | Column |\n| --- | --- |\n| | |\n\n"),
  undo: () => view && (undo(view), view.focus()),
  redo: () => view && (redo(view), view.focus()),
  find: () => view && (openSearchPanel(view), true),
};

// ---- rewrite: a selected passage (or the block the cursor is in) and the reason it should change
const rw = reactive({
  open: false,
  status: "idle" as "idle" | "working" | "review",
  from: 0,
  to: 0,
  original: "",
  instruction: "",
  retryNote: "",
  result: "",
  error: "",
  gen: 0,
  history: [] as string[],
});
const CHIPS = ["Tighter", "Clearer", "Simpler words", "Warmer", "More formal", "Expand", "Fix grammar", "More vivid"];
const sel = reactive({ show: false, x: 0, y: 0 });
const instrEl = ref<HTMLTextAreaElement | null>(null);

function blockAt(v: V): { from: number; to: number } {
  const doc = v.state.doc;
  const ln = doc.lineAt(v.state.selection.main.head);
  if (!ln.text.trim()) return { from: ln.from, to: ln.to };
  let a = ln.number, b = ln.number;
  while (a > 1 && doc.line(a - 1).text.trim()) a--;
  while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
  return { from: doc.line(a).from, to: doc.line(b).to };
}
function startRewrite() {
  if (!view) return;
  const r = view.state.selection.main;
  const range = r.empty ? blockAt(view) : { from: r.from, to: r.to };
  const original = view.state.sliceDoc(range.from, range.to);
  if (!original.trim()) return;
  rw.gen++;
  Object.assign(rw, { open: true, status: "idle", from: range.from, to: range.to, original, instruction: "", retryNote: "", result: "", error: "" });
  view.dispatch({ effects: setRewriteRange.of(range), selection: { anchor: range.to } });
  sel.show = false;
  nextTick(() => instrEl.value?.focus());
}
function closeRewrite() {
  rw.gen++;
  rw.open = false;
  rw.status = "idle";
  view?.dispatch({ effects: setRewriteRange.of(null) });
  view?.focus();
}
const REWRITE_SYSTEM = `You rewrite one passage of a Markdown document, as its author asks. Reply with ONLY the rewritten passage, in Markdown, and nothing else: no preamble, no explanation, no quotation marks around it, no code fence around it.
- Do exactly what the author's reason asks, and change as little else as you can. Keep their voice, meaning and facts unless asked to change them.
- Keep the Markdown structure of the passage (headings, list markers, emphasis, links, code) unless the reason asks you to change it.
- The text before and after is only context so the passage fits in: never repeat it.`;
async function runRewrite() {
  if (!rw.open || rw.status === "working") return;
  const why = rw.instruction.trim() || "Improve it";
  const doc = view!.state.doc.toString();
  const gen = ++rw.gen;
  rw.status = "working";
  rw.error = "";
  const before = doc.slice(Math.max(0, rw.from - 1500), rw.from);
  const after = doc.slice(rw.to, rw.to + 800);
  const user = `Text before the passage (context only):\n${before || "(start of the document)"}\n\n<<<PASSAGE>>>\n${rw.original}\n<<<END PASSAGE>>>\n\nText after the passage (context only):\n${after || "(end of the document)"}\n\nWhy it should be rewritten, in the author's words: ${why}${rw.retryNote ? `\nThe last attempt was not right. The author adds: ${rw.retryNote}` : ""}`;
  try {
    const c = await api.llmComplete("rewrite", REWRITE_SYSTEM, user);
    if (gen !== rw.gen) return; // cancelled, or asked again
    let out = c.text.trim();
    const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(out);
    if (fence) out = fence[1];
    if (!out) throw new Error("The model sent back nothing.");
    rw.result = out;
    rw.status = "review";
    if (rw.history[0] !== why) rw.history.unshift(why);
    rw.history = rw.history.slice(0, 8);
  } catch (e) {
    if (gen !== rw.gen) return;
    rw.error = e instanceof Error ? e.message : String(e);
    rw.status = "idle";
  }
}
function retry() { rw.status = "idle"; rw.result = ""; nextTick(() => instrEl.value?.focus()); }
function accept() {
  if (!view || rw.status !== "review") return;
  const r = view.state.field(rewriteRange);
  if (!r || view.state.sliceDoc(r.from, r.to) !== rw.original) { rw.error = "The passage was edited while it was being rewritten. Select it again."; rw.status = "idle"; return; }
  snapshot(id.value, text.value, "before a rewrite");
  view.dispatch({ changes: { from: r.from, to: r.to, insert: rw.result }, selection: { anchor: r.from, head: r.from + rw.result.length }, effects: setRewriteRange.of(null), userEvent: "input.rewrite" });
  rw.open = false;
  rw.status = "idle";
  view.focus();
}
const diffParts = computed(() => (rw.status === "review" ? diffWords(rw.original, rw.result) : []));
function chip(c: string) { rw.instruction = rw.instruction ? `${rw.instruction.replace(/[.\s]+$/, "")}. ${c}` : c; instrEl.value?.focus(); }
function onInstrKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); runRewrite(); }
  else if (e.key === "Escape") { e.preventDefault(); closeRewrite(); }
}
function onPanelKey(e: KeyboardEvent) {
  if (rw.status === "review" && (e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); accept(); }
  else if (e.key === "Escape") closeRewrite();
}

// ---- images: shown in the preview, inserted from a file, pasted or dropped. A file-backed document keeps them in an images/ folder beside it;
// one that lives only in the library keeps them in the app's own folder (and they move to images/ when it is saved to a file)
const docDir = computed(() => (filePath.value ? filePath.value.replace(/\/[^/]*$/, "") : undefined));
const imgDest = () => (docDir.value ? `${docDir.value}/images` : undefined);
const imgRef = (name: string) => (docDir.value ? `images/${name}` : `${STORE_PREFIX}${name}`);
function putImage(name: string, alt: string) {
  if (!view) return;
  const r = view.state.selection.main;
  const text = `![${alt}](${imgRef(name)})`;
  const ln = view.state.doc.lineAt(r.to);
  const lead = ln.text.trim() ? "\n\n" : "";
  view.dispatch({ changes: { from: r.to, insert: lead + text + "\n" }, selection: { anchor: r.to + lead.length + 2, head: r.to + lead.length + 2 + alt.length } });
  view.focus();
}
const altOf = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim();
const imgMsg = ref("");
function imgFail(e: unknown) { imgMsg.value = e instanceof Error ? e.message : String(e); setTimeout(() => (imgMsg.value = ""), 5000); }
async function pickImage() {
  try {
    const p = await openDialog({ multiple: false, directory: false, filters: [{ name: "Images", extensions: IMAGE_EXTS }] });
    if (typeof p !== "string" || !p) return;
    const name = await api.imageImport(p, imgDest());
    putImage(name, altOf(name));
  } catch (e) { imgFail(e); }
}
async function addImageFiles(files: File[]) {
  for (const f of files) {
    try {
      const name = await api.imageSave(new Uint8Array(await f.arrayBuffer()), imgDest(), f.name && !/^image\.\w+$/i.test(f.name) ? f.name.replace(/\.[a-z0-9]+$/i, "") : undefined);
      putImage(name, altOf(f.name && !/^image\.\w+$/i.test(f.name) ? f.name : name));
    } catch (e) { imgFail(e); }
  }
}
const imageFiles = (dt: DataTransfer | null) => Array.from(dt?.files ?? []).filter((f) => f.type.startsWith("image/"));
/** The preview's images get their bytes (a local file, a web address) and show them; one that can't be read shows its description instead. */
const blobs: string[] = [];
function resolveImages() {
  const root = previewEl.value;
  if (!root) return;
  root.querySelectorAll<HTMLImageElement>("img.mdimg:not([data-done])").forEach((el) => {
    el.setAttribute("data-done", "1");
    const src = el.getAttribute("data-src") ?? "";
    loadImage(src, { dir: docDir.value }).then((img) => {
      if (!el.isConnected) return;
      if (img) { const u = blobUrl(img); blobs.push(u); el.src = u; el.classList.add("loaded"); }
      else { const sp = document.createElement("span"); sp.className = "imgmiss"; sp.textContent = `🖼 ${el.alt || "image"} — can't load ${src.length > 50 ? src.slice(0, 50) + "…" : src}`; el.parentElement?.querySelector(".mdcap")?.remove(); el.replaceWith(sp); }
    });
  });
}
// ---- the writing helper: watches the passage you are writing and suggests links, references and tone changes (see lib/helper.ts)
const hp = reactive({
  open: localStorage.getItem("lanthorn:helper") === "1",
  auto: localStorage.getItem("lanthorn:helper-auto") !== "0",
  status: "idle" as "idle" | "thinking",
  items: [] as Suggestion[],
  err: "",
  checks: 0,
  from: 0,
  to: 0,
  label: "",
  info: "",
  busy: {} as Record<string, string>,
  folder: localStorage.getItem("lanthorn:writing-dir") ?? "",
  folderOpen: false,
});
function saveFolder() { try { localStorage.setItem("lanthorn:writing-dir", hp.folder.trim()); } catch { /* optional */ } hpKey = ""; hp.folderOpen = false; if (hp.folder.trim()) checkNow(true); }
const dismissed = new Set<string>();
let corpus: Doc[] | null = null;
let hpTimer = 0;
let hpKey = "";
let hpAt = 0;
let hpGen = 0;
function toggleHelper() {
  hp.open = !hp.open;
  try { localStorage.setItem("lanthorn:helper", hp.open ? "1" : "0"); } catch { /* optional */ }
  if (hp.open) scheduleHelper(600);
}
function toggleAuto() { hp.auto = !hp.auto; try { localStorage.setItem("lanthorn:helper-auto", hp.auto ? "1" : "0"); } catch { /* optional */ } if (hp.auto) scheduleHelper(600); }
function scheduleHelper(ms = 5000) {
  window.clearTimeout(hpTimer);
  if (!hp.open || !hp.auto) return;
  hpTimer = window.setTimeout(() => checkNow(false), ms);
}
function passageNow(): { from: number; to: number } | null {
  if (!view) return null;
  const r = view.state.selection.main;
  const range = r.empty ? blockAt(view) : { from: r.from, to: r.to };
  const t = view.state.sliceDoc(range.from, range.to);
  if (t.trim().length < 40 || /^\s*(#|```)/.test(t.trim())) return null; // (a heading or a code fence is not prose to advise on)
  return range;
}
async function checkNow(force: boolean) {
  if (!view || !hp.open || hp.status === "thinking") return;
  const range = passageNow();
  if (!range) { if (force) hp.info = "Put the cursor in a paragraph, or select some text, and I'll look at it."; return; }
  const passage = view.state.sliceDoc(range.from, range.to);
  const key = passage;
  if (!force && key === hpKey) return;
  if (!force && Date.now() - hpAt < 15000) { scheduleHelper(15000 - (Date.now() - hpAt) + 200); return; }
  const doc = view.state.doc;
  const gen = ++hpGen;
  hp.status = "thinking";
  hp.err = "";
  hp.info = "";
  hp.from = range.from;
  hp.to = range.to;
  hp.label = passage.replace(/\s+/g, " ").slice(0, 70) + (passage.length > 70 ? "…" : "");
  try {
    if (!corpus) corpus = await loadCorpus(id.value);
    const res = await helpWith({ passage, docLines: doc.toString().split("\n"), passageFrom: doc.lineAt(range.from).number - 1, passageTo: doc.lineAt(range.to).number - 1, docId: id.value, docTitle: title.value }, corpus, hp.folder.trim());
    if (gen !== hpGen) return;
    hpKey = key;
    hpAt = Date.now();
    hp.checks++;
    hp.items = res.suggestions.filter((q) => !dismissed.has(q.id));
    hp.info = hp.items.length ? "" : `Nothing to suggest here (looked for ${res.terms.slice(0, 4).join(", ") || "related writing"}${res.hits ? `; ${res.hits} matching lines` : ""}).`;
  } catch (e) {
    if (gen !== hpGen) return;
    hp.err = e instanceof Error ? e.message : String(e);
  } finally {
    if (gen === hpGen) hp.status = "idle";
  }
}
function anchorRange(q: Suggestion): { from: number; to: number } | null {
  if (!view || !q.anchor) return null;
  const doc = view.state.doc.toString();
  const lo = Math.max(0, hp.from - 300);
  const i = doc.indexOf(q.anchor, lo);
  return i >= 0 && i <= hp.to + 300 ? { from: i, to: i + q.anchor.length } : null;
}
function showItem(q: Suggestion, on: boolean) {
  if (!view) return;
  const r = on ? anchorRange(q) : null;
  view.dispatch({ effects: setFocusRange.of(r), ...(on && r ? { scrollIntoView: true } : {}) });
  if (on && r) view.dispatch({ effects: EditorView.scrollIntoView(r.from, { y: "center" }) });
}
function dismiss(q: Suggestion, taken = false) { recordTaste(q.type, taken); dismissed.add(q.id); hp.items = hp.items.filter((x) => x.id !== q.id); view?.dispatch({ effects: setFocusRange.of(null) }); }
const docHref = (id: string) => `lanthorn://doc/${id}`;
function linkAnchor(q: Suggestion, href: string): boolean {
  if (!view) return false;
  const r = anchorRange(q);
  if (!r) { hp.err = "The words to link have changed since this was suggested."; return false; }
  const before = view.state.sliceDoc(Math.max(0, r.from - 1), r.from);
  if (before === "[") { hp.err = "That is already a link."; return false; }
  view.dispatch({ changes: { from: r.from, to: r.to, insert: `[${q.anchor}](${href})` }, effects: setFocusRange.of(null), userEvent: "input.link" });
  return true;
}
async function applyLink(q: Suggestion) {
  hp.err = "";
  if (q.doc) { if (linkAnchor(q, docHref(q.doc.id))) dismiss(q, true); return; }
  if (!q.url) return;
  hp.busy[q.id] = "Checking the address…";
  try {
    const page = await api.fetchPage(q.url); // (a suggested address is only inserted if it loads)
    if (!page || !page.html) throw new Error("empty");
    if (q.anchor ? linkAnchor(q, q.url) : false) dismiss(q, true);
    else if (!q.anchor && view) { const r = view.state.selection.main; view.dispatch({ changes: { from: r.to, insert: `[${q.title}](${q.url})` } }); dismiss(q, true); }
  } catch {
    hp.err = `That address doesn't load, so I didn't insert it. Try the search instead.`;
    q.url = undefined;
  } finally { delete hp.busy[q.id]; }
}
async function openFileDoc(q: Suggestion) { if (!q.doc?.file) return; await saveNow(); emit("open-file", q.doc.file); }
function webSearch(q: Suggestion) { if (q.query) openUrl(`https://duckduckgo.com/?q=${encodeURIComponent(q.query)}`).catch(() => {}); }
function applyFix(q: Suggestion) {
  if (!view || !q.fix) return;
  const range = { from: hp.from, to: hp.to };
  if (view.state.sliceDoc(range.from, range.to).trim().length < 3) return;
  view.dispatch({ selection: { anchor: range.from, head: range.to } });
  startRewrite();
  rw.instruction = q.fix;
  dismiss(q, true);
  runRewrite();
}
const SUG_LABEL: Record<string, string> = { link: "Link", resource: "Resource", reference: "In your writing", tone: "Tone", style: "Style", consistency: "Consistency" };

// ---- the preview (the reader's typography), kept in step with the editor's scroll
const previewEl = ref<HTMLElement | null>(null);
const html = ref("");
let htmlTimer = 0;
function renderSoon() { window.clearTimeout(htmlTimer); htmlTimer = window.setTimeout(() => { html.value = md.render(text.value); nextTick(resolveImages); }, 120); }
function onPreviewClick(e: MouseEvent) {
  const a = (e.target as HTMLElement).closest("a");
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) openUrl(href).catch(() => {});
  else if (href.startsWith("lanthorn://doc/")) { saveNow().then(() => emit("open-doc", href.slice(15))); }
}
let syncing = false;
function syncPreview() {
  if (mode.value !== "split" || !view || !previewEl.value || syncing) return;
  const s = view.scrollDOM;
  const f = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
  syncing = true;
  previewEl.value.scrollTop = f * Math.max(0, previewEl.value.scrollHeight - previewEl.value.clientHeight);
  requestAnimationFrame(() => (syncing = false));
}

// ---- selection button, status
function updateSel(v: EditorView) {
  const r = v.state.selection.main;
  const ln = v.state.doc.lineAt(r.head);
  cursor.line = ln.number;
  cursor.col = r.head - ln.from + 1;
  cursor.sel = r.empty ? 0 : (v.state.sliceDoc(r.from, r.to).match(/\S+/g) ?? []).length;
  if (r.empty || r.to - r.from < 3 || rw.open) { sel.show = false; return; }
  const c = v.coordsAtPos(r.to);
  const box = paneEl.value?.getBoundingClientRect();
  if (!c || !box) { sel.show = false; return; }
  sel.x = Math.min(box.width - 150, Math.max(8, c.left - box.left));
  sel.y = c.bottom - box.top + 8;
  sel.show = true;
}

onMounted(async () => {
  let initial = "";
  let missing = false;
  if (props.file) {
    try { const f = await api.fileRead(props.file); initial = f.text; fileTime = f.mtime; }
    catch (e) { saveError.value = e instanceof Error ? e.message : String(e); emit("close"); return; }
    try { const raw = await api.libraryGet(id.value); if (raw) { const b = JSON.parse(raw) as Book; prev.value = { imported: b.imported, author: b.author }; } } catch { /* first time */ }
  } else if (props.docId) {
    try {
      const raw = await api.libraryGet(props.docId);
      if (raw) {
        const b = JSON.parse(raw) as Book;
        initial = markdownOfBook(b);
        prev.value = { imported: b.imported, author: b.author };
        if (b.file) { // a document kept in a file: the file is the truth, the library holds a copy
          filePath.value = b.file;
          try { const f = await api.fileRead(b.file); initial = f.text; fileTime = f.mtime; } catch { missing = true; }
        }
      }
    } catch { /* a new document */ }
  } else initial = "# Untitled\n\n";
  if (missing) { notice.value = "The file is missing, so this is the last saved copy. Save as… to put it back."; filePath.value = ""; }
  text.value = initial;
  loaded.value = true;
  snapshot(id.value, initial, "opened");
  view = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: initial,
      extensions: [
        history(),
        drawSelection(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        bracketMatching(),
        closeBrackets(),
        EditorView.lineWrapping,
        lineComp.of(showLines.value ? lineNumbers() : []),
        markdown({ base: markdownLanguage }),
        syntaxHighlighting(hl),
        search({ top: true }),
        rewriteRange,
        focusRange,
        placeholder("Start writing…  Select a passage and press ⌘K to have it rewritten."),
        keymap.of([
          { key: "Mod-b", run: () => !!cmds.bold() },
          { key: "Mod-i", run: () => !!cmds.italic() },
          { key: "Mod-k", run: () => (startRewrite(), true) },
          { key: "Mod-Shift-k", run: () => !!cmds.link() },
          { key: "Mod-Alt-1", run: () => !!cmds.h1() },
          { key: "Mod-Alt-2", run: () => !!cmds.h2() },
          { key: "Mod-Alt-3", run: () => !!cmds.h3() },
          { key: "Mod-Shift-8", run: () => !!cmds.bullet() },
          { key: "Mod-Shift-7", run: () => !!cmds.numbered() },
          { key: "Mod-Shift-9", run: () => !!cmds.quote() },
          { key: "Mod-s", run: () => (saveNow(), true) },
          ...closeBracketsKeymap,
          ...markdownKeymap,
          ...searchKeymap,
          ...historyKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        theme,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) { text.value = u.state.doc.toString(); touched(); renderSoon(); }
          if (u.docChanged || u.selectionSet || u.focusChanged) updateSel(u.view);
          if (u.docChanged || u.selectionSet) scheduleHelper();
        }),
        EditorView.domEventHandlers({
          scroll: () => syncPreview(),
          paste: (e) => { const f = imageFiles(e.clipboardData); if (!f.length) return false; e.preventDefault(); addImageFiles(f); return true; },
          drop: (e) => { const f = imageFiles(e.dataTransfer); if (!f.length) return false; e.preventDefault(); addImageFiles(f); return true; },
        }),
      ],
    }),
  });
  html.value = md.render(initial);
  nextTick(resolveImages);
  window.addEventListener("focus", checkDisk);
  if (!props.docId && !props.file) { view.focus(); view.dispatch({ selection: { anchor: initial.length } }); await saveNow(); }
  else view.focus();
});
onBeforeUnmount(() => { blobs.forEach((u) => URL.revokeObjectURL(u)); window.removeEventListener("focus", checkDisk); window.clearTimeout(htmlTimer); window.clearTimeout(hpTimer); hpGen++; if (saveState.value === "dirty") saveNow(); view?.destroy(); view = null; });

function setMode(m: "edit" | "split" | "preview") { mode.value = m; nextTick(resolveImages); try { localStorage.setItem("lanthorn:ed-mode", m); } catch { /* optional */ } if (m !== "preview") nextTick(() => view?.requestMeasure()); }
function toggleLines() {
  showLines.value = !showLines.value;
  try { localStorage.setItem("lanthorn:ed-lines", showLines.value ? "1" : "0"); } catch { /* optional */ }
  view?.dispatch({ effects: lineComp.reconfigure(showLines.value ? lineNumbers() : []) });
}
async function read() {
  await saveNow();
  if (saveState.value === "error") return;
  emit("read", id.value);
}
async function back() { await saveNow(); emit("close"); }
// ---- outline, focus mode, word goal, web page export
type Head = { level: number; text: string; line: number; n: number };
const winW = ref(window.innerWidth);
const onResize = () => { winW.value = window.innerWidth; };
window.addEventListener("resize", onResize);
onBeforeUnmount(() => window.removeEventListener("resize", onResize));
/** In a narrow window the outline floats over the text instead of taking a column, and the helper takes less. */
const narrow = computed(() => winW.value < 1150);
const outlineOpen = ref(localStorage.getItem("lanthorn:outline") === "1");
const headings = computed<Head[]>(() => {
  const out: Head[] = [];
  let fence = "";
  text.value.split("\n").forEach((l, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (f) { fence = fence ? (l.trim().startsWith(fence[0]) ? "" : fence) : f[1]; return; }
    if (fence) return;
    const m = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ""), line: i + 1, n: out.length });
  });
  return out;
});
const activeHead = computed(() => { let a = -1; for (const h of headings.value) if (h.line <= cursor.line) a = h.n; return a; });
function toggleOutline() { outlineOpen.value = !outlineOpen.value; try { localStorage.setItem("lanthorn:outline", outlineOpen.value ? "1" : "0"); } catch { /* optional */ } }
function gotoHead(h: Head) {
  if (mode.value === "preview") { previewEl.value?.querySelectorAll("h1,h2,h3,h4,h5,h6")[h.n]?.scrollIntoView({ block: "start", behavior: "smooth" }); return; }
  if (!view) return;
  const ln = view.state.doc.line(Math.min(h.line, view.state.doc.lines));
  view.dispatch({ selection: { anchor: ln.from }, effects: EditorView.scrollIntoView(ln.from, { y: "start", yMargin: 24 }) });
  view.focus();
  if (mode.value === "split") previewEl.value?.querySelectorAll("h1,h2,h3,h4,h5,h6")[h.n]?.scrollIntoView({ block: "start" });
}
const focus = ref(false);
function toggleFocus() { focus.value = !focus.value; if (focus.value) { if (mode.value !== "edit") setMode("edit"); hp.open = false; } nextTick(() => { view?.requestMeasure(); view?.focus(); }); }
const goalKey = () => `lanthorn:goal:${id.value}`;
const goal = ref(0);
const goalEdit = ref(false);
function loadGoal() { try { goal.value = Number(localStorage.getItem(goalKey())) || 0; } catch { goal.value = 0; } }
watch(id, loadGoal, { immediate: true });
watch(id, (v) => useBook(`doc:${v}`), { immediate: true }); // (the model's tokens used on this document are counted under it)
function saveGoal() { goalEdit.value = false; goal.value = Math.max(0, Math.round(goal.value) || 0); try { if (goal.value) localStorage.setItem(goalKey(), String(goal.value)); else localStorage.removeItem(goalKey()); } catch { /* optional */ } }
async function saveDocx() {
  const suggested = `${title.value.replace(/[^\w\- ]+/g, "").trim() || "document"}.docx`;
  let path: string | null = null;
  try { path = await saveDialog({ defaultPath: suggested, filters: [{ name: "Word document", extensions: ["docx"] }] }); } catch { path = null; }
  if (!path) return;
  if (!/\.docx$/i.test(path)) path += ".docx";
  try {
    const bytes = await renderDocx(text.value, { title: title.value, author: prev.value?.author ?? "", loadImage: async (src) => { const img = await loadImage(src, { dir: docDir.value }); return img ? forPdf(img) : null; } });
    const n = await api.fileWriteDocx(path, bytes);
    notice.value = `Saved ${baseName(path)} · ${(n / 1024).toFixed(0)} KB`;
  } catch (e) { notice.value = `Couldn't save the Word file: ${e instanceof Error ? e.message : String(e)}`; }
  setTimeout(() => (notice.value = ""), 4000);
}
async function saveHtml() {
  const suggested = `${title.value.replace(/[^\w\- ]+/g, "").trim() || "document"}.html`;
  let path: string | null = null;
  try { path = await saveDialog({ defaultPath: suggested, filters: [{ name: "Web page", extensions: ["html"] }] }); } catch { path = null; }
  if (!path) return;
  if (!/\.html?$/i.test(path)) path += ".html";
  try {
    const page = await exportHtml(text.value, title.value, docDir.value);
    const n = await api.fileWriteHtml(path, page);
    notice.value = `Saved ${baseName(path)} · ${(n / 1024).toFixed(0)} KB`;
  } catch (e) { notice.value = `Couldn't save the page: ${e instanceof Error ? e.message : String(e)}`; }
  setTimeout(() => (notice.value = ""), 4000);
}
// ---- version history (lib/history.ts)
const hist = reactive({ open: false, items: [] as Version[], sel: null as Version | null, name: "", busy: false });
async function openHistory() {
  await saveNow();
  hist.open = true;
  hist.items = await versions(id.value);
  hist.sel = hist.items[0] ?? null;
}
async function saveVersion() {
  const label = hist.name.trim() || "Saved version";
  await snapshot(id.value, text.value, "named", label);
  hist.name = "";
  hist.items = await versions(id.value);
  hist.sel = hist.items[0] ?? null;
}
async function restoreVersion(v: Version) {
  if (!view) return;
  await snapshot(id.value, text.value, "before restoring a version");
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v.text }, userEvent: "input.restore" });
  notice.value = `Restored the version from ${ago(v.t)}. Undo (⌘Z) goes back.`;
  setTimeout(() => (notice.value = ""), 5000);
  hist.items = await versions(id.value);
  hist.open = false;
}
async function dropVersion(v: Version) {
  if (v.key === undefined) return;
  await removeVersion(v.key);
  hist.items = hist.items.filter((x) => x.key !== v.key);
  if (hist.sel?.key === v.key) hist.sel = hist.items[0] ?? null;
}
/** The selected version against the text now: lines removed since (red) and added since (green), unchanged runs folded. */
const histDiff = computed(() => {
  const v = hist.sel;
  if (!hist.open || !v) return [] as { k: "same" | "add" | "del"; t: string }[];
  const out: { k: "same" | "add" | "del"; t: string }[] = [];
  for (const p of diffLines(v.text, text.value)) {
    const lines = p.value.replace(/\n$/, "").split("\n");
    if (p.added) lines.forEach((t) => out.push({ k: "add", t }));
    else if (p.removed) lines.forEach((t) => out.push({ k: "del", t }));
    else if (lines.length > 6) { lines.slice(0, 2).forEach((t) => out.push({ k: "same", t })); out.push({ k: "same", t: `… ${lines.length - 4} unchanged lines …` }); lines.slice(-2).forEach((t) => out.push({ k: "same", t })); }
    else lines.forEach((t) => out.push({ k: "same", t }));
  }
  return out;
});
const showPdf = ref(false);
const copied = ref("");
async function copyMd() { try { await navigator.clipboard.writeText(text.value); copied.value = "Copied"; } catch { copied.value = "Couldn't copy"; } setTimeout(() => (copied.value = ""), 1800); }
const hasText = computed(() => words.value > 0);
const cols = computed(() => (outlineOpen.value && !focus.value && !narrow.value ? "170px " : "") + (mode.value === "split" && !focus.value ? "1fr 1fr" : "1fr") + (hp.open ? (narrow.value ? " 260px" : " 300px") : ""));
if (import.meta.env.DEV) (window as any).__ed = { view: () => view, rw, hp, startRewrite, runRewrite, accept, saveNow, text, cmds, checkNow, toggleHelper, id, applyLink, read, dismiss, filePath, saveAs, checkDisk, conflict, showPdf, addImageFiles, hist, openHistory, saveVersion, restoreVersion, headings, toggleOutline, toggleFocus, saveHtml, saveDocx, goal, outlineOpen, focus };
</script>

<template>
  <div class="ed" :class="{ focus }" @keydown.esc="focus && toggleFocus()">
    <header class="top">
      <button class="ghost" @click="back">← Library</button>
      <div class="name">
        <strong>{{ title }}</strong>
        <span v-if="filePath" class="path" :title="filePath">{{ filePath.replace(/^\/Users\/[^/]+/, "~") }}</span>
        <span :class="['state', saveState]">{{ saveState === "saved" ? "Saved" : saveState === "saving" ? "Saving…" : saveState === "error" ? "Couldn't save: " + saveError : "Editing…" }}</span>
      </div>
      <div class="seg">
        <button :class="{ on: mode === 'edit' }" @click="setMode('edit')">Edit</button>
        <button :class="{ on: mode === 'split' }" @click="setMode('split')">Split</button>
        <button :class="{ on: mode === 'preview' }" @click="setMode('preview')">Preview</button>
      </div>
      <div class="acts">
        <button class="ghost" title="Earlier versions of this document" @click="openHistory">History</button>
        <button class="ghost" title="Copy the Markdown" @click="copyMd">{{ copied || "Copy" }}</button>
        <button class="ghost" title="Export as a PDF, plain or designed" :disabled="!hasText" @click="showPdf = true">PDF</button>
        <button class="ghost" title="Export as a Word document (.docx), pictures included" :disabled="!hasText" @click="saveDocx">Word</button>
        <button class="ghost" title="Export as one web page, pictures included" :disabled="!hasText" @click="saveHtml">HTML</button>
        <button class="ghost" title="Save a copy to a .md file" @click="saveAs">{{ filePath ? "Save as…" : "Save to file…" }}</button>
        <button class="primary" :disabled="!hasText" title="Open this document in the reader, with its pictures" @click="read">Read it</button>
      </div>
    </header>

    <div v-if="conflict" class="banner warn">
      <span>{{ conflict }}</span>
      <button class="ghost sm" @click="reloadFromDisk">Load the file's version</button>
      <button class="ghost sm" @click="saveNow(true)">Overwrite it with mine</button>
    </div>
    <div v-else-if="notice" class="banner">{{ notice }}</div>
    <div v-if="imgMsg" class="banner warn"><span>{{ imgMsg }}</span></div>
    <div class="tools" role="toolbar" aria-label="Formatting">
      <button title="Undo (⌘Z)" @click="cmds.undo()">↶</button>
      <button title="Redo (⇧⌘Z)" @click="cmds.redo()">↷</button>
      <i />
      <button title="Heading 1 (⌥⌘1)" @click="cmds.h1()">H1</button>
      <button title="Heading 2 (⌥⌘2)" @click="cmds.h2()">H2</button>
      <button title="Heading 3 (⌥⌘3)" @click="cmds.h3()">H3</button>
      <i />
      <button title="Bold (⌘B)" class="b" @click="cmds.bold()">B</button>
      <button title="Italic (⌘I)" class="it" @click="cmds.italic()">I</button>
      <button title="Strikethrough" class="st" @click="cmds.strike()">S</button>
      <button title="Inline code" class="mono" @click="cmds.code()">&lt;/&gt;</button>
      <i />
      <button title="Bulleted list (⇧⌘8)" @click="cmds.bullet()">• List</button>
      <button title="Numbered list (⇧⌘7)" @click="cmds.numbered()">1. List</button>
      <button title="Task list" @click="cmds.task()">☑ Tasks</button>
      <button title="Quote (⇧⌘9)" @click="cmds.quote()">❝</button>
      <i />
      <button title="Link (⇧⌘K)" @click="cmds.link()">Link</button>
      <button title="Insert an image (or paste or drop one)" @click="pickImage">Image</button>
      <button title="Code block" class="mono" @click="cmds.codeblock()">{ }</button>
      <button title="Table" @click="cmds.table()">Table</button>
      <button title="Horizontal rule" @click="cmds.rule()">―</button>
      <i />
      <button title="Find and replace (⌘F)" @click="cmds.find()">Find</button>
      <button title="Line numbers" :class="{ on: showLines }" @click="toggleLines">#</button>
      <button title="Outline of the headings" :class="{ on: outlineOpen }" @click="toggleOutline">☰ Outline</button>
      <button title="Focus: just the text (Esc leaves)" @click="toggleFocus">◐ Focus</button>
      <span class="grow" />
      <button class="helper" :class="{ on: hp.open }" title="The writing helper: links, references and tone, from this document and your other writing" @click="toggleHelper">✎ Helper</button>
      <button class="rewrite" title="Rewrite the selection, or the block you're in (⌘K)" @click="startRewrite()">✦ Rewrite…</button>
    </div>

    <div class="body" :class="mode" :style="{ gridTemplateColumns: cols }">
      <nav v-if="outlineOpen && !focus" class="outline" :class="{ float: narrow }" aria-label="Outline">
        <p v-if="!headings.length" class="none">Headings (# Title, ## Section) appear here.</p>
        <button v-for="h in headings" :key="h.n" :class="{ on: h.n === activeHead }" :style="{ paddingLeft: 8 + (h.level - 1) * 12 + 'px' }" :title="h.text" @click="gotoHead(h)">{{ h.text }}</button>
      </nav>
      <div v-show="mode !== 'preview'" ref="paneEl" class="pane">
        <div ref="host" class="cm" />
        <button v-if="sel.show && !rw.open" class="selbtn" :style="{ left: sel.x + 'px', top: sel.y + 'px' }" @mousedown.prevent @click="startRewrite()">✦ Rewrite <kbd>⌘K</kbd></button>

        <div v-if="rw.open" class="rwpanel" @keydown="onPanelKey">
          <div class="rwhead">
            <strong>Rewrite</strong>
            <span class="rwsub">{{ rw.original.length > 90 ? rw.original.slice(0, 90).replace(/\s+/g, " ") + "…" : rw.original.replace(/\s+/g, " ") }}</span>
            <button class="x" title="Close (Esc)" @click="closeRewrite">✕</button>
          </div>
          <template v-if="rw.status !== 'review'">
            <textarea
              ref="instrEl"
              v-model="rw.instruction"
              :disabled="rw.status === 'working'"
              rows="2"
              placeholder="Why should this change? (e.g. “too wordy, tighten it”, “make it sound less defensive”, “explain this to a beginner”)"
              @keydown="onInstrKey"
            />
            <div class="chips">
              <button v-for="c in CHIPS" :key="c" :disabled="rw.status === 'working'" @click="chip(c)">{{ c }}</button>
            </div>
            <div v-if="rw.history.length" class="chips hist">
              <span>Recent</span>
              <button v-for="h in rw.history.slice(0, 3)" :key="h" :disabled="rw.status === 'working'" :title="h" @click="rw.instruction = h">{{ h.length > 34 ? h.slice(0, 34) + "…" : h }}</button>
            </div>
            <p v-if="rw.error" class="rwerr">{{ rw.error }}</p>
            <div class="rwrow">
              <button class="primary" :disabled="rw.status === 'working'" @click="runRewrite">{{ rw.status === "working" ? "Rewriting…" : "Rewrite  ⌘↵" }}</button>
              <button class="ghost" @click="closeRewrite">Cancel</button>
            </div>
          </template>
          <template v-else>
            <div class="diff" tabindex="0"><template v-for="(p, i) in diffParts" :key="i"><ins v-if="p.added">{{ p.value }}</ins><del v-else-if="p.removed">{{ p.value }}</del><span v-else>{{ p.value }}</span></template></div>
            <div class="rwrow">
              <button class="primary" @click="accept">Accept  ⌘↵</button>
              <button class="ghost" @click="retry">Try again…</button>
              <input v-model="rw.retryNote" class="note" placeholder="What was off? (optional)" @keydown.enter.prevent="rw.status = 'idle'; runRewrite()" />
              <button class="ghost" @click="closeRewrite">Discard</button>
            </div>
          </template>
        </div>
      </div>

      <article v-show="mode !== 'edit'" ref="previewEl" class="preview" @click="onPreviewClick">
        <div class="prose" v-html="html" />
      </article>
      <aside v-if="hp.open" class="helperbar">
        <div class="hhead">
          <strong>Helper</strong>
          <label class="auto" title="Look at the paragraph you're writing when you pause"><input type="checkbox" :checked="hp.auto" @change="toggleAuto" /> Auto</label>
          <button class="ghost sm" :disabled="hp.status === 'thinking'" @click="checkNow(true)">{{ hp.status === "thinking" ? "Looking…" : "Check now" }}</button>
        </div>
        <div class="folder">
          <button class="linkbtn" @click="hp.folderOpen = !hp.folderOpen">{{ hp.folder.trim() ? "Also searching: " + hp.folder.trim().split("/").filter(Boolean).slice(-2).join("/") : "Search a folder of your writing too…" }}</button>
          <div v-if="hp.folderOpen" class="frow">
            <input v-model="hp.folder" placeholder="~/Documents/writing" @keydown.enter="saveFolder" />
            <button class="ghost sm" @click="saveFolder">Use</button>
          </div>
        </div>
        <p v-if="hp.label" class="hwatch">Looking at: <em>{{ hp.label }}</em></p>
        <p v-if="hp.status === 'thinking'" class="hnote">Searching this document and your other writing…</p>
        <p v-if="hp.err" class="rwerr">{{ hp.err }}</p>
        <p v-else-if="hp.info && hp.status !== 'thinking'" class="hnote">{{ hp.info }}</p>
        <p v-if="!hp.label && hp.status !== 'thinking' && !hp.info" class="hnote">Write, or select a passage. I'll suggest links to your other writing, sources, and where the tone drifts from the rest.</p>
        <div v-for="q in hp.items" :key="q.id" class="card" :class="q.type" @mouseenter="showItem(q, true)" @mouseleave="showItem(q, false)">
          <div class="ctop"><span class="tag">{{ SUG_LABEL[q.type] }}</span><button class="x" title="Dismiss" @click="dismiss(q)">✕</button></div>
          <strong>{{ q.title }}</strong>
          <p v-if="q.anchor" class="anc">“{{ q.anchor }}”</p>
          <p>{{ q.detail }}</p>
          <p v-if="q.doc" class="from" :title="q.doc.file">{{ q.doc.title }} · line {{ q.doc.line }}</p>
          <div class="cact">
            <button v-if="(q.type === 'link' || q.type === 'reference' || q.type === 'resource') && ((q.doc && !q.doc.file) || q.url) && q.anchor" class="ghost sm" :disabled="!!hp.busy[q.id]" @click="applyLink(q)">{{ hp.busy[q.id] || "Insert link" }}</button>
            <button v-if="q.doc && !q.doc.file" class="ghost sm" @click="emit('open-doc', q.doc.id)">Open</button>
            <button v-if="q.doc && q.doc.file" class="ghost sm" @click="openFileDoc(q)">Open file</button>
            <button v-if="q.query" class="ghost sm" @click="webSearch(q)">Search</button>
            <button v-if="q.fix" class="ghost sm gold" @click="applyFix(q)">Rewrite to fit</button>
          </div>
        </div>
        <p v-if="hp.checks || usage.data.total.calls" class="hnote small">{{ hp.checks }} {{ hp.checks === 1 ? "check" : "checks" }} this session · this document has used {{ fmtTokens(tokensOf(usage.data.total)) }} tokens in {{ usage.data.total.calls }} {{ usage.data.total.calls === 1 ? "call" : "calls" }}<template v-if="usage.data.total.cost"> (about ${{ usage.data.total.cost.toFixed(2) }})</template></p>
      </aside>
    </div>

    <div v-if="hist.open" class="histback" @click.self="hist.open = false" @keydown.esc="hist.open = false">
      <div class="hist" role="dialog" aria-label="Version history">
        <div class="hhead"><strong>Version history</strong><span class="grow" /><button class="ghost sm" @click="hist.open = false">Close</button></div>
        <div class="hbody">
          <div class="hlist">
            <div class="hname"><input v-model="hist.name" placeholder="Name this version…" @keydown.enter="saveVersion" /><button class="ghost sm" @click="saveVersion">Save version</button></div>
            <p v-if="!hist.items.length" class="hnote">No earlier versions yet. They are kept as you write.</p>
            <button v-for="v in hist.items" :key="v.key" class="hitem" :class="{ on: hist.sel?.key === v.key }" @click="hist.sel = v">
              <span class="ht">{{ v.label || ago(v.t) }}</span>
              <span class="hs">{{ v.label ? ago(v.t) + " · " : "" }}{{ v.words.toLocaleString() }} words · {{ v.reason }}</span>
            </button>
          </div>
          <div class="hview">
            <template v-if="hist.sel">
              <div class="hbar"><span>{{ hist.sel.words.toLocaleString() }} words then, {{ words.toLocaleString() }} now</span><span class="grow" /><button class="ghost sm" title="Delete this version" @click="dropVersion(hist.sel)">Delete</button><button class="primary sm" @click="restoreVersion(hist.sel)">Restore this version</button></div>
              <div v-if="hist.sel.text === text" class="hnote">This is the same as the document now.</div>
              <pre v-else class="hdiff"><span v-for="(l, i) in histDiff" :key="i" :class="l.k">{{ l.k === "add" ? "+ " : l.k === "del" ? "− " : "  " }}{{ l.t }}</span></pre>
              <p v-if="hist.sel.text !== text" class="hnote small">Red lines were in that version and are not in the document now; green lines are new since.</p>
            </template>
          </div>
        </div>
      </div>
    </div>
    <ExportPdf v-if="showPdf" :text="text" :title="title" :dir="docDir" @close="showPdf = false" />
    <footer class="status">
      <span>{{ words.toLocaleString() }} {{ words === 1 ? "word" : "words" }}</span>
      <span>{{ text.length.toLocaleString() }} characters</span>
      <span>{{ readMins }} min read</span>
      <span class="goal" :title="goal ? 'Word goal: click to change' : 'Set a word goal'" @click="goalEdit = true">
        <template v-if="goalEdit"><input v-model.number="goal" type="number" min="0" step="100" autofocus @click.stop @keydown.enter="saveGoal" @keydown.esc.stop="goalEdit = false" @blur="saveGoal" /> words</template>
        <template v-else-if="goal"><i class="gbar"><b :style="{ width: Math.min(100, (words / goal) * 100) + '%' }" :class="{ met: words >= goal }" /></i>{{ words.toLocaleString() }} / {{ goal.toLocaleString() }}</template>
        <template v-else>Set a goal</template>
      </span>
      <span class="grow" />
      <span v-if="cursor.sel">{{ cursor.sel }} selected</span>
      <span>Ln {{ cursor.line }}, Col {{ cursor.col }}</span>
    </footer>
  </div>
</template>

<style scoped>
.ed { position: fixed; inset: 0; z-index: 1; background: var(--bg); color: var(--ink); display: grid; grid-template-rows: auto auto auto minmax(0, 1fr) auto; font: 13px system-ui, sans-serif; }
.top { display: grid; grid-template-columns: auto 1fr auto auto; gap: 14px; align-items: center; padding: 38px 16px 8px; border-bottom: 1px solid #1f232a; }
.name { display: grid; gap: 1px; min-width: 0; }
.name strong { font: 600 15px system-ui, sans-serif; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.state { font-size: 11px; color: #6d7280; }
.path { font: 11px ui-monospace, Menlo, monospace; color: #6d7280; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.banner { display: flex; gap: 10px; align-items: center; padding: 7px 16px; background: #1a2230; color: #9ec4ff; font-size: 12.5px; border-bottom: 1px solid #2c3f5f; }
.banner.warn { background: #2a2315; color: #e8c870; border-color: #5a4a22; }
.banner span { flex: 1; }
.state.dirty, .state.saving { color: #c9a54a; }
.state.error { color: #e59a9a; }
.seg { display: inline-flex; border: 1px solid #2b2f38; border-radius: 8px; overflow: hidden; }
.seg button { background: transparent; color: #9a9ea8; border: 0; padding: 6px 12px; cursor: pointer; font: 12px system-ui, sans-serif; }
.seg button.on { background: #262a33; color: #e9e6dd; }
.acts { display: flex; gap: 8px; }
button { font: 600 12px system-ui, sans-serif; cursor: pointer; border-radius: 7px; }
button.ghost { background: transparent; color: #aab; border: 1px solid #2b2f38; padding: 6px 12px; }
button.ghost:hover { border-color: #3a3f4a; color: #e9e6dd; }
button.primary { background: #c9a54a; color: #15120a; border: 0; padding: 7px 14px; }
button:disabled { opacity: 0.5; cursor: default; }
.tools { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; padding: 6px 14px; border-bottom: 1px solid #1f232a; background: #12151a; }
.tools button { background: transparent; color: #c8c5ba; border: 1px solid transparent; padding: 4px 8px; min-width: 28px; font: 600 12px system-ui, sans-serif; }
.tools button:hover { background: #20242c; border-color: #2b2f38; }
.tools button.on { background: #262a33; color: #e8c870; }
.tools .b { font-weight: 800; }
.tools .it { font-style: italic; font-family: Georgia, serif; }
.tools .st { text-decoration: line-through; }
.tools .mono { font-family: ui-monospace, Menlo, monospace; font-size: 11px; }
.tools i { width: 1px; height: 18px; background: #2b2f38; margin: 0 5px; }
.tools .rewrite { background: #2a2515; color: #e8c870; border-color: #5a4a22; }
.tools .rewrite:hover { background: #352e18; }
.grow { flex: 1; }
.body { position: relative; display: grid; min-height: 0; grid-template-columns: 1fr; }
.body.split { grid-template-columns: 1fr 1fr; }
.pane { position: relative; min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid #1f232a; }
.body:not(.split) .pane { border-right: 0; }
.cm { height: 100%; }
.cm :deep(.cm-editor) { height: 100%; }
.cm :deep(.cm-scroller) { overflow: auto; }
.selbtn { position: absolute; z-index: 5; background: #2a2515; color: #e8c870; border: 1px solid #5a4a22; padding: 5px 10px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45); }
.selbtn kbd { font: 10px ui-monospace, Menlo, monospace; color: #9a8c5a; margin-left: 4px; }
.preview { min-width: 0; min-height: 0; overflow-y: auto; padding: 20px 0 40vh; background: #0f1115; }
.prose { max-width: 40em; margin: 0 auto; padding: 0 28px; font: 18px/1.75 "Iowan Old Style", Palatino, Georgia, serif; color: #e0dccf; }
.prose :deep(h1) { font: 600 2em/1.15 "Iowan Old Style", Palatino, Georgia, serif; margin: 0.2em 0 0.6em; letter-spacing: -0.01em; }
.prose :deep(h2) { font: italic 400 1.45em/1.3 "Iowan Old Style", Palatino, Georgia, serif; color: #b8b2a2; margin: 1.8em 0 0.6em; }
.prose :deep(h3), .prose :deep(h4) { font: 600 1.1em/1.4 system-ui, sans-serif; letter-spacing: 0.04em; color: #b8b2a2; margin: 1.5em 0 0.4em; }
.prose :deep(p) { margin: 0 0 1.2em; }
.prose :deep(a) { color: #7fb3ff; }
.prose :deep(blockquote) { margin: 1.2em 0; padding: 0 0 0 1.1em; border-left: 3px solid #3a3f4a; color: #a8a490; font-style: italic; }
.prose :deep(code) { font: 0.82em ui-monospace, Menlo, monospace; background: #1b1f26; padding: 1px 6px; border-radius: 5px; color: #9fd0b8; }
.prose :deep(pre) { background: #14171d; border: 1px solid #23272f; border-radius: 10px; padding: 12px 14px; overflow-x: auto; }
.prose :deep(pre code) { background: none; padding: 0; }
.prose :deep(ul), .prose :deep(ol) { padding-left: 1.4em; margin: 0 0 1.2em; }
.prose :deep(li) { margin: 0.25em 0; }
.prose :deep(hr) { border: 0; border-top: 1px solid #2b2f38; margin: 2em 0; }
.prose :deep(table) { border-collapse: collapse; margin: 1.2em 0; font: 15px system-ui, sans-serif; }
.prose :deep(th), .prose :deep(td) { border: 1px solid #2b2f38; padding: 6px 12px; text-align: left; }
.prose :deep(th) { background: #171a21; }
.prose :deep(img) { max-width: 100%; height: auto; border-radius: 6px; display: block; margin: 1.1em auto; }
.prose :deep(img.mdimg:not(.loaded)) { min-height: 28px; min-width: 120px; background: #1b1f26; }
.prose :deep(.mdfig) { display: block; margin: 1em 0; text-align: center; }
.prose :deep(.mdfig img) { max-width: 100%; }
.prose :deep(.mdcap) { display: block; margin-top: 6px; font-size: 0.88em; font-style: italic; color: #8b8f99; }
.prose :deep(.imgmiss) { display: block; margin: 1em 0; padding: 10px 12px; border: 1px dashed #3a3f4a; border-radius: 8px; color: #8b8f99; font: 13px system-ui, sans-serif; }
.histback { position: absolute; inset: 0; z-index: 30; background: rgba(8, 10, 14, .62); display: grid; place-items: center; }
.hist { width: min(960px, 94vw); height: min(640px, 86vh); background: #14171d; border: 1px solid #2a2f38; border-radius: 12px; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.55); }
.hhead { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid #232830; }
.hbody { display: grid; grid-template-columns: 270px minmax(0, 1fr); min-height: 0; }
.hlist { overflow: auto; border-right: 1px solid #232830; padding: 8px; display: flex; flex-direction: column; gap: 4px; }
.hname { display: flex; gap: 6px; margin-bottom: 6px; }
.hname input { flex: 1; min-width: 0; background: #0e1014; color: inherit; border: 1px solid #2a2f38; border-radius: 6px; padding: 4px 8px; font: inherit; }
.hitem { all: unset; cursor: pointer; display: flex; flex-direction: column; gap: 2px; padding: 7px 9px; border-radius: 7px; border: 1px solid transparent; }
.hitem:hover { background: #1a1e25; }
.hitem.on { background: #1b2230; border-color: #2f3b55; }
.hitem .ht { color: #e6e8ee; font-size: 13px; }
.hitem .hs { color: #7c8290; font-size: 11.5px; }
.hview { display: flex; flex-direction: column; min-height: 0; padding: 10px 14px; gap: 8px; }
.hbar { display: flex; align-items: center; gap: 8px; color: #aab0bd; font-size: 12.5px; }
.hdiff { flex: 1; overflow: auto; margin: 0; background: #0e1014; border-radius: 8px; padding: 10px; font: 12.5px/1.55 ui-monospace, Menlo, monospace; white-space: pre-wrap; color: #8b909b; }
.hdiff .add { background: rgba(80, 180, 120, .16); color: #b8e6c8; display: block; }
.hdiff .del { background: rgba(220, 90, 90, .16); color: #f0b4b4; display: block; }
.hdiff .same { display: block; }
.outline.float { position: absolute; z-index: 5; left: 0; top: 0; bottom: 0; width: 200px; box-shadow: 4px 0 16px rgba(0,0,0,.45); }
.outline { overflow: auto; border-right: 1px solid #1f232a; background: #101318; padding: 8px 0; display: flex; flex-direction: column; }
.outline button { all: unset; cursor: pointer; padding: 4px 10px; font-size: 12.5px; color: #aab0bd; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-left: 2px solid transparent; }
.outline button:hover { background: #181c23; color: #e6e8ee; }
.outline button.on { color: #e6e8ee; border-left-color: #7aa2f7; background: #161a21; }
.outline .none { margin: 8px 12px; color: #6d7280; font-size: 12px; }
.goal { cursor: pointer; display: inline-flex; gap: 6px; align-items: center; }
.goal:hover { color: #aab0bd; }
.goal input { width: 70px; background: #0e1014; color: inherit; border: 1px solid #2a2f38; border-radius: 4px; padding: 1px 4px; font: inherit; }
.gbar { width: 60px; height: 4px; border-radius: 2px; background: #232830; display: inline-block; overflow: hidden; }
.gbar b { display: block; height: 100%; background: #7aa2f7; }
.gbar b.met { background: #6fcf97; }
.ed.focus { grid-template-rows: minmax(0, 1fr); }
.ed.focus > .top, .ed.focus > .tools, .ed.focus > .status, .ed.focus > .banner { display: none; }
.ed.focus .pane :deep(.cm-content) { max-width: 44em; margin: 0 auto; padding: 8vh 24px; }
.ed.focus .pane :deep(.cm-gutters) { display: none; }
.ed.focus .pane :deep(.cm-activeLine) { background: transparent; }
.status { display: flex; gap: 16px; align-items: center; padding: 5px 16px; border-top: 1px solid #1f232a; color: #6d7280; font-size: 11.5px; background: #12151a; }
.rwpanel { position: absolute; z-index: 6; left: 50%; bottom: 18px; transform: translateX(-50%); width: min(640px, calc(100% - 32px)); background: #171a21; border: 1px solid #3a3f4a; border-radius: 14px; padding: 12px 14px 14px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6); display: grid; gap: 10px; max-height: 70%; overflow: auto; }
.rwhead { display: flex; gap: 10px; align-items: baseline; min-width: 0; }
.rwhead strong { font-size: 13px; color: #e8c870; }
.rwsub { color: #7a7e89; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; font-style: italic; }
.x { background: transparent; border: 0; color: #7a7e89; font-size: 13px; padding: 2px 6px; }
textarea { background: #0f1115; color: #e9e6dd; border: 1px solid #2b2f38; border-radius: 9px; padding: 9px 11px; font: 14px/1.5 system-ui, sans-serif; resize: vertical; min-height: 52px; }
textarea:focus, .note:focus { outline: 1px solid #c9a54a; border-color: #c9a54a; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.chips span { color: #6d7280; font-size: 11px; margin-right: 2px; }
.chips button { background: #1d2129; color: #b8bcc6; border: 1px solid #2b2f38; padding: 3px 9px; font: 500 11.5px system-ui, sans-serif; border-radius: 99px; }
.chips button:hover:not(:disabled) { border-color: #5a4a22; color: #e8c870; }
.chips.hist button { font-style: italic; }
.rwrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.note { flex: 1; min-width: 120px; background: #0f1115; color: #e9e6dd; border: 1px solid #2b2f38; border-radius: 8px; padding: 6px 9px; font: 12.5px system-ui, sans-serif; }
.rwerr { margin: 0; color: #e59a9a; font-size: 12.5px; }
.diff { white-space: pre-wrap; font: 15px/1.7 "Iowan Old Style", Palatino, Georgia, serif; background: #0f1115; border: 1px solid #23272f; border-radius: 9px; padding: 10px 12px; max-height: 38vh; overflow: auto; color: #cfcabb; }
.diff ins { background: rgba(110, 190, 130, 0.22); color: #c8f0d2; text-decoration: none; border-radius: 3px; }
.diff del { background: rgba(220, 110, 110, 0.2); color: #f0b4b4; text-decoration: line-through; border-radius: 3px; }

.tools .helper { background: #1a2230; color: #9ec4ff; border-color: #2c3f5f; margin-right: 4px; }
.tools .helper.on { background: #223149; }
.helperbar { min-width: 0; min-height: 0; overflow-y: auto; background: #12151a; border-left: 1px solid #1f232a; padding: 12px 12px 40px; display: grid; gap: 10px; align-content: start; }
.hhead { display: flex; gap: 10px; align-items: center; }
.hhead strong { font-size: 13px; color: #9ec4ff; flex: 1; }
.auto { display: inline-flex; gap: 4px; align-items: center; color: #8b8f99; font-size: 11.5px; }
.sm { padding: 3px 9px; font-size: 11.5px; }
.folder { display: grid; gap: 6px; }
.linkbtn { background: none; border: 0; color: #7a7e89; font: 11.5px system-ui, sans-serif; text-align: left; padding: 0; text-decoration: underline; cursor: pointer; }
.frow { display: flex; gap: 6px; }
.frow input { flex: 1; min-width: 0; background: #0f1115; color: #e9e6dd; border: 1px solid #2b2f38; border-radius: 7px; padding: 5px 8px; font: 12px ui-monospace, Menlo, monospace; }
.hwatch, .hnote { margin: 0; color: #7a7e89; font-size: 12px; line-height: 1.5; }
.hwatch em { color: #9a9ea8; }
.hnote.small { font-size: 11px; color: #5d616c; }
.card { background: #171a21; border: 1px solid #262a33; border-radius: 11px; padding: 10px 12px; display: grid; gap: 5px; }
.card:hover { border-color: #3a3f4a; }
.card strong { font-size: 13px; color: #e9e6dd; }
.card p { margin: 0; font-size: 12.5px; line-height: 1.5; color: #aeb1ba; }
.card .anc { color: #e8c870; font-style: italic; }
.card .from { color: #6d7280; font-size: 11.5px; }
.ctop { display: flex; justify-content: space-between; align-items: center; }
.tag { font: 600 10px system-ui, sans-serif; text-transform: uppercase; letter-spacing: 0.08em; color: #7fb3ff; }
.card.tone .tag, .card.style .tag { color: #e8a85a; }
.card.consistency .tag { color: #e58a8a; }
.card.reference .tag, .card.link .tag { color: #8fd0a0; }
.cact { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 3px; }
.cact .gold { color: #e8c870; border-color: #5a4a22; }
@media (max-width: 620px) { .body.split { grid-template-columns: 1fr; } .body.split .preview { display: none; } }
</style>
