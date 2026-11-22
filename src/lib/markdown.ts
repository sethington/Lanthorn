// Markdown documents. One markdown-it instance (no raw HTML, so nothing in a document can run) for the editor's preview, and a converter
// from a document to the one shape the reader understands: chapters of plain prose.

import MarkdownIt from "markdown-it";
import { type Book, type Chapter, makeChapter } from "./book";
import { hashStr } from "./text";

export const md = new MarkdownIt({ html: false, linkify: true, typographer: true, breaks: false });

/** The visible words of an inline token run: text, code and image alt text; no markup characters. */
function inlineText(tok: { children?: any[] | null; content: string }): string {
  if (!tok.children) return tok.content;
  let s = "";
  for (const c of tok.children) {
    if (c.type === "text" || c.type === "code_inline") s += c.content;
    else if (c.type === "softbreak" || c.type === "hardbreak") s += " ";
    else if (c.type === "image") s += c.content || "";
  }
  return s;
}

export type DocChapter = { title: string; paragraphs: string[] };

/** A document's title (its first # heading) and its sections: split at ## headings (and any later # heading); deeper headings stay as lines of their own. */
export function parseDoc(src: string): { title: string; sections: DocChapter[] } {
  const toks = md.parse(src.replace(/\r\n?/g, "\n"), {});
  let title = "";
  const sections: DocChapter[] = [];
  let cur: DocChapter = { title: "", paragraphs: [] };
  let seenH1 = false;
  const flush = () => { if (cur.paragraphs.length) sections.push(cur); };
  const para = (s: string) => { const t = s.replace(/\s+/g, " ").trim(); if (t) cur.paragraphs.push(t); };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "heading_open") {
      const level = Number(t.tag.slice(1));
      const text = inlineText(toks[i + 1] ?? { content: "" }).trim();
      if (level === 1 && !seenH1) { seenH1 = true; title = text; cur.title = cur.title || text; }
      else if (level <= 2) { flush(); cur = { title: text, paragraphs: [] }; }
      else para(text);
      i += 2;
    } else if (t.type === "inline") {
      // a paragraph, list item, table cell or quote line: its words, as prose
      const parent = toks[i - 1];
      if (parent && (parent.type === "td_open" || parent.type === "th_open")) continue; // (table rows are gathered below)
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
    if (text.trim()) chapters.push(makeChapter(chapters.length, s.title || name, text));
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
