// A PDF's design, as data. The plain design is fixed; the designed one is chosen by the language model from what the document is about (and what the
// writer asks for), and checked here: every choice comes from a short list or a number range, and colours are kept readable. The renderer (render.ts)
// only ever sees a valid theme, so a model that gets it wrong can make an ugly PDF but never a broken or unreadable one.

import { api } from "../api";
import { jsonOf } from "../author";

export type Family = "serif" | "sans" | "mono";
export type Theme = {
  name: string;
  mood: string;
  body: { font: Family; size: number; leading: number; justify: boolean; dropCap: boolean };
  heading: { font: Family; bold: boolean; scale: number; caps: boolean; spaced: boolean; rule: "none" | "under" | "over" | "both" | "short"; align: "left" | "center" };
  colors: { ink: string; muted: string; accent: string; paper: string; band: string };
  page: { margin: number; footer: "none" | "number" | "running"; border: "none" | "thin" | "double" | "corners" };
  title: { show: boolean; layout: "center" | "left" | "band" | "stack"; ornament: "none" | "rule" | "diamond" | "dots" | "asterism" | "wave" };
  chapterBreak: boolean;
  quote: "bar" | "italic" | "indent" | "box";
};

export const PLAIN: Theme = {
  name: "Plain",
  mood: "clean and quiet",
  body: { font: "serif", size: 11, leading: 1.5, justify: false, dropCap: false },
  heading: { font: "sans", bold: true, scale: 1, caps: false, spaced: false, rule: "none", align: "left" },
  colors: { ink: "#1a1a1a", muted: "#666666", accent: "#2b4a7a", paper: "#ffffff", band: "#2b4a7a" },
  page: { margin: 72, footer: "number", border: "none" },
  title: { show: false, layout: "left", ornament: "none" },
  chapterBreak: false,
  quote: "bar",
};

// ---- colour maths
export const hexOk = (s: unknown): s is string => typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
export const rgbOf = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toHex = (c: number[]) => "#" + c.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0")).join("");
const lum = (h: string) => { const [r, g, b] = rgbOf(h).map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
export const contrast = (a: string, b: string) => { const la = lum(a), lb = lum(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); };
const mix = (a: string, b: string, t: number) => toHex(rgbOf(a).map((v, i) => v + (rgbOf(b)[i] - v) * t));
/** Black or white, whichever reads better on this colour. */
export const onColour = (bg: string) => (contrast(bg, "#ffffff") >= contrast(bg, "#111111") ? "#ffffff" : "#111111");

const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (all.includes(v as T) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);

/** Anything the model wrote, made into a theme that is safe to render (unknown or silly values fall back to the plain design's). */
export function parseTheme(raw: any): Theme | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw.body ?? {}, h = raw.heading ?? {}, c = raw.colors ?? {}, p = raw.page ?? {}, t = raw.title ?? {};
  const paper0 = hexOk(c.paper) ? c.paper : PLAIN.colors.paper;
  // paper stays light: a dark page would print as a block of ink; the model may tint it
  const paper = lum(paper0) >= 0.55 ? paper0 : PLAIN.colors.paper;
  let ink = hexOk(c.ink) ? c.ink : PLAIN.colors.ink;
  if (contrast(ink, paper) < 7) ink = contrast("#1a1a1a", paper) >= 7 ? "#1a1a1a" : "#000000";
  let accent = hexOk(c.accent) ? c.accent : PLAIN.colors.accent;
  for (let k = 0; k < 6 && contrast(accent, paper) < 3.5; k++) accent = mix(accent, "#000000", 0.2); // (an accent too pale to see is darkened)
  let muted = hexOk(c.muted) ? c.muted : PLAIN.colors.muted;
  if (contrast(muted, paper) < 4.5) muted = mix(ink, paper, 0.35);
  const band = hexOk(c.band) ? c.band : accent;
  return {
    name: typeof raw.name === "string" ? raw.name.slice(0, 40) : "Designed",
    mood: typeof raw.mood === "string" ? raw.mood.slice(0, 80) : "",
    body: { font: pick(b.font, ["serif", "sans", "mono"], "serif"), size: num(b.size, 9.5, 13, 11), leading: num(b.leading, 1.25, 1.8, 1.5), justify: bool(b.justify, false), dropCap: bool(b.dropCap, false) },
    heading: { font: pick(h.font, ["serif", "sans", "mono"], "sans"), bold: bool(h.bold, true), scale: num(h.scale, 0.85, 1.5, 1), caps: bool(h.caps, false), spaced: bool(h.spaced, false), rule: pick(h.rule, ["none", "under", "over", "both", "short"], "none"), align: pick(h.align, ["left", "center"], "left") },
    colors: { ink, muted, accent, paper, band },
    page: { margin: num(p.margin, 48, 100, 72), footer: pick(p.footer, ["none", "number", "running"], "number"), border: pick(p.border, ["none", "thin", "double", "corners"], "none") },
    title: { show: bool(t.show, true), layout: pick(t.layout, ["center", "left", "band", "stack"], "center"), ornament: pick(t.ornament, ["none", "rule", "diamond", "dots", "asterism", "wave"], "rule") },
    chapterBreak: bool(raw.chapterBreak, false),
    quote: pick(raw.quote, ["bar", "italic", "indent", "box"], "bar"),
  };
}

const SYSTEM = `You are a book and document designer. Choose the look of a PDF for the document described, so that it suits what the document is and who will read it (a technical note is crisp and plain; a story or essay is warm and bookish; a letter or poem is airy; a report is orderly). Only standard PDF fonts are available: the families "serif" (Times), "sans" (Helvetica), "mono" (Courier). The design lives in colour, spacing, headings, rules, ornaments, the title page and the page border. Reply with ONE JSON object only, with exactly these fields:
{"name":"2-3 words","mood":"up to 8 words",
"body":{"font":"serif|sans|mono","size":9.5-13,"leading":1.25-1.8,"justify":true|false,"dropCap":true|false},
"heading":{"font":"serif|sans|mono","bold":true|false,"scale":0.85-1.5,"caps":true|false,"spaced":true|false,"rule":"none|under|over|both|short","align":"left|center"},
"colors":{"ink":"#rrggbb dark text","muted":"#rrggbb","accent":"#rrggbb","paper":"#rrggbb very light, white or a faint tint","band":"#rrggbb"},
"page":{"margin":48-100,"footer":"none|number|running","border":"none|thin|double|corners"},
"title":{"show":true,"layout":"center|left|band|stack","ornament":"none|rule|diamond|dots|asterism|wave"},
"chapterBreak":true|false,"quote":"bar|italic|indent|box"}
Rules: text colours must be dark and the paper light, so it stays readable and prints well. One accent colour, used with restraint (headings, rules, bullets, links). Be distinctive: do not give every document the same look. dropCap and justify suit long prose, not notes or technical writing. chapterBreak (each ## section starts a new page) only for long documents with several sections.`;

export type ThemeInput = { title: string; outline: string; sample: string; words: number; brief: string };
export async function designTheme(inp: ThemeInput, again = ""): Promise<Theme> {
  const user = `Title: ${inp.title}\nLength: ${inp.words} words\nOutline:\n${inp.outline || "(no headings)"}\n\nOpening of the document:\n${inp.sample.slice(0, 1500)}\n\n${inp.brief.trim() ? `The writer asks for: ${inp.brief.trim()}\n` : "The writer gave no direction: design it to suit the content."}${again ? `\nThe last design was not wanted${again === "again" ? "" : ": " + again}. Make a clearly different one.` : ""}`;
  const c = await api.llmComplete("design", SYSTEM, user);
  const t = parseTheme(jsonOf(c.text));
  if (!t) throw new Error("The model's design couldn't be read. Try again.");
  return t;
}
