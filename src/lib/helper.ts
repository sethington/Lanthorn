// The writing helper. It watches the passage you are writing and offers links, references and tone corrections, drawn from this document and from
// your other writing. To keep the model's context small it never reads the whole of anything:
//   1. a small call looks at the passage and the document's outline and says what to look up (a handful of terms);
//   2. those are grepped, here, through this document and your other documents, and only the best few lines come back;
//   3. how the passage sounds (sentence length, voice, contractions...) is measured here, against the rest of this document and your other writing,
//      and only the numbers go to the model;
//   4. one call, with the passage, the outline, the grep hits and the numbers, gives the suggestions.

import { api } from "./api";
import { jsonOf } from "./author";
import { type Book } from "./book";
import { markdownOfBook, plainOf } from "./markdown";

export type Suggestion = {
  id: string;
  type: "link" | "resource" | "reference" | "tone" | "style" | "consistency";
  /** the exact words in the passage this is about (may be empty) */
  anchor: string;
  title: string;
  detail: string;
  /** another document of yours this points to (link, reference), and the line in it */
  doc?: { id: string; title: string; line: number; /** a file on disk (can be cited, not linked) */ file?: string };
  /** a web address (only when the model was sure of it: it is checked before it is inserted) and a search for the topic */
  url?: string;
  query?: string;
  /** for tone, style and consistency: what to ask of a rewrite */
  fix?: string;
};

export type Doc = { id: string; title: string; lines: string[]; here?: boolean };
export type Hit = { doc: string; docTitle: string; line: number; text: string; here?: boolean };

// ---- the corpus: your other writing, loaded once and kept (documents and plain text notes, not the books you read)
const cache = new Map<string, { updated: number; doc: Doc }>();
export async function loadCorpus(excludeId: string): Promise<Doc[]> {
  const out: Doc[] = [];
  let list: Awaited<ReturnType<typeof api.libraryList>> = [];
  try { list = await api.libraryList(); } catch { return out; }
  let bytes = 0;
  for (const m of list.filter((b) => (b.kind === "markdown" || b.kind === "text") && b.id !== excludeId).slice(0, 200)) {
    let c = cache.get(m.id);
    if (!c || c.updated !== m.updated) {
      try {
        const raw = await api.libraryGet(m.id);
        if (!raw) continue;
        const b = JSON.parse(raw) as Book;
        c = { updated: m.updated, doc: { id: m.id, title: m.title, lines: markdownOfBook(b).split("\n") } };
        cache.set(m.id, c);
      } catch { continue; }
    }
    bytes += c.doc.lines.reduce((n, l) => n + l.length, 0);
    if (bytes > 4_000_000) break;
    out.push(c.doc);
  }
  return out;
}

// ---- grep
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set("the a an and or of to in on at for with by from is are was were be been it this that these those as but not no so if then than too very just".split(" "));
/** Lines that mention the terms, best first: more of the terms in the line (and its neighbours) ranks higher; at most two per document, `max` in all. */
export function grep(corpus: Doc[], terms: string[], max = 8): Hit[] {
  const res = terms
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !STOP.has(t.toLowerCase()))
    .slice(0, 8)
    .map((t) => new RegExp(/^[\w]/.test(t) ? `\\b${esc(t)}` : esc(t), "i"));
  if (!res.length) return [];
  const hits: (Hit & { score: number })[] = [];
  for (const d of corpus) {
    const perDoc: (Hit & { score: number })[] = [];
    d.lines.forEach((l, i) => {
      if (!l.trim() || /^\s*(```|---+\s*$)/.test(l)) return;
      let s = 0;
      for (const re of res) if (re.test(l)) s++;
      if (!s) return;
      const near = (d.lines[i - 1] ?? "") + " " + (d.lines[i + 1] ?? "");
      for (const re of res) if (re.test(near)) s += 0.25;
      perDoc.push({ doc: d.id, docTitle: d.title, line: i + 1, text: l.trim().slice(0, 240), here: d.here, score: s });
    });
    perDoc.sort((a, b) => b.score - a.score);
    hits.push(...perDoc.slice(0, 2));
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, max).map(({ score: _s, ...h }) => h);
}

// ---- what this writer takes and what they wave away, remembered (so the suggestions drift toward what they use)
type Taste = Record<string, { taken: number; dismissed: number }>;
const TASTE = "lanthorn:helper-taste";
const readTaste = (): Taste => { try { return JSON.parse(localStorage.getItem(TASTE) || "{}"); } catch { return {}; } };
export function recordTaste(type: string, taken: boolean) {
  const t = readTaste();
  const e = (t[type] ??= { taken: 0, dismissed: 0 });
  taken ? e.taken++ : e.dismissed++;
  try { localStorage.setItem(TASTE, JSON.stringify(t)); } catch { /* optional */ }
}
/** One line for the model, once there is enough history to say anything (a type that is nearly always dismissed is to be rare; one that is taken, welcome). */
export function tasteNote(): string {
  const t = readTaste();
  const rows = Object.entries(t).filter(([, e]) => e.taken + e.dismissed >= 3);
  if (!rows.length) return "";
  return rows.map(([k, e]) => `${k}: taken ${e.taken}, dismissed ${e.dismissed}`).join("; ");
}

// ---- how a piece of writing sounds, measured
export type Voice = { words: number; sentence: number; wordLen: number; long: number; contractions: number; first: number; second: number; questions: number; exclaims: number; passive: number; paragraph: number };
export function voice(text: string): Voice {
  const plain = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_~|-]+/g, " ");
  const words = plain.match(/[A-Za-z][A-Za-z'’-]*/g) ?? [];
  const n = Math.max(1, words.length);
  const sentences = Math.max(1, (plain.match(/[.!?]+(\s|$)/g) ?? []).length || 1);
  const per100 = (k: number) => +((k / n) * 100).toFixed(1);
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim() && !/^\s*#/.test(p));
  return {
    words: words.length,
    sentence: +(n / sentences).toFixed(1),
    wordLen: +(words.reduce((a, w) => a + w.length, 0) / n).toFixed(2),
    long: per100(words.filter((w) => w.length >= 8).length),
    contractions: per100((plain.match(/\b\w+(?:n['’]t|['’](?:s|re|ll|ve|d|m))\b/gi) ?? []).length),
    first: per100((plain.match(/\b(?:I|me|my|mine|we|us|our|ours)\b/g) ?? []).length),
    second: per100((plain.match(/\b(?:you|your|yours)\b/gi) ?? []).length),
    questions: per100((plain.match(/\?/g) ?? []).length),
    exclaims: per100((plain.match(/!/g) ?? []).length),
    passive: per100((plain.match(/\b(?:was|were|been|being|is|are|be)\s+\w+(?:ed|en)\b/gi) ?? []).length),
    paragraph: Math.round(words.length / Math.max(1, paras.length)),
  };
}
const LABEL: Record<keyof Voice, string> = { words: "words", sentence: "average sentence (words)", wordLen: "average word length", long: "long words per 100", contractions: "contractions per 100 words", first: "I/we per 100 words", second: "you per 100 words", questions: "questions per 100 words", exclaims: "exclamations per 100 words", passive: "passive phrases per 100 words", paragraph: "paragraph length (words)" };
/** Where the passage sounds unlike the rest: only the measures that differ clearly, as short lines with the numbers. */
export function voiceNotes(p: Voice, here: Voice | null, past: Voice | null): string[] {
  const notes: string[] = [];
  const ref = here && here.words >= 120 ? here : past && past.words >= 300 ? past : null;
  if (!ref || p.words < 25) return notes;
  const keys: [keyof Voice, number, number][] = [["sentence", 5, 0.3], ["contractions", 1.5, 0.5], ["first", 1.5, 0.5], ["second", 1.5, 0.5], ["questions", 1, 0.6], ["exclaims", 0.8, 0.6], ["passive", 1.5, 0.5], ["long", 4, 0.4], ["paragraph", 40, 0.5]];
  for (const [k, abs, rel] of keys) {
    const a = p[k] as number, b = ref[k] as number;
    if (Math.abs(a - b) >= abs && Math.abs(a - b) / Math.max(0.5, b) >= rel) {
      const other = past && past !== ref && past.words >= 300 ? `, your other writing ${past[k]}` : "";
      notes.push(`${LABEL[k]}: this passage ${a}, ${ref === here ? "the rest of this document" : "your other writing"} ${b}${other}`);
    }
  }
  return notes.slice(0, 4);
}

// ---- outline of a document, with line numbers (cheap, always sent)
export function outline(lines: string[]): string {
  const out: string[] = [];
  lines.forEach((l, i) => { const m = /^(#{1,3})\s+(.+)$/.exec(l); if (m) out.push(`${"  ".repeat(m[1].length - 1)}${m[2].trim().slice(0, 70)} (line ${i + 1})`); });
  return out.slice(0, 40).join("\n") || "(no headings yet)";
}

// ---- the two calls
const PLAN_SYSTEM = `You help a writer who is in the middle of a piece. From the passage they are working on and the outline of the whole document, say what to look up in the rest of this document and in their other writing, so you can link to it, cite it, or match its tone. Reply with ONE JSON object only: {"terms":["..."]}. 3 to 8 terms: distinctive names, topics, claims or phrases that the passage mentions or builds on (a word or two each, as they would be written). No common words.`;

const HELP_SYSTEM = `You are a writing helper beside a writer's Markdown editor. You are given the passage they are working on, the outline of the document, matching lines found by searching the document and their other writing, and measurements of how the passage sounds compared with the rest. Suggest only what would clearly help; fewer is better; at most 5. Reply with ONE JSON object only: {"suggestions":[{"type":"link|resource|reference|tone|style|consistency","anchor":"exact words from the passage this is about, up to 60 characters, or empty","title":"up to 8 words","detail":"up to 30 words","doc":"id of one of the documents in the matches (link, reference)","line":<its line number>,"url":"only an address you are certain exists","query":"a web search that finds a good source","fix":"only when changing the passage's own words is the right action (tone, style, a wrong fact): one sentence telling a rewriter what to change; omit it otherwise, e.g. for a duplicate or a missing source"}]}
- Matches whose id starts with file: are files in the writer's own folder: cite them (reference) but never link to them.
- link: the anchor words could link to another of their documents (use the id and line from the matches), or to a stable, well-known page (give url only if you are certain of it; never invent addresses).
- resource: a source, reference or further reading that fits what is being claimed; give a query that would find it, and a url only if certain.
- reference: they said something related, or the opposite, elsewhere (cite which document and line, and how it relates).
- tone, style: use the measurements: say how the passage differs from the rest and what to do. If the numbers show no clear difference, say nothing about tone.
- consistency: a name, term, fact or number that disagrees with the matches.
Quote anchors exactly. Do not repeat the same point twice. If nothing is worth saying, reply {"suggestions":[]}.`;

export type HelpInput = {
  passage: string;
  /** the whole document (for the outline and how it sounds), the passage's own lines excluded for the sounds */
  docLines: string[];
  passageFrom: number; // 0-based line range of the passage in the document
  passageTo: number;
  docId: string;
  docTitle: string;
};
export type HelpResult = { suggestions: Suggestion[]; hits: number; terms: string[]; notes: string[] };

export async function helpWith(inp: HelpInput, corpus: Doc[], folder = ""): Promise<HelpResult> {
  const out = outline(inp.docLines);
  // 1. what to look up
  let terms: string[] = [];
  try {
    const c = await api.llmComplete("author", PLAN_SYSTEM, `Outline:\n${out}\n\nPassage:\n${inp.passage.slice(0, 1800)}`);
    terms = (Array.isArray(jsonOf(c.text)?.terms) ? jsonOf(c.text).terms : []).map(String).slice(0, 8);
  } catch { /* the model failed: the passage's own longest words stand in */ }
  if (!terms.length) terms = Array.from(new Set(inp.passage.match(/\b[A-Z][a-z]{3,}\b|\b[a-z]{7,}\b/g) ?? [])).slice(0, 6);
  // 2. grep, here: the rest of this document and the other writing
  const rest = inp.docLines.filter((_, i) => i < inp.passageFrom || i > inp.passageTo);
  const here: Doc = { id: inp.docId, title: `${inp.docTitle} (this document)`, lines: inp.docLines.map((l, i) => (i >= inp.passageFrom && i <= inp.passageTo ? "" : l)), here: true };
  const hits = grep([here, ...corpus], terms, folder ? 6 : 8);
  const files = new Map<string, string>(); // writing found in the folder: its path and name, by the id the model is given
  if (folder) {
    try { for (const f of await api.writingGrep(folder, terms, 5)) { const fid = `file:${f.path}`; files.set(fid, f.path); hits.push({ doc: fid, docTitle: f.name, line: f.line, text: f.text }); } } catch (e) { /* an unreadable folder: only the documents */ }
  }
  // 3. how it sounds, here
  const pv = voice(inp.passage);
  const hv = voice(rest.join("\n"));
  const past = corpus.length ? voice(corpus.slice(0, 40).map((d) => d.lines.join("\n")).join("\n\n").slice(0, 120_000)) : null;
  const notes = voiceNotes(pv, hv, past);
  // 4. the suggestions
  const user =
    `Document: "${inp.docTitle}"\nOutline:\n${out}\n\nPassage (lines ${inp.passageFrom + 1}-${inp.passageTo + 1}):\n${inp.passage.slice(0, 2400)}\n\n` +
    `Matches (from searching for: ${terms.join(", ")}):\n${hits.length ? hits.map((h) => `- [${h.here ? "this document" : h.docTitle}] id=${h.doc} line ${h.line}: ${h.text}`).join("\n") : "(none)"}\n\n` +
    `How the passage sounds against the rest:\n${notes.length ? notes.map((n) => `- ${n}`).join("\n") : "(no clear difference)"}` +
    (tasteNote() ? `\n\nHow this writer has reacted to past suggestions (${tasteNote()}). Offer fewer of the kinds they mostly dismiss, and only when it is clearly worth it.` : "");
  const c = await api.llmComplete("rewrite", HELP_SYSTEM, user);
  const j = jsonOf(c.text);
  const titleOf = new Map<string, string>([[inp.docId, inp.docTitle], ...corpus.map((d) => [d.id, d.title] as [string, string])]);
  const suggestions: Suggestion[] = [];
  for (const s of Array.isArray(j?.suggestions) ? j.suggestions : []) {
    const type = ["link", "resource", "reference", "tone", "style", "consistency"].includes(s?.type) ? s.type : null;
    if (!type || typeof s.title !== "string") continue;
    const fileDoc = typeof s.doc === "string" && files.has(s.doc);
    const doc = typeof s.doc === "string" && (titleOf.has(s.doc) || fileDoc) ? { id: s.doc, title: fileDoc ? (hits.find((h) => h.doc === s.doc)?.docTitle ?? s.doc) : titleOf.get(s.doc)!, line: Math.max(1, Number(s.line) || 1), ...(fileDoc ? { file: files.get(s.doc) } : {}) } : undefined;
    if ((type === "link" || type === "reference") && !doc && !s.url && !s.query) continue;
    suggestions.push({
      id: `${type}:${String(s.anchor ?? "").slice(0, 30)}:${String(s.title).slice(0, 30)}`,
      type,
      anchor: typeof s.anchor === "string" && inp.passage.includes(s.anchor) ? s.anchor.slice(0, 80) : "",
      title: String(s.title).slice(0, 80),
      detail: String(s.detail ?? "").slice(0, 260),
      doc,
      url: typeof s.url === "string" && /^https?:\/\//i.test(s.url) ? s.url.slice(0, 300) : undefined,
      query: typeof s.query === "string" ? s.query.slice(0, 120) : undefined,
      fix: typeof s.fix === "string" ? s.fix.slice(0, 240) : undefined,
    });
  }
  return { suggestions: suggestions.slice(0, 5), hits: hits.length, terms, notes };
}

export { plainOf };
