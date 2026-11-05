// Plain text and Markdown. Chapters come from headings: Roman-numeral lines (Gutenberg style), "Chapter N" lines, or # headings.

import { type Book, type Chapter, makeBook, makeChapter } from "../book";

// Titles for the sample books we ship in dev, because Gutenberg's header is stripped from them.
const KNOWN: Record<string, { title: string; author: string }> = {
  "time-machine": { title: "The Time Machine", author: "H. G. Wells" },
  "treasure-island": { title: "Treasure Island", author: "Robert Louis Stevenson" },
  "call-of-cthulhu": { title: "The Call of Cthulhu", author: "H. P. Lovecraft" },
  "pride-and-prejudice": { title: "Pride and Prejudice", author: "Jane Austen" },
  "alice-in-wonderland": { title: "Alice's Adventures in Wonderland", author: "Lewis Carroll" },
};

const titleCase = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).trim();

// " IV.\n Time Travelling\n": a Roman numeral alone on a line, then a title line
const ROMAN = /\n ([IVXLC]+)\.\n\s*(.+)\n/g;
const CHAPTER_WORD = /^[ \t]*(?:CHAPTER|Chapter)[ \t]+([0-9]+|[IVXLC]+|[A-Za-z-]+)[.:]?[ \t]*(.*)$/gm;
const MD_HEAD = /^#{1,2}[ \t]+(.+)$/gm;
// "_1. The Horror in Clay._" or "2. The Tale": a small number, a dot and a short title alone on a line (Lovecraft-style parts)
const NUMBERED = /^[ \t]*_?([0-9]{1,2})\.[ \t]+([A-Z][^\n]{2,70}?)\.?_?[ \t]*$/gm;

type Hit = { index: number; end: number; num?: string; title: string };

function hits(raw: string, re: RegExp, make: (m: RegExpExecArray) => Omit<Hit, "index" | "end">): Hit[] {
  const out: Hit[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(raw); m; m = re.exec(raw)) out.push({ index: m.index, end: m.index + m[0].length, ...make(m) });
  return out;
}

export function importText(rawIn: string, filename: string, kind: "text" | "markdown" = "text"): Book {
  let raw = rawIn.replace(/\r\n?/g, "\n");
  // Gutenberg marks italics with _underscores_: show the words, not the marks
  if (kind === "text") raw = raw.replace(/(^|[\s(\[“"'‘])_([^_\n]+?)_(?=[\s.,;:!?)\]”"'’]|$)/gm, "$1$2");
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  const known = KNOWN[base.toLowerCase()];
  const headerTitle = raw.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  const headerAuthor = raw.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
  const title = known?.title ?? headerTitle ?? titleCase(base);
  const author = known?.author ?? headerAuthor ?? "";

  let found: Hit[] = [];
  let strategy: "roman" | "word" | "md" | "none" = "none";
  const roman = hits(raw, ROMAN, (m) => ({ num: m[1], title: m[2].trim() }));
  const word = hits(raw, CHAPTER_WORD, (m) => ({ num: `Chapter ${m[1]}`, title: m[2].trim() }));
  const numbered = hits(raw, NUMBERED, (m) => ({ num: m[1], title: m[2].trim() })).filter((h, i, all) => Number(h.num) === i + 1 && all.length >= 2);
  const md = hits(raw, MD_HEAD, (m) => ({ title: m[1].trim() }));
  if (kind === "markdown" && md.length >= 2) { found = md; strategy = "md"; }
  else if (roman.length >= 3) { found = roman; strategy = "roman"; }
  else if (word.length >= 2) { found = word; strategy = "word"; }
  else if (numbered.length >= 2) { found = numbered; strategy = "word"; }
  else if (md.length >= 2) { found = md; strategy = "md"; }

  const chapters: Chapter[] = [];
  if (strategy === "none") {
    chapters.push(makeChapter(0, title, raw.trim()));
  } else {
    found.forEach((h, i) => {
      const next = found[i + 1]?.index ?? raw.length;
      // For Roman headings the body is what follows the heading line, so the cache key matches earlier analyses.
      const body = strategy === "roman" ? raw.slice(h.index, next).replace(/^\n ([IVXLC]+)\.\n\s*(.+)\n/, "") : raw.slice(h.end, next);
      if (body.trim().length < 80) return; // a heading with nothing under it
      chapters.push(makeChapter(chapters.length, h.title || h.num || `Part ${i + 1}`, body, strategy === "md" ? undefined : h.num));
    });
    if (!chapters.length) chapters.push(makeChapter(0, title, raw.trim()));
  }
  return makeBook({ title, author, source: { kind, ref: filename }, chapters });
}
