// A web page or saved HTML file: Mozilla Readability picks out the article; we keep only its text.

import { Readability } from "@mozilla/readability";
import { type Book, type Chapter, makeBook, makeChapter } from "../book";
import { leafBlocks, norm } from "./dom";

export function importHtml(html: string, ref: string, kind: "html" | "url" = "html", baseUrl?: string): Book {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (baseUrl) {
    const b = doc.createElement("base");
    b.href = baseUrl;
    doc.head.prepend(b);
  }
  const pageTitle = norm(doc.title || "");
  const article = new Readability(doc, { keepClasses: false }).parse();
  if (!article || !article.content) throw new Error("Couldn't find the main text on that page.");
  const root = new DOMParser().parseFromString(`<body>${article.content}</body>`, "text/html").body;
  const blocks = leafBlocks(root);

  // long articles with several section headings become chapters; otherwise one
  const h2 = blocks.filter((b) => b.tagName === "H2");
  const title = norm(article.title || pageTitle) || "Untitled page";
  const chapters: Chapter[] = [];
  if (h2.length >= 3) {
    let cur: { title: string; paras: string[] } = { title, paras: [] };
    const flush = () => { if (cur.paras.join(" ").length > 200) chapters.push(makeChapter(chapters.length, cur.title, cur.paras.join("\n\n"))); };
    for (const b of blocks) {
      const t = norm(b.textContent ?? "");
      if (!t) continue;
      if (b.tagName === "H2") { flush(); cur = { title: t, paras: [] }; }
      else cur.paras.push(t);
    }
    flush();
  }
  if (!chapters.length) {
    const paras = blocks.map((b) => norm(b.textContent ?? "")).filter(Boolean);
    if (paras.join(" ").length < 200) throw new Error("That page doesn't have enough text to read.");
    chapters.push(makeChapter(0, title, paras.join("\n\n")));
  }
  const author = norm((article.byline ?? "").replace(/^by\s+/i, "")) || norm(article.siteName ?? "");
  return makeBook({ title, author, source: { kind, ref }, chapters });
}
