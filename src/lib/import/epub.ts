// EPUB: a zip of XHTML plus an OPF manifest. We read metadata, the reading order (spine) and the table of contents.

import { strFromU8, unzipSync } from "fflate";
import { type Book, type Chapter, MAX_IMPORT_BYTES, makeBook, makeChapter } from "../book";
import { leafBlocks, norm, parseDoc } from "./dom";

const MAX_ENTRIES = 6000;
const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const TEXTY = /\.(xml|opf|ncx|xhtml|html|htm)$/i;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
function resolve(base: string, href: string): string {
  const parts = (dirOf(base) + decodeURIComponent(href.split("#")[0])).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

const FRONT = /^(contents|table of contents|copyright|cover|title page|half title|licen[sc]e|colophon|about the author|also by|acknowledg|dedication)|project gutenberg/i;

export function importEpub(bytes: Uint8Array, filename: string): Book {
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error("That file is too large to import.");
  let count = 0;
  // read only text-like entries, and refuse anything that unpacks suspiciously large (zip bombs)
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (++count > MAX_ENTRIES) throw new Error("This EPUB has too many files.");
      return TEXTY.test(f.name) && f.originalSize <= MAX_ENTRY_BYTES;
    },
  });
  const text = (path: string) => (files[path] ? strFromU8(files[path]) : null);

  const container = text("META-INF/container.xml");
  if (!container) throw new Error("Not a valid EPUB (no container.xml).");
  const opfPath = new DOMParser().parseFromString(container, "application/xml").querySelector("rootfile")?.getAttribute("full-path");
  const opfText = opfPath ? text(opfPath) : null;
  if (!opfPath || !opfText) throw new Error("Not a valid EPUB (package file missing).");
  const opf = new DOMParser().parseFromString(opfText, "application/xml");

  const dc = (name: string) => norm(Array.from(opf.getElementsByTagNameNS("*", name))[0]?.textContent ?? "");
  const title = dc("title") || filename.replace(/\.epub$/i, "");
  const author = dc("creator");

  const manifest = new Map<string, { href: string; type: string; props: string }>();
  for (const it of Array.from(opf.getElementsByTagNameNS("*", "item"))) {
    manifest.set(it.getAttribute("id") ?? "", { href: it.getAttribute("href") ?? "", type: it.getAttribute("media-type") ?? "", props: it.getAttribute("properties") ?? "" });
  }
  const spine = Array.from(opf.getElementsByTagNameNS("*", "itemref")).filter((r) => r.getAttribute("linear") !== "no").map((r) => r.getAttribute("idref") ?? "");

  // table of contents: EPUB3 nav document, or EPUB2 NCX
  const toc = new Map<string, string>();
  const nav = Array.from(manifest.values()).find((m) => m.props.split(/\s+/).includes("nav"));
  const ncxId = opf.getElementsByTagNameNS("*", "spine")[0]?.getAttribute("toc");
  const ncx = ncxId ? manifest.get(ncxId) : undefined;
  try {
    if (nav) {
      const p = resolve(opfPath, nav.href);
      const doc = parseDoc(text(p) ?? "");
      for (const a of Array.from(doc.querySelectorAll("nav a"))) {
        const href = a.getAttribute("href");
        if (href) { const k = resolve(p, href); if (!toc.has(k)) toc.set(k, norm(a.textContent ?? "")); }
      }
    } else if (ncx) {
      const p = resolve(opfPath, ncx.href);
      const doc = new DOMParser().parseFromString(text(p) ?? "", "application/xml");
      for (const np of Array.from(doc.getElementsByTagNameNS("*", "navPoint"))) {
        const label = norm(np.getElementsByTagNameNS("*", "text")[0]?.textContent ?? "");
        const src = np.getElementsByTagNameNS("*", "content")[0]?.getAttribute("src");
        if (src) { const k = resolve(p, src); if (!toc.has(k)) toc.set(k, label); }
      }
    }
  } catch { /* a broken TOC just means we fall back to headings */ }

  const chapters: Chapter[] = [];
  for (const id of spine) {
    const item = manifest.get(id);
    if (!item || !/x?html/i.test(item.type)) continue;
    const path = resolve(opfPath, item.href);
    const markup = text(path);
    if (!markup) continue;
    const doc = parseDoc(markup);
    const body = doc.body ?? doc.documentElement;
    const blocks = leafBlocks(body);
    const heading = norm(blocks.find((b) => /^h[1-6]$/i.test(b.tagName))?.textContent ?? "");
    const chTitle = toc.get(path) || heading || "";
    let paras = blocks.map((b) => norm(b.textContent ?? "")).filter(Boolean);
    if (paras[0] && (paras[0] === heading || paras[0] === chTitle)) paras = paras.slice(1); // the heading is shown separately
    const body_ = paras.join("\n\n");
    if (body_.length < 300 || FRONT.test(chTitle)) continue; // cover, title page, contents, copyright…
    // "IV. Time Travelling" -> number IV, title Time Travelling (same shape the text importer produces)
    const m = chTitle.match(/^([IVXLC]+|\d{1,3})\.\s+(.+)$/);
    chapters.push(makeChapter(chapters.length, m ? m[2] : chTitle || `Section ${chapters.length + 1}`, body_, m ? m[1] : undefined));
  }
  if (!chapters.length) throw new Error("No readable text found in this EPUB (it may be image-based or DRM-protected).");
  return makeBook({ title, author, source: { kind: "epub", ref: filename }, chapters });
}
