// dev only: the PDF importer on a sample file (pdf-test.html?f=name reads dev-samples/name.pdf)
import { importPdf } from "./lib/import/pdf";
const f = new URLSearchParams(location.search).get("f") ?? "sample";
const out = document.getElementById("out")!;
fetch(`/dev-samples/${f}.pdf`).then((r) => r.arrayBuffer()).then((b) => importPdf(new Uint8Array(b), `${f}.pdf`)).then((book) => {
  out.textContent = `${book.title} (${book.source.kind}) by ${book.author}\n` + book.chapters.map((c) => `\n== ${c.num ?? ""} ${c.title}\n` + c.text.slice(0, 400)).join("\n");
}).catch((e) => (out.textContent = "ERROR " + e));
