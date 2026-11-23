// Writer's directions: XML-style tags a writer puts in a Markdown document to tell the picture-making side what they mean. They are never shown: not in the
// reader, the preview, a PDF, a Word file or a web page. The scene analysis is told them as the writer's own word, and the judge checks the picture
// against them.
//
//   <scene place="exterior" location="a raft on a flat calm sea" time="dusk" weather="fog" mood="dread" sky="a brass-coloured haze" light="#e0a060" props="oar, water cask"/>
//       from here to the next <scene …/> (or </scene>) the passage happens in this place and time. Every attribute is optional.
//       time can be a change over the passage: time="dusk>night"
//   <character name="the Mariner" look="old man, long grey beard, a wet tattered coat"/>      (or <character name="…">the look</character>)
//       how a person or creature looks wherever they appear.
//   <note>The sea is dead still: nothing moves but the albatross.</note>
//       a free instruction for the next paragraph, for the director and the judge.

export type DirectiveKind = "scene" | "character" | "note";
/** A direction as found in a document, before it is placed: `line` is the line of the clean text it comes before. */
export type RawDirective = { kind: DirectiveKind; attrs: Record<string, string>; text: string; line: number; close?: boolean };
/** A direction placed in a chapter: it comes before paragraph `at`. */
export type Directive = { kind: DirectiveKind; attrs: Record<string, string>; text: string; at: number; close?: boolean };

const A = `((?:\\s+[\\w-]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)`;
const TAG = new RegExp(`<scene\\b${A}\\s*\\/?>|<\\/scene\\s*>|<(character|note)\\b${A}\\s*(?:\\/>|>([\\s\\S]{0,600}?)<\\/\\2\\s*>)`, "gi");
const ATTR = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function attrsOf(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!s) return out;
  for (const m of s.matchAll(ATTR)) out[m[1].toLowerCase()] = (m[2] ?? m[3] ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
  return out;
}

/** Character ranges that are code (fenced blocks and `inline` spans): a tag written there is being talked about, not used. */
function codeRanges(src: string): [number, number][] {
  const r: [number, number][] = [];
  let off = 0, fence = "", start = 0;
  for (const line of src.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (!fence) { fence = f[1][0]; start = off; } else if (f[1][0] === fence) { r.push([start, off + line.length]); fence = ""; } }
    else if (!fence) for (const m of line.matchAll(/`[^`\n]+`/g)) r.push([off + m.index!, off + m.index! + m[0].length]);
    off += line.length + 1;
  }
  if (fence) r.push([start, src.length]);
  return r;
}

/** The document without its directions, and the directions with the line each comes before. */
export function extractDirectives(src: string): { clean: string; list: RawDirective[] } {
  if (!/<(scene|character|note|\/scene)\b/i.test(src)) return { clean: src, list: [] };
  const code = codeRanges(src);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  const list: RawDirective[] = [];
  let clean = "", at = 0;
  for (const m of src.matchAll(TAG)) {
    const i = m.index!;
    if (inCode(i)) continue;
    const whole = m[0];
    clean += src.slice(at, i);
    let end = i + whole.length;
    // a tag alone on its line takes the line with it
    const lineStart = i === 0 || src[i - 1] === "\n" || /^[ \t]*$/.test(clean.slice(clean.lastIndexOf("\n") + 1));
    if (lineStart && (src[end] === "\n" || end >= src.length)) { end += src[end] === "\n" ? 1 : 0; clean = clean.replace(/[ \t]*$/, ""); }
    const line = (clean.match(/\n/g) ?? []).length;
    if (/^<\/scene/i.test(whole)) list.push({ kind: "scene", attrs: {}, text: "", line, close: true });
    else if (/^<scene/i.test(whole)) list.push({ kind: "scene", attrs: attrsOf(m[1]), text: "", line });
    else list.push({ kind: (m[2].toLowerCase() as DirectiveKind), attrs: attrsOf(m[3]), text: (m[4] ?? "").replace(/\s+/g, " ").trim().slice(0, 400), line });
    at = end;
  }
  clean += src.slice(at);
  return { clean, list };
}

/** The document as a reader or an export should see it. */
export const stripDirectives = (src: string): string => extractDirectives(src).clean;

const slug = (s: string) => s.toLowerCase().replace(/^(the|a|an)\s+/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
export const characterId = (name: string) => slug(name) || "character";

export const TIMES = ["dawn", "morning", "noon", "afternoon", "dusk", "night"];
const timeOf = (s: string | undefined): string | undefined => { const t = (s ?? "").toLowerCase().trim(); return TIMES.includes(t) ? t : /sunrise|daybreak/.test(t) ? "dawn" : /sunset|evening|twilight/.test(t) ? "dusk" : /midnight/.test(t) ? "night" : /midday/.test(t) ? "noon" : undefined; };
import { STYLES } from "./style";
const STYLE_IDS: string[] = STYLES.map((s) => s.id);
const WEATHER = ["clear", "overcast", "rain", "snow", "fog", "storm"];

/** What the writer has fixed for a passage, as one value: from a <scene> in force. */
export type WriterScene = { style?: string; camera?: "wide" | "medium" | "close"; sound?: string; place?: "interior" | "exterior"; location?: string; start?: string; end?: string; weather?: string; mood?: string; sky?: string; light?: string; fog?: string; props?: string[] };
export function sceneOf(a: Record<string, string>): WriterScene {
  const w: WriterScene = {};
  const p = (a.place ?? "").toLowerCase();
  if (/^(interior|indoor|indoors|inside)$/.test(p)) w.place = "interior";
  else if (/^(exterior|outdoor|outdoors|outside)$/.test(p)) w.place = "exterior";
  if (a.location) w.location = a.location;
  if (a.time) { const [s, e] = a.time.split(/\s*(?:>|→|->|to)\s*/); w.start = timeOf(s); w.end = timeOf(e) ?? w.start; }
  const wx = (a.weather ?? "").toLowerCase().trim();
  if (WEATHER.includes(wx)) w.weather = wx;
  if (a.mood) w.mood = a.mood.slice(0, 40);
  if (a.sky) w.sky = a.sky.slice(0, 80);
  if (a.light && /^#[0-9a-f]{6}$/i.test(a.light)) w.light = a.light;
  if (a.fog && /^#[0-9a-f]{6}$/i.test(a.fog)) w.fog = a.fog;
  const st = (a.style ?? "").toLowerCase().trim();
  if (STYLE_IDS.includes(st)) w.style = st;
  const cam = (a.camera ?? "").toLowerCase().trim();
  if (cam === "wide" || cam === "medium" || cam === "close") w.camera = cam;
  if (a.sound) w.sound = a.sound.slice(0, 60);
  if (a.props) w.props = a.props.split(/\s*,\s*/).filter(Boolean).slice(0, 8);
  return w;
}
/** The same, in words (for the model and the judge). */
export function describeScene(w: WriterScene): string {
  const bits: string[] = [];
  if (w.place) bits.push(`place: ${w.place === "interior" ? "indoors" : "outdoors"}`);
  if (w.location) bits.push(`location: ${w.location}`);
  if (w.start) bits.push(`time: ${w.start}${w.end && w.end !== w.start ? " to " + w.end : ""}`);
  if (w.weather) bits.push(`weather: ${w.weather}`);
  if (w.mood) bits.push(`mood: ${w.mood}`);
  if (w.sky) bits.push(`sky: ${w.sky}`);
  if (w.props?.length) bits.push(`props: ${w.props.join(", ")}`);
  if (w.style) bits.push(`picture style: ${w.style}`);
  if (w.camera) bits.push(`camera: ${w.camera} shots`);
  if (w.sound) bits.push(`sound: ${w.sound}`);
  return bits.join("; ");
}
