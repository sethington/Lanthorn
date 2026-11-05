import { type Book, MAX_IMPORT_BYTES } from "../book";
import { importEpub } from "./epub";
import { importLanthorn } from "./lanthorn";
import { importHtml } from "./html";
import { importText } from "./text";

/** Import a file the user picked or dropped. Everything is parsed here, in the webview, into plain text. */
export async function importFile(file: File): Promise<Book> {
  if (file.size > MAX_IMPORT_BYTES) throw new Error("That file is too large to import (limit 60 MB).");
  const name = file.name;
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (ext === "lanthorn") return importLanthorn(new Uint8Array(await file.arrayBuffer()), name);
  if (ext === "epub") return importEpub(new Uint8Array(await file.arrayBuffer()), name);
  if (ext === "html" || ext === "htm" || ext === "xhtml") return importHtml(await file.text(), name, "html");
  if (ext === "md" || ext === "markdown") return importText(await file.text(), name, "markdown");
  if (ext === "pdf" || ext === "docx" || ext === "mobi" || ext === "azw3" || ext === "azw") {
    throw new Error(`.${ext} files aren't supported yet. EPUB, text, Markdown and HTML work, and a web page can be pasted as a link.`);
  }
  return importText(await file.text(), name, "text");
}

export { importEpub, importHtml, importLanthorn, importText };
