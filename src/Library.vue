<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "./lib/api";
import type { Book, BookMeta } from "./lib/book";
import { importFile, importHtml, importText } from "./lib/import";

const props = defineProps<{ currentId?: string | null }>();
const emit = defineEmits<{ (e: "open", id: string): void; (e: "close"): void }>();

const books = ref<BookMeta[]>([]);
const busy = ref("");
const error = ref("");
const url = ref("");
const dragging = ref(false);
const picker = ref<HTMLInputElement | null>(null);
const sampleAvailable = ref(false);

async function refresh() {
  try { books.value = await api.libraryList(); } catch { books.value = []; }
}

onMounted(async () => {
  await refresh();
  if (import.meta.env.DEV) {
    try { sampleAvailable.value = (await fetch("/books/time-machine.txt", { method: "HEAD" })).ok; } catch { /* no sample */ }
  }
});

async function store(book: Book) {
  await api.librarySave(book.id, JSON.stringify(book));
  await refresh();
  emit("open", book.id);
}

async function run(label: string, f: () => Promise<Book>) {
  busy.value = label;
  error.value = "";
  try {
    await store(await f());
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = "";
  }
}

const fromFiles = (files: FileList | File[] | null) => {
  const f = files && Array.from(files)[0];
  if (f) run(`Importing ${f.name}…`, () => importFile(f));
};

function onDrop(e: DragEvent) {
  dragging.value = false;
  fromFiles(e.dataTransfer?.files ?? null);
}

function fromUrl() {
  const u = url.value.trim();
  if (!u) return;
  run("Fetching the page…", async () => {
    const page = await api.fetchPage(u);
    return importHtml(page.html, page.finalUrl, "url", page.finalUrl);
  });
}

function sample() {
  run("Importing the sample…", async () => importText(await (await fetch("/books/time-machine.txt")).text(), "time-machine.txt"));
}

async function remove(b: BookMeta) {
  await api.libraryDelete(b.id);
  if (b.id.startsWith("pkg-")) await api.packageRemove(b.id.slice(4)).catch(() => {}); // its bundled assets go too
  await refresh();
}
</script>

<template>
  <div class="lib" :class="{ drag: dragging }" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="onDrop">
    <header>
      <h1>Library</h1>
      <button v-if="props.currentId" class="ghost" @click="emit('close')">Back to reading</button>
    </header>

    <section class="add">
      <div class="drop">
        <strong>Drop a book here</strong>
        <span>.lanthorn package, EPUB, text, Markdown or a saved web page</span>
        <button :disabled="!!busy" @click="picker?.click()">Choose a file…</button>
        <input ref="picker" type="file" accept=".lanthorn,.epub,.txt,.md,.markdown,.html,.htm,.xhtml,text/plain" hidden @change="fromFiles(($event.target as HTMLInputElement).files)" />
      </div>
      <div class="link">
        <strong>Or paste a link</strong>
        <span>Any article or long page. Lanthorn pulls out the main text.</span>
        <div class="row">
          <input v-model="url" type="url" placeholder="https://…" @keydown.enter="fromUrl" />
          <button :disabled="!!busy || !url.trim()" @click="fromUrl">Read it</button>
        </div>
      </div>
    </section>

    <p v-if="busy" class="status">{{ busy }}</p>
    <p v-if="error" class="err">{{ error }}</p>

    <section>
      <h2>Your books</h2>
      <p v-if="!books.length" class="empty">
        Nothing here yet. Import a book above<template v-if="sampleAvailable">, or <button class="linkbtn" @click="sample">try the sample (The Time Machine)</button></template>.
      </p>
      <ul v-else class="books">
        <li v-for="b in books" :key="b.id" :class="{ current: b.id === props.currentId }" @click="emit('open', b.id)">
          <div class="t">
            <strong>{{ b.title }}</strong>
            <span>{{ b.author || "Unknown author" }}<em v-if="b.kind" class="kind">{{ ({ epub: "EPUB", text: "Text", markdown: "Markdown", html: "HTML file", url: "Web page", lanthorn: "Package" } as Record<string, string>)[b.kind] ?? b.kind }}</em></span>
          </div>
          <span class="n">{{ b.chapters }} {{ b.chapters === 1 ? "chapter" : "chapters" }}</span>
          <button class="ghost del" title="Remove from the library" @click.stop="remove(b)">Remove</button>
        </li>
      </ul>
      <p v-if="books.length && sampleAvailable" class="empty"><button class="linkbtn" @click="sample">Import the sample (The Time Machine)</button></p>
    </section>
  </div>
</template>

<style scoped>
.lib { background: var(--bg); position: relative; z-index: 1; height: 100vh; overflow-y: auto; padding: 40px clamp(20px, 6vw, 80px) 64px; box-sizing: border-box; color: var(--ink); font: 14px system-ui, sans-serif; }
.lib.drag { outline: 2px dashed #c9a54a; outline-offset: -14px; }
header { max-width: 760px; margin: 0 auto 18px; display: flex; justify-content: space-between; align-items: center; }
h1 { font: 600 22px/1.2 system-ui, sans-serif; margin: 0; }
h2 { font: 600 15px/1.3 system-ui, sans-serif; margin: 0 0 10px; }
section { max-width: 760px; margin: 22px auto 0; }
.add { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.drop, .link { border: 1px dashed #2b2f38; border-radius: 12px; padding: 18px; display: grid; gap: 8px; align-content: start; background: #12151a; }
.drop span, .link span { color: #8b8f99; font-size: 12.5px; }
.row { display: flex; gap: 8px; margin-top: 4px; }
.row input { flex: 1; }
input[type="url"] { background: #0f1115; color: var(--ink); border: 1px solid #2b2f38; border-radius: 8px; padding: 8px 10px; font: 13px system-ui, sans-serif; min-width: 0; }
input:focus { outline: 1px solid #c9a54a; border-color: #c9a54a; }
button { background: #c9a54a; color: #15120a; border: 0; border-radius: 8px; padding: 8px 14px; font: 600 12.5px system-ui, sans-serif; cursor: pointer; justify-self: start; }
button:disabled { opacity: 0.5; cursor: default; }
button.ghost { background: transparent; color: #aab; border: 1px solid #2b2f38; }
.linkbtn { background: none; color: #c9a54a; padding: 0; border: 0; text-decoration: underline; font-weight: 500; }
.status { max-width: 760px; margin: 14px auto 0; color: #c9a54a; }
.err { max-width: 760px; margin: 14px auto 0; padding: 10px 12px; background: #2a1717; color: #e59a9a; border-radius: 8px; }
.empty { color: #8b8f99; }
.books { list-style: none; padding: 0; margin: 0; display: grid; gap: 6px; }
.books li { display: grid; grid-template-columns: 1fr auto auto; gap: 14px; align-items: center; padding: 12px 14px; border: 1px solid #1f232a; border-radius: 10px; cursor: pointer; background: #12151a; }
.books li:hover { border-color: #3a3f4a; }
.books li.current { border-color: #5a4a22; }
.t { display: grid; gap: 2px; min-width: 0; }
.t strong { font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.t span, .n { color: #8b8f99; font-size: 12.5px; }
.del { padding: 5px 10px; }
.kind { font-style: normal; margin-left: 10px; padding: 1px 8px; border: 1px solid #2b2f38; border-radius: 99px; font-size: 11px; color: #8b8f99; }
@media (max-width: 640px) { .add { grid-template-columns: 1fr; } }
</style>
