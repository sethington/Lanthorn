// PDF: the text layer read in page order into paragraphs (lines joined, hyphens mended, running heads and page numbers dropped, large type
// made a heading), then split into chapters the way Markdown is. Scanned pages with no text layer give nothing to read.
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Book } from "../book";
import { importText } from "./text";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Line = { y: number; x: number; text: string; size: number; page: number };

export async function importPdf(data: Uint8Array, filename: string): Promise<Book> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const lines: Line[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 1500); p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows: { y: number; items: { x: number; s: string; size: number; w: number }[] }[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== "string" || !it.str.trim()) continue;
      const y = it.transform[5], x = it.transform[4], size = Math.abs(it.transform[3]) || it.height || 10;
      let row = rows.find((r) => Math.abs(r.y - y) < size * 0.35);
      if (!row) rows.push((row = { y, items: [] }));
      row.items.push({ x, s: it.str, size, w: it.width ?? it.str.length * size * 0.5 });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      r.items.sort((a, b) => a.x - b.x);
      let text = "", end = -1e9;
      for (const it of r.items) { if (text && it.x - end > it.size * 0.3 && !text.endsWith(" ")) text += " "; text += it.s; end = it.x + it.w; }
      const size = r.items.reduce((m, i) => Math.max(m, i.size), 0);
      lines.push({ y: r.y, x: r.items[0].x, text: text.replace(/\s+/g, " ").trim(), size, page: p });
    }
  }
  if (!lines.length) throw new Error("That PDF has no text to read (it may be scanned pictures of pages).");
  // running heads and feet: short lines that repeat on many pages at the same height, and bare page numbers
  const pages = new Set(lines.map((l) => l.page)).size;
  const seen = new Map<string, number>();
  for (const l of lines) { const k = `${Math.round(l.y / 4)}|${l.text.replace(/\d+/g, "#").toLowerCase()}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
  const body = lines.filter((l) => !/^\s*(page\s*)?\d{1,4}\s*$/i.test(l.text) && !(l.text.length < 70 && pages > 3 && (seen.get(`${Math.round(l.y / 4)}|${l.text.replace(/\d+/g, "#").toLowerCase()}`) ?? 0) > Math.max(3, pages * 0.4)));
  const sizes = body.map((l) => l.size).sort((a, b) => a - b);
  const med = sizes[Math.floor(sizes.length / 2)] || 10;
  const gaps: number[] = [];
  for (let i = 1; i < body.length; i++) if (body[i].page === body[i - 1].page) gaps.push(body[i - 1].y - body[i].y);
  const lineGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length * 0.4)] || med * 1.2;
  const out: string[] = [];
  let para = "";
  const flush = () => { if (para.trim()) out.push(para.trim()); para = ""; };
  for (let i = 0; i < body.length; i++) {
    const l = body[i], prev = body[i - 1];
    const heading = l.size > med * 1.22 && l.text.length < 100;
    if (heading) { flush(); const last = out[out.length - 1]; if (last && last.startsWith("# ") && prev && prev.size > med * 1.22) out[out.length - 1] = last + " " + l.text; else out.push("# " + l.text); continue; }
    const gapY = prev && prev.page === l.page ? prev.y - l.y : 0;
    const newPara = !prev || prev.size > med * 1.22 || (gapY > lineGap * 1.55) || (prev.page !== l.page && /[.!?"”]$/.test(prev.text) && false);
    if (newPara) flush();
    if (para.endsWith("-") && /^[a-z]/.test(l.text)) para = para.slice(0, -1) + l.text; // a word broken at the line's end
    else para += (para ? " " : "") + l.text;
  }
  flush();
  const meta: any = await doc.getMetadata().catch(() => null);
  const title = (meta?.info?.Title as string | undefined)?.trim();
  const book = importText(out.join("\n\n"), filename, "markdown");
  if (title && title.length > 2) book.title = title;
  if (meta?.info?.Author && !book.author) book.author = String(meta.info.Author).trim();
  book.source = { kind: "pdf", ref: filename };
  return book;
}
