// dev only: the EPUB importer on a file in books/ (epub-test.html?f=name reads /books/name.epub)
import { importEpub } from "./lib/import/epub";
const f = new URLSearchParams(location.search).get("f") ?? "wind-in-the-willows";
const out = document.getElementById("out")!;
fetch(`/books/${f}.epub`).then((r) => r.arrayBuffer()).then((b) => importEpub(new Uint8Array(b), `${f}.epub`)).then((book) => {
  out.textContent = `${book.title} by ${book.author}: ${book.chapters.length} chapters\n` + book.chapters.map((c) => `${c.num ?? ""} | ${c.title} | ${c.text.length} chars`).join("\n");
}).catch((e) => (out.textContent = "ERROR " + e));
