// Markdown to a paginated PDF, laid out here with pdf-lib (real text, links that click, page numbers), in the look a Theme describes.
// Only the standard PDF fonts are used, so nothing is embedded and nothing needs a licence; a character they can't show becomes "?".

import { PDFDocument, PDFFont, PDFName, PDFPage, PDFString, StandardFonts, rgb } from "pdf-lib";
import { md } from "../markdown";
import { type Family, type Theme, onColour, rgbOf } from "./theme";

// ---- blocks
type Run = { t: string; b?: boolean; i?: boolean; code?: boolean; href?: string; s?: boolean };
type Block =
  | { k: "h"; level: number; runs: Run[] }
  | { k: "p"; runs: Run[] }
  | { k: "list"; ordered: boolean; start: number; items: Block[][] }
  | { k: "quote"; blocks: Block[] }
  | { k: "code"; text: string }
  | { k: "hr" }
  | { k: "img"; src: string; alt: string; title: string }
  | { k: "table"; head: Run[][]; rows: Run[][][] };

function inlineRuns(children: any[] | null | undefined, content = ""): Run[] {
  if (!children) return content ? [{ t: content }] : [];
  const out: Run[] = [];
  let b = 0, i = 0, s = 0;
  let href: string | undefined;
  for (const c of children) {
    if (c.type === "strong_open") b++;
    else if (c.type === "strong_close") b--;
    else if (c.type === "em_open") i++;
    else if (c.type === "em_close") i--;
    else if (c.type === "s_open") s++;
    else if (c.type === "s_close") s--;
    else if (c.type === "link_open") href = c.attrGet?.("href") ?? undefined;
    else if (c.type === "link_close") href = undefined;
    else if (c.type === "text") out.push({ t: c.content, b: b > 0, i: i > 0, s: s > 0, href });
    else if (c.type === "code_inline") out.push({ t: c.content, code: true, b: b > 0, i: i > 0, href });
    else if (c.type === "softbreak") out.push({ t: " ", href });
    else if (c.type === "hardbreak") out.push({ t: "\n", href });
    else if (c.type === "image") out.push({ t: c.content ? `[${c.content}]` : "", i: true });
  }
  return out;
}

export function blocksOf(src: string): Block[] {
  const toks = md.parse(src.replace(/\r\n?/g, "\n"), {});
  let n = 0;
  const until = (close: string): Block[] => {
    const out: Block[] = [];
    while (n < toks.length) {
      const t = toks[n];
      if (t.type === close) { n++; return out; }
      n++;
      if (t.type === "heading_open") { const inl = toks[n]; n += 2; out.push({ k: "h", level: Number(t.tag.slice(1)), runs: inlineRuns(inl.children, inl.content) }); }
      else if (t.type === "paragraph_open") {
        const inl = toks[n]; n += 2;
        // an image in a paragraph is a figure of its own: the text before it, the picture, the text after
        const kids: any[] = inl.children ?? [];
        if (kids.some((c) => c.type === "image")) {
          let run: any[] = [];
          const flush = () => { const r = inlineRuns(run); if (r.some((q) => q.t.trim())) out.push({ k: "p", runs: r }); run = []; };
          for (const c of kids) {
            if (c.type === "image") { flush(); out.push({ k: "img", src: c.attrGet?.("src") ?? "", alt: (c.children ?? []).map((x: any) => x.content).join("") || c.content || "", title: c.attrGet?.("title") ?? "" }); }
            else run.push(c);
          }
          flush();
        } else out.push({ k: "p", runs: inlineRuns(inl.children, inl.content) });
      }
      else if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
        const ordered = t.type === "ordered_list_open";
        const start = Number(t.attrGet?.("start") ?? 1) || 1;
        const items: Block[][] = [];
        while (n < toks.length && toks[n].type !== (ordered ? "ordered_list_close" : "bullet_list_close")) { if (toks[n].type === "list_item_open") { n++; items.push(until("list_item_close")); } else n++; }
        n++;
        out.push({ k: "list", ordered, start, items });
      } else if (t.type === "blockquote_open") out.push({ k: "quote", blocks: until("blockquote_close") });
      else if (t.type === "fence" || t.type === "code_block") out.push({ k: "code", text: t.content.replace(/\n$/, "") });
      else if (t.type === "hr") out.push({ k: "hr" });
      else if (t.type === "table_open") {
        const head: Run[][] = [], rows: Run[][][] = [];
        let inHead = false, row: Run[][] = [];
        while (n < toks.length && toks[n].type !== "table_close") {
          const x = toks[n++];
          if (x.type === "thead_open") inHead = true;
          else if (x.type === "thead_close") inHead = false;
          else if (x.type === "tr_open") row = [];
          else if (x.type === "inline") row.push(inlineRuns(x.children, x.content));
          else if (x.type === "tr_close") { if (inHead) head.push(...row); else rows.push(row); }
        }
        n++;
        out.push({ k: "table", head, rows });
      }
    }
    return out;
  };
  return until("\u0000");
}

// ---- the page
export type PdfImage = { bytes: Uint8Array; kind: "png" | "jpg"; w: number; h: number };
export type PdfOptions = { size: "letter" | "a4"; author: string; title?: string; cover: boolean; date?: string; /** gives the bytes of an image the document refers to (null: it can't be found) */ loadImage?: (src: string) => Promise<PdfImage | null> };
type Word = { text: string; font: PDFFont; size: number; color: [number, number, number]; width: number; href?: string; under?: boolean; strike?: boolean; gap: number; joined?: boolean; br?: boolean };
const SIZES = { letter: [612, 792], a4: [595.28, 841.89] } as const;
const col = (h: string) => { const [r, g, b] = rgbOf(h); return [r / 255, g / 255, b / 255] as [number, number, number]; };
const RGB = (c: [number, number, number]) => rgb(c[0], c[1], c[2]);

export async function renderPdf(src: string, theme: Theme, opts: PdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const [W, H] = SIZES[opts.size];
  const F: Record<Family, { r: PDFFont; b: PDFFont; i: PDFFont; bi: PDFFont }> = {
    serif: { r: await doc.embedFont(StandardFonts.TimesRoman), b: await doc.embedFont(StandardFonts.TimesRomanBold), i: await doc.embedFont(StandardFonts.TimesRomanItalic), bi: await doc.embedFont(StandardFonts.TimesRomanBoldItalic) },
    sans: { r: await doc.embedFont(StandardFonts.Helvetica), b: await doc.embedFont(StandardFonts.HelveticaBold), i: await doc.embedFont(StandardFonts.HelveticaOblique), bi: await doc.embedFont(StandardFonts.HelveticaBoldOblique) },
    mono: { r: await doc.embedFont(StandardFonts.Courier), b: await doc.embedFont(StandardFonts.CourierBold), i: await doc.embedFont(StandardFonts.CourierOblique), bi: await doc.embedFont(StandardFonts.CourierBoldOblique) },
  };
  const charsets = new Map<PDFFont, Set<number>>();
  const supported = (f: PDFFont) => { let s = charsets.get(f); if (!s) { s = new Set(f.getCharacterSet()); charsets.set(f, s); } return s; };
  const REPL: Record<string, string> = { "→": "->", "←": "<-", "✓": "v", "✔": "v", "✗": "x", "≤": "<=", "≥": ">=", "≠": "!=", "−": "-", "‑": "-", " ": " ", " ": " ", "​": "", "️": "" };
  const clean = (f: PDFFont, text: string) => {
    const set = supported(f);
    let out = "";
    for (const ch of text.replace(/\t/g, "    ")) {
      const cp = ch.codePointAt(0)!;
      if (REPL[ch] !== undefined) out += REPL[ch];
      else if (set.has(cp)) out += ch;
      else { const d = ch.normalize("NFD").replace(/[̀-ͯ]/g, ""); out += d !== ch && [...d].every((c) => set.has(c.codePointAt(0)!)) ? d : cp > 0x2000 ? "" : "?"; }
    }
    return out;
  };

  const ink = col(theme.colors.ink), muted = col(theme.colors.muted), accent = col(theme.colors.accent), paper = col(theme.colors.paper), band = col(theme.colors.band);
  const tint = (c: [number, number, number], t: number): [number, number, number] => [paper[0] + (c[0] - paper[0]) * t, paper[1] + (c[1] - paper[1]) * t, paper[2] + (c[2] - paper[2]) * t];
  const M = theme.page.margin;
  const textW = W - 2 * M;
  const bodySize = theme.body.size;
  const lead = bodySize * theme.body.leading;
  const footerRoom = theme.page.footer === "none" ? 0 : 22;
  const bottom = M + footerRoom * 0.6;

  const pages: { page: PDFPage; cover: boolean }[] = [];
  let page!: PDFPage;
  let y = 0;
  const links = new Map<PDFPage, { x: number; y: number; w: number; h: number; href: string }[]>();

  function decorate(p: PDFPage) {
    if (theme.colors.paper !== "#ffffff") p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: RGB(paper) });
    const o = M * 0.42;
    if (theme.page.border === "thin") p.drawRectangle({ x: o, y: o, width: W - 2 * o, height: H - 2 * o, borderColor: RGB(accent), borderWidth: 0.75 });
    else if (theme.page.border === "double") { p.drawRectangle({ x: o, y: o, width: W - 2 * o, height: H - 2 * o, borderColor: RGB(accent), borderWidth: 1.4 }); p.drawRectangle({ x: o + 4, y: o + 4, width: W - 2 * o - 8, height: H - 2 * o - 8, borderColor: RGB(accent), borderWidth: 0.4 }); }
    else if (theme.page.border === "corners") {
      const L = 22;
      for (const [cx, cy, dx, dy] of [[o, o, 1, 1], [W - o, o, -1, 1], [o, H - o, 1, -1], [W - o, H - o, -1, -1]] as const) {
        p.drawLine({ start: { x: cx, y: cy }, end: { x: cx + dx * L, y: cy }, thickness: 1.1, color: RGB(accent) });
        p.drawLine({ start: { x: cx, y: cy }, end: { x: cx, y: cy + dy * L }, thickness: 1.1, color: RGB(accent) });
      }
    }
  }
  function newPage(cover = false) {
    page = doc.addPage([W, H]);
    pages.push({ page, cover });
    decorate(page);
    y = H - M;
    return page;
  }
  const room = () => y - bottom;
  const ensure = (h: number) => { if (room() < h) newPage(); };

  // ---- text: runs to words, words to lines
  const fontFor = (fam: Family, r: Run, boldAll = false, italicAll = false) => {
    const f = F[r.code ? "mono" : fam];
    const b = boldAll || r.b, i = italicAll || r.i;
    return b && i ? f.bi : b ? f.b : i ? f.i : f.r;
  };
  function wordsOf(runs: Run[], o: { fam: Family; size: number; color: [number, number, number]; bold?: boolean; italic?: boolean; caps?: boolean }): Word[] {
    const out: Word[] = [];
    for (const r of runs) {
      const font = fontFor(o.fam, r, o.bold, o.italic);
      const size = r.code ? o.size * 0.88 : o.size;
      const color = r.href ? accent : r.code ? tint(ink, 0.85) : o.color;
      const text = clean(font, o.caps ? r.t.toUpperCase() : r.t);
      const parts = text.split(/(\s+)/);
      for (const part of parts) {
        if (!part) continue;
        if (/^\s+$/.test(part)) { const last = out[out.length - 1]; if (last) { if (part.includes("\n")) last.br = true; last.joined = false; last.gap = font.widthOfTextAtSize(" ", size); } continue; }
        out.push({ text: part, font, size, color, width: font.widthOfTextAtSize(part, size), href: r.href, under: !!r.href, strike: r.s, gap: 0, joined: true });
      }
    }
    return out;
  }
  type Line = { words: Word[]; width: number; hard: boolean };
  function wrap(words: Word[], widthFor: (line: number) => number): Line[] {
    // words that touch (a word, then the comma after it, or a link and the full stop that follows) stay together on a line
    const clusters: Word[][] = [];
    for (const w of words) { const c = clusters[clusters.length - 1]; if (c && c[c.length - 1].joined && !c[c.length - 1].br) c.push(w); else clusters.push([w]); }
    const lines: Line[] = [];
    let cur: Word[] = [], w = 0;
    const lineW = () => widthFor(lines.length);
    const trail = (x: Word) => (x.joined ? 0 : x.gap);
    const push = (hard: boolean) => { const lastW = cur[cur.length - 1]; lines.push({ words: cur, width: w - (lastW ? trail(lastW) : 0), hard }); cur = []; w = 0; };
    for (const cl of clusters) {
      const cw = cl.reduce((a, x) => a + x.width + (x === cl[cl.length - 1] ? 0 : trail(x)), 0);
      if (cl.length === 1 && cl[0].width > lineW() && cl[0].text.length > 1) {
        // a single word longer than the line is broken
        let wd = cl[0];
        while (wd.width > lineW() && wd.text.length > 1) {
          let cut = wd.text.length - 1;
          while (cut > 1 && wd.font.widthOfTextAtSize(wd.text.slice(0, cut), wd.size) > lineW() - w) cut--;
          if (cur.length && w > 0) push(false);
          const head = wd.text.slice(0, cut);
          cur.push({ ...wd, text: head, width: wd.font.widthOfTextAtSize(head, wd.size), gap: 0, joined: true, br: false });
          w = wd.font.widthOfTextAtSize(head, wd.size);
          push(false);
          const rest = wd.text.slice(cut);
          wd = { ...wd, text: rest, width: wd.font.widthOfTextAtSize(rest, wd.size) };
        }
        cur.push(wd); w += wd.width + trail(wd);
      } else {
        if (cur.length && w + cw > lineW() + 0.01) push(false);
        cur.push(...cl);
        w += cw + trail(cl[cl.length - 1]);
      }
      if (cl[cl.length - 1].br) push(true);
    }
    if (cur.length) push(true);
    return lines;
  }
  function drawLine(l: Line, x: number, baseline: number, width: number, justify: boolean, last: boolean) {
    const gaps = l.words.filter((q, k) => k < l.words.length - 1 && !q.joined).length;
    let extra = 0;
    if (justify && !last && !l.hard && gaps > 0) extra = Math.max(0, (width - l.width) / gaps);
    let cx = x;
    for (let k = 0; k < l.words.length; k++) {
      const wd = l.words[k];
      if (wd.text) page.drawText(wd.text, { x: cx, y: baseline, size: wd.size, font: wd.font, color: RGB(wd.color) });
      if (wd.under) page.drawLine({ start: { x: cx, y: baseline - 1.6 }, end: { x: cx + wd.width + (!wd.joined && l.words[k + 1]?.under && l.words[k + 1].href === wd.href ? wd.gap : 0), y: baseline - 1.6 }, thickness: 0.5, color: RGB(wd.color) });
      if (wd.strike) page.drawLine({ start: { x: cx, y: baseline + wd.size * 0.3 }, end: { x: cx + wd.width, y: baseline + wd.size * 0.3 }, thickness: 0.6, color: RGB(wd.color) });
      if (wd.href) { const a = links.get(page) ?? []; a.push({ x: cx, y: baseline - 2, w: wd.width + (!wd.joined && l.words[k + 1]?.href === wd.href ? wd.gap : 0), h: wd.size + 3, href: wd.href }); links.set(page, a); }
      cx += wd.width + (k < l.words.length - 1 && !wd.joined ? wd.gap + extra : 0);
    }
  }

  type ParaOpts = { x?: number; width?: number; size?: number; color?: [number, number, number]; fam?: Family; bold?: boolean; italic?: boolean; justify?: boolean; space?: number; before?: number; bar?: boolean; box?: boolean; dropCap?: boolean; align?: "left" | "center"; keepNext?: number };
  function paragraph(runs: Run[], o: ParaOpts = {}) {
    const size = o.size ?? bodySize;
    const lh = size * theme.body.leading;
    const x0 = o.x ?? M;
    const width = o.width ?? textW - (x0 - M);
    const fam = o.fam ?? theme.body.font;
    let first = runs;
    let cap = "";
    if (o.dropCap && runs.length && runs[0].t.trim().length > 1 && !runs[0].i && runs.reduce((a, r) => a + r.t.length, 0) >= 160) { cap = runs[0].t.trimStart()[0]; first = [{ ...runs[0], t: runs[0].t.trimStart().slice(1) }, ...runs.slice(1)]; }
    const words = wordsOf(first, { fam, size, color: o.color ?? ink, bold: o.bold, italic: o.italic });
    const capSize = size * 3.1;
    const capFont = F[theme.heading.font].b;
    const capW = cap ? capFont.widthOfTextAtSize(clean(capFont, cap), capSize) + 5 : 0;
    const lines = wrap(words, (n) => (cap && n < 3 ? width - capW : width));
    if (!lines.length) return;
    y -= o.before ?? 0;
    // keep a paragraph from starting on the last line of a page, or leaving one line behind
    const need = Math.min(lines.length, Math.max(2, 1 + (o.keepNext ?? 0))) * lh;
    if (room() < need) newPage();
    let capDrawn = false;
    lines.forEach((l, k) => {
      if (room() < lh) { newPage(); capDrawn = true; }
      const baseline = y - size * 0.85;
      const dx = cap && k < 3 && !capDrawn ? capW : 0;
      if (o.box) page.drawRectangle({ x: x0 - 6, y: y - lh + (lh - size) * 0.3, width: width + 12, height: lh, color: RGB(tint(accent, 0.1)) });
      if (o.bar) page.drawRectangle({ x: x0 - 11, y: y - lh + (lh - size) * 0.3, width: 2.5, height: lh, color: RGB(accent) });
      if (cap && k === 0) page.drawText(clean(capFont, cap), { x: x0, y: y - capSize * 0.72, size: capSize, font: capFont, color: RGB(accent) });
      const align = o.align === "center";
      drawLine(l, align ? x0 + (width - l.width) / 2 : x0 + dx, baseline, (cap && k < 3 ? width - capW : width), (o.justify ?? theme.body.justify) && !align, k === lines.length - 1);
      y -= lh;
    });
    y -= o.space ?? bodySize * 0.55;
  }

  // ---- ornaments and rules
  function ornament(kind: Theme["title"]["ornament"], cx: number, cy: number, big = 1) {
    const c = RGB(accent);
    if (kind === "rule") page.drawLine({ start: { x: cx - 36 * big, y: cy }, end: { x: cx + 36 * big, y: cy }, thickness: 1.2, color: c });
    else if (kind === "diamond") {
      page.drawLine({ start: { x: cx - 70 * big, y: cy }, end: { x: cx - 10 * big, y: cy }, thickness: 0.8, color: c });
      page.drawLine({ start: { x: cx + 10 * big, y: cy }, end: { x: cx + 70 * big, y: cy }, thickness: 0.8, color: c });
      const d = 4.5 * big;
      page.drawSvgPath(`M 0 ${-d} L ${d} 0 L 0 ${d} L ${-d} 0 Z`, { x: cx, y: cy, color: c, scale: 1 });
    } else if (kind === "dots") for (const dx of [-14, 0, 14]) page.drawCircle({ x: cx + dx * big, y: cy, size: 2.2 * big, color: c });
    else if (kind === "asterism") { const f = F.serif.b; const t = "*   *   *"; const s = 16 * big; page.drawText(t, { x: cx - f.widthOfTextAtSize(t, s) / 2, y: cy - 5, size: s, font: f, color: c }); }
    else if (kind === "wave") { let d = ""; for (let k = 0; k <= 24; k++) { const px = -60 * big + (k * 120 * big) / 24; d += `${k ? "L" : "M"} ${px.toFixed(1)} ${(-Math.sin((k / 24) * Math.PI * 4) * 3 * big).toFixed(2)} `; } page.drawSvgPath(d, { x: cx, y: cy, borderColor: c, borderWidth: 1 }); }
  }
  function spacedText(text: string, x: number, baseline: number, font: PDFFont, size: number, color: [number, number, number], track: number) {
    let cx = x;
    for (const ch of text) { page.drawText(ch, { x: cx, y: baseline, size, font, color: RGB(color) }); cx += font.widthOfTextAtSize(ch, size) + track; }
  }

  // ---- blocks
  function heading(b: Extract<Block, { k: "h" }>) {
    const hs = theme.heading.scale;
    const size = bodySize * (b.level === 1 ? 1.9 : b.level === 2 ? 1.5 : b.level === 3 ? 1.22 : 1.05) * (b.level <= 3 ? hs : 1);
    const lh = size * 1.25;
    const fam = theme.heading.font;
    const center = theme.heading.align === "center" && b.level <= 2;
    const runs = b.runs;
    const words = wordsOf(runs, { fam, size, color: b.level >= 4 ? muted : ink, bold: theme.heading.bold, caps: theme.heading.caps || b.level >= 4 });
    const lines = wrap(words, () => textW);
    const before = b.level <= 2 ? bodySize * 1.5 : bodySize * 0.9;
    if (b.level === 2 && theme.chapterBreak && y < H - M - 20) newPage();
    ensure(before + lines.length * lh + bodySize * 2.5 + lead * 2); // (a heading is never left at the bottom of a page)
    if (y < H - M - 1) y -= before;
    if ((theme.heading.rule === "over" || theme.heading.rule === "both") && b.level <= 2) { page.drawLine({ start: { x: M, y: y }, end: { x: M + textW, y: y }, thickness: 0.8, color: RGB(accent) }); y -= 8; }
    lines.forEach((l) => {
      const baseline = y - size * 0.85;
      const x = center ? M + (textW - l.width) / 2 : M;
      if (theme.heading.spaced && b.level <= 3) {
        // letter-spaced: drawn a letter at a time
        let cx = center ? M + (textW - (l.width + l.words.reduce((a, w) => a + w.text.length * size * 0.08, 0))) / 2 : M;
        l.words.forEach((wd, k) => { spacedText(wd.text, cx, baseline, wd.font, wd.size, wd.color, size * 0.08); cx += wd.width + wd.text.length * size * 0.08 + (k < l.words.length - 1 ? wd.font.widthOfTextAtSize(" ", wd.size) + size * 0.08 : 0); });
      } else drawLine(l, x, baseline, textW, false, true);
      y -= lh;
    });
    if ((theme.heading.rule === "under" || theme.heading.rule === "both") && b.level <= 2) { y -= 2; page.drawLine({ start: { x: M, y }, end: { x: M + textW, y }, thickness: 0.8, color: RGB(accent) }); y -= 7; }
    else if (theme.heading.rule === "short" && b.level <= 2) { y -= 3; const w0 = center ? M + textW / 2 - 18 : M; page.drawLine({ start: { x: w0, y }, end: { x: w0 + 36, y }, thickness: 2, color: RGB(accent) }); y -= 8; }
    y -= bodySize * 0.55;
  }
  let firstPara = true;
  function renderBlocks(blocks: Block[], x: number, width: number, depth = 0, quote = false) {
    for (const b of blocks) {
      if (b.k === "h") { heading(b); firstPara = b.level <= 2; }
      else if (b.k === "p") {
        const dropCap = theme.body.dropCap && firstPara && !quote && depth === 0;
        paragraph(b.runs, { x, width, dropCap, ...(quote ? quoteOpts() : {}) });
        firstPara = false;
      } else if (b.k === "list") {
        let n = b.start;
        for (const item of b.items) {
          const marker = b.ordered ? `${n++}.` : depth % 2 ? "–" : "•";
          const mf = F[theme.body.font][b.ordered ? "r" : "b"];
          const mx = x + 4;
          const before = y;
          ensure(lead * 1.5);
          const mw = mf.widthOfTextAtSize(clean(mf, marker), bodySize);
          const first = y;
          // the marker sits on the first line of the item, wherever the page breaks
          const startPage = page;
          page.drawText(clean(mf, marker), { x: mx + (b.ordered ? 14 - mw : 0), y: first - bodySize * 0.85, size: bodySize, font: mf, color: RGB(b.ordered ? ink : accent) });
          void before; void startPage;
          renderBlocks(item.map((q, qi) => (q.k === "p" && qi === 0 ? q : q)), x + 20, width - 20, depth + 1, quote);
          y += bodySize * 0.55 - bodySize * 0.2; // (items sit closer than paragraphs)
        }
        y -= bodySize * 0.35;
      } else if (b.k === "quote") renderBlocks(b.blocks, x + 16, width - 16, depth, true);
      else if (b.k === "code") codeBlock(b.text, x, width);
      else if (b.k === "hr") { ensure(24); y -= 8; if (theme.title.ornament !== "none") ornament(theme.title.ornament, W / 2, y - 4, 0.7); else page.drawLine({ start: { x: M + textW * 0.3, y }, end: { x: M + textW * 0.7, y }, thickness: 0.6, color: RGB(muted) }); y -= 16; }
      else if (b.k === "table") table(b, x, width);
      else if (b.k === "img") figure(b, x, width);
    }
  }
  const quoteOpts = (): ParaOpts => (theme.quote === "bar" ? { bar: true, italic: false, color: tint(ink, 0.82) } : theme.quote === "italic" ? { italic: true, color: tint(ink, 0.8) } : theme.quote === "box" ? { box: true, italic: true } : { italic: true, color: tint(ink, 0.8), x: undefined });
  function codeBlock(text: string, x: number, width: number) {
    const f = F.mono.r, size = bodySize * 0.82, lh = size * 1.4;
    const cw = f.widthOfTextAtSize("M", size);
    const per = Math.max(10, Math.floor((width - 14) / cw));
    const rows: string[] = [];
    for (const raw of text.split("\n")) { const l = clean(f, raw); if (!l) rows.push(""); else for (let k = 0; k < l.length; k += per) rows.push(l.slice(k, k + per)); }
    y -= bodySize * 0.2;
    for (const r of rows) {
      if (room() < lh + 6) newPage();
      page.drawRectangle({ x, y: y - lh + 2, width, height: lh, color: RGB(tint(ink, 0.06)) });
      if (r) page.drawText(r, { x: x + 7, y: y - size * 0.95, size, font: f, color: RGB(tint(ink, 0.9)) });
      y -= lh;
    }
    y -= bodySize * 0.8;
  }
  function table(b: Extract<Block, { k: "table" }>, x: number, width: number) {
    const ncol = Math.max(1, b.head[0] ? b.head.length : b.rows[0]?.length ?? 1);
    const size = bodySize * 0.88, pad = 5;
    // columns: as wide as their longest words need, the rest shared by how much text each holds
    const all = [b.head, ...b.rows.map((r) => r)].filter((r) => r.length);
    const need: number[] = Array(ncol).fill(0), len: number[] = Array(ncol).fill(0);
    for (const r of all) r.forEach((cell, c) => { if (c >= ncol) return; const ws = wordsOf(cell, { fam: theme.body.font, size, color: ink }); need[c] = Math.max(need[c], ...ws.map((w) => w.width), 20); len[c] += ws.reduce((a, w) => a + w.width, 0); });
    const avail = width - ncol * pad * 2;
    let cw = need.map((n, c) => n + (Math.max(0, avail - need.reduce((a, v) => a + v, 0)) * len[c]) / Math.max(1, len.reduce((a, v) => a + v, 0)));
    const total = cw.reduce((a, v) => a + v, 0);
    if (total > avail) cw = cw.map((v) => (v * avail) / total);
    const row = (cells: Run[][], head: boolean) => {
      const lines = cells.slice(0, ncol).map((cell, c) => wrap(wordsOf(cell, { fam: theme.body.font, size, color: head ? RGB_ON : ink, bold: head }), () => cw[c]));
      const h = Math.max(1, ...lines.map((l) => l.length)) * size * 1.35 + pad * 1.4;
      if (room() < h) newPage();
      if (head) page.drawRectangle({ x, y: y - h, width: cw.reduce((a, v) => a + v, 0) + ncol * pad * 2, height: h, color: RGB(accent) });
      else page.drawLine({ start: { x, y: y - h }, end: { x: x + cw.reduce((a, v) => a + v, 0) + ncol * pad * 2, y: y - h }, thickness: 0.5, color: RGB(tint(ink, 0.25)) });
      let cx = x;
      lines.forEach((ls, c) => { ls.forEach((l, k) => drawLine(l, cx + pad, y - pad * 0.7 - size * 0.95 - k * size * 1.35, cw[c], false, true)); cx += cw[c] + pad * 2; });
      y -= h;
    };
    const RGB_ON = col(onColour(theme.colors.accent));
    y -= bodySize * 0.2;
    if (b.head.length) row(b.head, true);
    for (const r of b.rows) row(r, false);
    y -= bodySize * 0.8;
  }

  // ---- figures
  const pics = new Map<string, { img: Awaited<ReturnType<typeof doc.embedPng>>; w: number; h: number } | null>();
  function figure(b: Extract<Block, { k: "img" }>, x: number, width: number) {
    const pic = pics.get(b.src);
    const caption = (b.title || b.alt || "").trim();
    if (!pic) { // not found: its description stands in
      paragraph([{ t: `[${b.alt || "image"}${b.src.startsWith("data:") ? "" : ": " + (b.src.length > 60 ? b.src.slice(0, 60) + "…" : b.src)}]`, i: true }], { color: muted, size: bodySize * 0.9 });
      return;
    }
    const maxW = width, maxH = (H - 2 * M) * 0.62;
    let w = pic.w * 0.75, h = pic.h * 0.75; // (pixels at 96 dpi, as points)
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k; h *= k;
    if (w < maxW * 0.25 && pic.w * 0.75 > maxW * 0.25) { const up = (maxW * 0.5) / w; if (h * up <= maxH) { w *= up; h *= up; } } // (a tiny picture is not left a speck)
    const capLines = caption ? wrap(wordsOf([{ t: caption, i: true }], { fam: "serif", size: bodySize * 0.88, color: muted }), () => Math.min(width, Math.max(w, width * 0.6))) : [];
    const capH = capLines.length * bodySize * 0.88 * 1.35 + (capLines.length ? 6 : 0);
    y -= bodySize * 0.4;
    if (room() < h + capH) {
      // not enough room left: a picture that would fit at 60% or more of its size is shrunk to the space, else it starts the next page
      const f = (room() - capH - 4) / h;
      if (f >= 0.6) { w *= f; h *= f; } else newPage();
    }
    const px = x + (width - w) / 2;
    page.drawImage(pic.img, { x: px, y: y - h, width: w, height: h });
    if (theme.page.border !== "none" || theme.colors.paper !== "#ffffff") page.drawRectangle({ x: px, y: y - h, width: w, height: h, borderColor: RGB(tint(ink, 0.18)), borderWidth: 0.5 });
    y -= h + 6;
    capLines.forEach((l) => { const cw = Math.min(width, Math.max(w, width * 0.6)); drawLine(l, x + (width - cw) / 2 + (cw - l.width) / 2, y - bodySize * 0.88 * 0.85, cw, false, true); y -= bodySize * 0.88 * 1.35; });
    y -= bodySize * 0.9;
  }
  const collectImages = (bs: Block[], out: string[]) => { for (const b of bs) { if (b.k === "img") out.push(b.src); else if (b.k === "quote") collectImages(b.blocks, out); else if (b.k === "list") b.items.forEach((it) => collectImages(it, out)); } };

  // ---- the title page
  const blocks = blocksOf(src);
  let title = opts.title?.trim() || "";
  let body = blocks;
  const h1 = blocks.findIndex((b) => b.k === "h" && b.level === 1);
  let titled = false;
  if (h1 >= 0 && !blocks.slice(0, h1).some((b) => b.k !== "hr")) {
    titled = true;
    const hb = blocks[h1] as Extract<Block, { k: "h" }>;
    title = title || hb.runs.map((r) => r.t).join("").trim();
    body = blocks.filter((_, k) => k !== h1);
  }
  title = title || "Untitled";
  if (opts.cover && theme.title.show) {
    newPage(true);
    const fam = theme.heading.font;
    const tsize = Math.min(44, Math.max(26, 520 / Math.max(8, title.length) * 2.2)) * theme.heading.scale;
    const tf = F[fam].b;
    const wrapT = (width: number, caps = false) => wrap(wordsOf([{ t: title }], { fam, size: tsize, color: ink, bold: true, caps }), () => width);
    const sub = [opts.author, opts.date].filter(Boolean).join("  ·  ");
    const L = theme.title.layout;
    if (L === "band") {
      const bh = H * 0.46;
      page.drawRectangle({ x: 0, y: H - bh, width: W, height: bh, color: RGB(band) });
      const on = col(onColour(theme.colors.band));
      const lines = wrap(wordsOf([{ t: title }], { fam, size: tsize, color: on, bold: true }), () => textW);
      let ty = H - bh / 2 + (lines.length * tsize * 1.2) / 2;
      lines.forEach((l) => { drawLine(l, M, ty - tsize, textW, false, true); ty -= tsize * 1.2; });
      ornament(theme.title.ornament, M + 40, H - bh - 40);
      if (sub) page.drawText(clean(F.serif.i, sub), { x: M, y: H - bh - 90, size: 13, font: F.serif.i, color: RGB(muted) });
    } else if (L === "left" || L === "stack") {
      const caps = L === "stack";
      const lines = wrapT(textW - 20, caps);
      let ty = H * 0.62 + (lines.length * tsize * 1.2) / 2;
      const top = ty;
      lines.forEach((l) => { drawLine(l, M + 14, ty - tsize, textW, false, true); ty -= tsize * 1.2; });
      page.drawRectangle({ x: M, y: ty + tsize * 0.2, width: 3, height: top - ty, color: RGB(accent) });
      if (L === "stack") { page.drawLine({ start: { x: M, y: top + 22 }, end: { x: M + textW, y: top + 22 }, thickness: 1.2, color: RGB(accent) }); page.drawLine({ start: { x: M, y: ty - 6 }, end: { x: M + textW, y: ty - 6 }, thickness: 0.5, color: RGB(accent) }); ty -= 14; }
      if (sub) page.drawText(clean(F.serif.i, sub), { x: M + 14, y: ty - 28, size: 13, font: F.serif.i, color: RGB(muted) });
      ornament(theme.title.ornament, M + 50, ty - 56);
    } else {
      const lines = wrapT(textW);
      let ty = H * 0.58 + (lines.length * tsize * 1.2) / 2;
      lines.forEach((l) => { drawLine(l, M + (textW - l.width) / 2, ty - tsize, textW, false, true); ty -= tsize * 1.2; });
      ornament(theme.title.ornament, W / 2, ty - 24, 1.2);
      if (sub) { const s = clean(F.serif.i, sub); page.drawText(s, { x: (W - F.serif.i.widthOfTextAtSize(s, 13)) / 2, y: ty - 64, size: 13, font: F.serif.i, color: RGB(muted) }); }
    }
    void tf;
    newPage();
  } else {
    newPage();
    // no cover: the title heads the first page
    if (titled) heading({ k: "h", level: 1, runs: [{ t: title }] });
    const sub = [opts.author, opts.date].filter(Boolean).join("  ·  ");
    if (sub) { paragraph([{ t: sub, i: true }], { color: muted, space: bodySize * 1.2 }); }
  }

  // the pictures the document refers to are fetched and embedded first (those that can't be found are shown as their description)
  {
    const srcs: string[] = [];
    collectImages(body, srcs);
    for (const src of Array.from(new Set(srcs))) {
      let pic: { img: any; w: number; h: number } | null = null;
      try {
        const got = opts.loadImage ? await opts.loadImage(src) : null;
        if (got) pic = { img: got.kind === "png" ? await doc.embedPng(got.bytes) : await doc.embedJpg(got.bytes), w: got.w, h: got.h };
      } catch { pic = null; }
      pics.set(src, pic);
    }
  }
  renderBlocks(body, M, textW);

  // ---- footers, links, metadata
  const content = pages.filter((p) => !p.cover);
  content.forEach((p, k) => {
    if (theme.page.footer === "none") return;
    const f = F.serif.r, size = 9;
    const n = String(k + 1);
    const fy = M * 0.52;
    if (theme.page.footer === "number") p.page.drawText(n, { x: (W - f.widthOfTextAtSize(n, size)) / 2, y: fy, size, font: f, color: RGB(muted) });
    else {
      const t = clean(F.serif.i, title.length > 60 ? title.slice(0, 58) + "…" : title);
      const left = k % 2 === 0;
      p.page.drawText(t, { x: left ? M : W - M - F.serif.i.widthOfTextAtSize(t, size), y: fy, size, font: F.serif.i, color: RGB(muted) });
      p.page.drawText(n, { x: left ? W - M - f.widthOfTextAtSize(n, size) : M, y: fy, size, font: f, color: RGB(muted) });
    }
  });
  for (const [p, list] of links) {
    const annots = list.map((l) => doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Link", Rect: [l.x, l.y, l.x + l.w, l.y + l.h], Border: [0, 0, 0], A: { Type: "Action", S: "URI", URI: PDFString.of(l.href) } })));
    p.node.set(PDFName.of("Annots"), doc.context.obj(annots));
  }
  doc.setTitle(title);
  if (opts.author) doc.setAuthor(opts.author);
  doc.setCreator("Lanthorn");
  doc.setProducer("Lanthorn (pdf-lib)");
  return doc.save();
}
