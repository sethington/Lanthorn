// Markdown documents. One markdown-it instance (no raw HTML, so nothing in a document can run) for the editor's preview, and a converter
// from a document to the one shape the reader understands: chapters of plain prose.

import MarkdownIt from "markdown-it";
import { type Book, type Chapter, makeChapter } from "./book";
import { hashStr, paragraphsOf } from "./text";

export const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

// an image is drawn by the editor once it has the bytes (a local file, a web address): the markup only says which, and what it is of
const esc = (s: string | number | null) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
md.renderer.rules.image = (tokens, i) => {
  const t = tokens[i];
  const alt = esc(t.children?.map((c) => c.content).join("") || t.content || "");
  const title = String(t.attrGet("title") ?? "");
  const img = `<img class="mdimg" data-src="${esc(t.attrGet("src") ?? "")}" alt="${alt}"${title ? ` title="${esc(title)}"` : ""}>`;
  // an image on a line of its own is a figure, captioned by its title or else its description (as in the PDF); one inside a sentence is just a picture
  const cap = (title || alt).trim();
  return t.meta?.fig && cap ? `<span class="mdfig">${img}<span class="mdcap">${esc(cap)}</span></span>` : img;
};
md.core.ruler.push("lone_images", (state) => {
  for (const t of state.tokens) {
    if (t.type !== "inline" || !t.children) continue;
    const parts = t.children.filter((c) => !(c.type === "softbreak" || (c.type === "text" && !c.content.trim())));
    if (parts.length && parts.every((c) => c.type === "image")) parts.forEach((c) => { c.meta = { ...(c.meta ?? {}), fig: true }; });
  }
  return true;
});
// markdown-it refuses some address forms for links; local and data image paths are plain text to it, which is what the image rule needs
const baseValidate = md.validateLink.bind(md);
md.validateLink = (url: string) => (/^data:image\/(png|jpe?g|gif|webp|bmp);base64,/i.test(url) ? true : baseValidate(url));

/** The visible words of an inline token run: text, code and image alt text; no markup characters. */
function inlineText(tok: { children?: any[] | null; content: string }): string {
  if (!tok.children) return tok.content;
  let s = "";
  for (const c of tok.children) {
    if (c.type === "text" || c.type === "code_inline") s += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") s += " ";
  }
  return s;
}

/** A picture in a document, and where it sits: before paragraph `at` of its section. */
export type DocImage = { at: number; src: string; alt: string; title: string };
export type DocChapter = { title: string; paragraphs: string[]; images: DocImage[] };

/** A document's title (its first # heading) and its sections: split at ## headings (and any later # heading); deeper headings stay as lines of their own. */
export function parseDoc(src: string): { title: string; sections: DocChapter[] } {
  const toks = md.parse(src.replace(/\r\n?/g, "\n"), {});
  let title = "";
  const sections: DocChapter[] = [];
  let cur: DocChapter = { title: "", paragraphs: [], images: [] };
  let seenH1 = false;
  const flush = () => { if (cur.paragraphs.length || cur.images.length) sections.push(cur); };
  const para = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); if (t) cur.paragraphs.push(t); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "heading_open") {
      const level = Number(t.tag.slice(1));
      const text = inlineText(toks[i + 1] ?? { content: "" }).trim();
      if (level === 1 && !seenH1) { seenH1 = true; title = text; cur.title = cur.title || text; }
      else if (level <= 2) { flush(); cur = { title: text, paragraphs: [], images: [] }; }
      else para(text);
      i += 2;
    } else if (t.type === "inline") {
      // a paragraph, list item, table cell or quote line: its words, as prose
      const parent = toks[i - 1];
      if (parent && (parent.type === "td_open" || parent.type === "th_open")) continue; // (table rows are gathered below)
      for (const c of t.children ?? []) if (c.type === "image") cur.images.push({ at: cur.paragraphs.length, src: String(c.attrGet("src") ?? ""), alt: (c.children ?? []).map((x: any) => x.content).join("") || c.content || "", title: String(c.attrGet("title") ?? "") });
      para(inlineText(t));
    } else if (t.type === "fence" || t.type === "code_block") {
      para(t.content);
    } else if (t.type === "tr_open") {
      const cells: string[] = [];
      for (let j = i + 1; j < toks.length && toks[j].type !== "tr_close"; j++) if (toks[j].type === "inline") cells.push(inlineText(toks[j]).trim());
      para(cells.join(" | "));
    }
  }
  flush();
  return { title: title.trim(), sections };
}

/** The plain prose of a document, for word counts and the like. */
export const plainOf = (src: string): string => parseDoc(src).sections.map((s) => s.paragraphs.join("\n\n")).join("\n\n");

/** A document as a book the reader can open: its title from the first # heading, chapters from the sections. */
export function docToBook(src: string, id: string, prev?: Pick<Book, "imported" | "author">, file?: string): Book {
  const { title, sections } = parseDoc(src);
  const name = title || "Untitled";
  const chapters: Chapter[] = [];
  sections.forEach((s) => {
    const text = s.paragraphs.join("\n\n");
    if (!text.trim()) return; // (a section of pictures alone has nothing to read)
    const ch = makeChapter(chapters.length, s.title || name, text);
    // the reader's paragraphs are the text split again (a code block can hold blank lines), so each picture's place is counted in those
    if (s.images.length) ch.images = s.images.map((im) => ({ ...im, at: paragraphsOf(s.paragraphs.slice(0, im.at).join("\n\n")).length }));
    chapters.push(ch);
  });
  if (!chapters.length) chapters.push(makeChapter(0, name, ""));
  return { id, title: name, author: prev?.author ?? "", source: { kind: "markdown", ref: `${name}.md` }, chapters, imported: prev?.imported ?? Date.now(), markdown: src, ...(file ? { file } : {}) };
}

/** The markdown behind a book that has none stored (a plain text or an older import): its chapters as sections. */
export function markdownOfBook(b: Book): string {
  if (b.markdown !== undefined) return b.markdown;
  const body = b.chapters.map((c) => (b.chapters.length > 1 ? `## ${c.num ? c.num + ". " : ""}${c.title}\n\n` : "") + c.text.trim()).join("\n\n");
  return `# ${b.title}\n\n${body}\n`;
}

/** The library id of a document kept in a file on disk (the same file is always the same book). */
export const fileDocId = (path: string) => `file-${hashStr(path)}`;
export const baseName = (path: string) => path.split("/").pop() ?? path;
export const newDocId = () => `doc-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
