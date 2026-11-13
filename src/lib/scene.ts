// Scene JSON contract v0.2, prompt builder, parser/validator. Pure: no DOM, no Tauri.
// Vocabularies are open for now; they close once the asset catalog and compiler exist (docs/spec.md).

import type { Sentence } from "./text";

export type Character = { id: string; desc: string; /** what it is: a person, an animal, or some other living thing (a dragon, an angel, a robot) */ kind?: "person" | "animal" | "creature" | "presence" };
export type Location = { id: string; desc: string };
export type Bible = { characters: Character[]; locations: Location[] };

/** A board: what a mathematical, scientific or technical passage is drawn as (typeset equations, a plot, notes), step by step as the text is read. */
export type BoardPlot = { fns: { expr: string; label?: string }[]; x: [number, number]; y?: [number, number]; marks?: { x: number; label?: string }[]; chord?: [number, number]; tangent?: number };
/** a schematic map (x east, y south, both 0-100): the places so far, and the route walked through them in order */
export type BoardMap = { title?: string; points: { id: string; name: string; x: number; y: number }[]; route?: string[] };
/** a family tree, an outline or any hierarchy: each node names its parent */
export type BoardTree = { nodes: { id: string; label: string; parent?: string }[] };
/** events along a line of time (or any scale): where each falls on 0-100 */
export type BoardTimeline = { events: { label: string; at: number }[]; from?: string; to?: string };
/** A free drawing: any diagram the text needs (a circuit, a molecule, a flowchart, a chessboard, a triangle with labelled sides, a diagram of an argument), in a 100 x 70 box (x right, y down). Shapes of the same id accumulate across steps, so a drawing builds up as the text does. */
export type DrawShape =
  | { k: "rect"; x: number; y: number; w: number; h: number; fill?: string; stroke?: string; r?: number; sw?: number }
  | { k: "circle"; x: number; y: number; r: number; fill?: string; stroke?: string; sw?: number }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; stroke?: string; sw?: number; dash?: boolean; arrow?: boolean }
  | { k: "poly"; pts: [number, number][]; fill?: string; stroke?: string; sw?: number; closed?: boolean }
  | { k: "path"; d: string; fill?: string; stroke?: string; sw?: number }
  | { k: "text"; x: number; y: number; s: string; size?: number; color?: string; anchor?: "start" | "middle" | "end"; italic?: boolean }
  | { k: "tex"; x: number; y: number; tex: string; size?: number; color?: string };
export type BoardDraw = { id?: string; title?: string; replace?: boolean; shapes: DrawShape[] };
export type BoardItem =
  | ({ t: "draw" } & BoardDraw)
  | { t: "eq"; tex: string } | ({ t: "plot" } & BoardPlot) | { t: "note"; s: string } | ({ t: "map" } & BoardMap) | ({ t: "tree" } & BoardTree) | ({ t: "timeline" } & BoardTimeline);
export type BoardStep = { at: number; say?: string; items: BoardItem[] };
export type Board = { steps: BoardStep[]; /** drawn small in a corner over a normal scene instead of replacing it */ inset?: boolean };

export type Scene = {
  /** set for passages drawn as a board instead of a world */
  board?: Board;
  id: string;
  from: number; // first sentence id
  to: number; // last sentence id (inclusive)
  visual: boolean;
  kind: "static" | "timelapse" | "motion" | "abstract" | "interior" | "board";
  location: string;
  interior: boolean;
  time: { start: string; end: string; progression: "steady" | "accelerating" | "slowing" };
  weather: string;
  subjects: { ref: string; pose: string; action: string; position: string }[];
  props: string[];
  effects: string[];
  mood: string;
  /** only when the text gives the sky or air a distinctive look (a blood-red dusk, an ash cloud, a golden haze, thick smog) */
  atmosphere?: { sky?: string; fog?: string; fogDensity?: number; light?: string };
  camera: { framing: string; motion: string };
  beats: { at: number; action: string }[];
  audio: { bed: string; spots: { at: number; sound: string }[] };
  confidence: number;
  /** optional, for hand-made scenes: put a bundled asset exactly here (metres; height scales it) */
  /** direction: camera shots, who speaks, what characters do. All optional: missing parts are directed automatically. */
  shots?: Shot[];
  lines?: Line[];
  acting?: Act[];
  /** stage cues: things the text makes the world DO (a moon cycling its phases, trees sprouting, speed streaks, strobing sky, camera stunts) */
  stage?: Cue[];
  /** which chapter of the book this scene is in (set when chapters are joined into one text) */
  ch?: number;
  place?: { asset: string; x?: number; y?: number; z?: number; height?: number; rotY?: number }[];
};

/**
 * A stage cue: an event the world performs, played by reading position from sentence `at` to `to` (default the next sentence).
 * moon: how "new>full" | "full>new" | "crescent>full"...   sun: a streak of light across the sky (days racing)
 * grow: what to grow (tree, tower, flowers), how "sprout" (grow then vanish) | "rise" (grow and stay) | "melt" (shrink away)
 * streak: speed lines rushing past the camera   flash: how "strobe" (day/night flicker) | "lightning"
 * cam: how "look_up" (swing to the sky/moon) | "roll" | "spin" | "crane" | "punch" (dolly-zoom)   quake: the ground shakes
 * creature: what crab | butterfly | bird | insect ..., how "cross" (walks/flies across the view) | "circle"   dim: how "eclipse" | "dusk" | "dark" (the light fails)
 * sun: how "streak" (races across the sky) | "red" (a huge red sun hangs low) 
 * amount 0..1 is how much.
 */
export type Cue = { k: "moon" | "sun" | "grow" | "streak" | "flash" | "cam" | "quake" | "creature" | "dim"; at: number; to: number; what?: string; how?: string; amount: number };
export const CUE_KINDS = ["moon", "sun", "grow", "streak", "flash", "cam", "quake", "creature", "dim"] as const;

/** A camera setup held for a stretch of the scene. `from` is the first sentence it covers; it runs until the next shot. */
export type Shot = {
  from: number;
  framing: "wide" | "medium" | "close" | "extreme_close";
  angle: "eye" | "low" | "high" | "over_shoulder";
  /** what the camera is on: a character id, a prop word, or "scene" for the whole set */
  focus: string;
  move: "static" | "push" | "pull" | "orbit" | "drift" | "pan";
  /** how we arrive at this shot from the previous one */
  into: "cut" | "dissolve" | "fade";
};
/** Who says a sentence, when it is spoken or thought. Sentences with no entry are narration. */
export type Line = { at: number; speaker: string; kind: "dialogue" | "thought" };
/** What a character does, starting at a sentence. */
export type Act = { at: number; who: string; do: string; to?: string };

export const ACTS = ["walk_to", "sit", "stand", "reach", "use_lever", "look_at", "turn", "gesture", "crouch", "wave", "point", "drink", "sing", "cheer", "slam", "clap", "shrug", "nod", "bow", "cover_face", "draw", "shake_fist", "beckon", "think", "laugh", "plead"] as const;

export type Chunk = { scenes: Scene[]; bible: Bible };

/** Bump when SYSTEM or the output contract changes, so cached model replies are not reused. */
export const PROMPT_VERSION = "p11";
/** The previous contract, still readable: analyses made with it keep working (they are directed automatically). */
export const LEGACY_PROMPT_VERSIONS = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10"];

export const SYSTEM = `Role: scene director for a book reader. Input: numbered sentences. Output: one JSON object, no prose, no code fence.
Schema:
{"bible":{"characters":[{"id":"snake_case","desc":"<=15 words, look only; a person starts with man, woman, boy or girl","kind":"person|animal|creature|presence"}],"locations":[{"id":"snake_case","desc":"<=15 words"}]},
"scenes":[{"id":"s<n>","from":<sentence id>,"to":<sentence id>,"visual":bool,
"kind":"static|timelapse|motion|abstract|interior","location":"<location id>","interior":bool,
"time":{"start":"dawn|morning|noon|afternoon|dusk|night","end":"<same set>","progression":"steady|accelerating|slowing"},
"weather":"clear|overcast|rain|snow|fog|storm",
"subjects":[{"ref":"<character id>","pose":"<=3 words","action":"<=4 words","position":"left|center|right|back|front"}],
"props":["<=3 words each, max 8"],"effects":["<=3 words each, max 4"],"mood":"1-2 words",
"atmosphere":{"sky":"<=8 words: how the sky and air look","fog":"#rrggbb","fogDensity":0-1,"light":"#rrggbb light colour"},
"camera":{"framing":"wide|medium|close","motion":"static|push|pull|orbit|drift"},
"beats":[{"at":<sentence id>,"action":"<=6 words, visible change"}],
"audio":{"bed":"<=5 words ambient","spots":[{"at":<sentence id>,"sound":"<=4 words"}]},
"shots":[{"from":<sentence id>,"framing":"wide|medium|close|extreme_close","angle":"eye|low|high|over_shoulder","focus":"<character id|prop word|scene>","move":"static|push|pull|orbit|drift|pan","into":"cut|dissolve|fade"}],
"lines":[{"at":<sentence id>,"speaker":"<character id>","kind":"dialogue|thought"}],
"acting":[{"at":<sentence id>,"who":"<character id>","do":"walk_to|sit|stand|reach|use_lever|look_at|turn|crouch|wave|point|drink|sing|cheer|slam|clap|shrug|nod|bow|cover_face|draw|shake_fist|beckon|think|laugh|plead|gesture","to":"left|center|right|back|front|machine|<character id>"}],
"stage":[{"k":"moon|sun|grow|streak|flash|cam|quake|creature|dim","at":<sentence id>,"to":<sentence id>,"what":"<=3 words","how":"<exact word from the list>","amount":0-1}],
"confidence":0-1}]}
"board":{"steps":[{"at":<sentence id>,"say":"<=8 words","items":[{"t":"eq","tex":"<LaTeX>"},{"t":"plot","fns":[{"expr":"<JS expression in x, e.g. x*x - 2*x, Math.sin(x)>","label":"f"}],"x":[min,max],"y":[min,max],"marks":[{"x":<number>,"label":"c"}],"chord":[x1,x2],"tangent":<x>},{"t":"note","s":"<=14 words"},{"t":"map","title":"<=4 words","points":[{"id":"a","name":"<place>","x":0-100,"y":0-100}],"route":["a","b"]},{"t":"tree","nodes":[{"id":"n1","label":"<name>","parent":"<id or omit>"}]},{"t":"timeline","events":[{"label":"<=4 words","at":0-100}],"from":"<label>","to":"<label>"},{"t":"draw","id":"d1","title":"<=4 words","replace":false,"shapes":[{"k":"rect|circle|line|poly|path|text|tex",...}]}]}]}   (ONLY for mathematical, scientific, technical or structural passages)
Rules:
- Formulas in the sentences appear as $LaTeX$ (a ^{} superscript, a _{} subscript, | between table cells): use them exactly as given in a board's eq items (without the dollar signs).
- BOARD: a theorem, proof, derivation, formula, algorithm or data passage is not a place: set visual:true, kind:"board", location:"board", no subjects, and give "board" with 2-8 steps. Each step "at" is the sentence where it appears; items show in order: eq (one LaTeX equation, display style, no $ signs), plot (a function drawn with optional marked points, a chord between two x values, a tangent at x; draw what the text describes, e.g. a theorem about a function gets a plot of an example function), note (a plain caption). A plot stays on screen until the next plot. Equations are exactly what the text states, step by step as it derives them. Also a board (kind:"board"): a journey through named real places (map: x east, y south, put places where they really lie relative to each other; route lists the places in the order travelled), a genealogy or any hierarchy (tree), a run of dated events or stages (timeline). ANYTHING ELSE that needs a picture (a circuit, a molecule, a flowchart, a state machine, a chessboard, a musical staff, a geometry figure, a diagram of an argument, a table, an org chart, a floor plan) is a \"draw\" item: shapes in a 100 x 70 box, x right, y down: rect {x,y,w,h,fill,stroke,r}, circle {x,y,r}, line {x1,y1,x2,y2,stroke,dash,arrow}, poly {pts:[[x,y]..],closed}, path {d: SVG path data}, text {x,y,s,size,anchor,color}, tex {x,y,tex,size}. Colours are #rrggbb. The board is DARK (#12141c): draw with light colours (strokes and text #e9e4d4, bright fills like #7fb3ff #ff8f70 #d8b45a #8fd0c0), never black or dark grey. Draw it properly: label parts, keep text inside the box, 4-40 shapes. Shapes with the same id accumulate across steps so the drawing builds up as the text explains it; replace:true starts it again. Prefer draw whenever the fixed kinds (plot, map, tree, timeline) do not fit. Maps, trees and timelines stay on screen until the next one; a map's route is drawn only as far as the step reached. Narrative prose with people in a scene keeps its normal scene; when such a scene is a journey or turns on a family or sequence, ALSO give it a \"board\" with \"inset\":true (a map or tree or timeline shown small in a corner while the scene plays) and keep visual:true with its normal fields.
- Scenes contiguous, cover every given sentence, ordered, no overlap. New scene on location, time-jump, or mood change.
- visual:false for dialogue/exposition with nothing to draw; keep other fields minimal.
- kind timelapse: passage describes accelerated time. abstract: sensation/emotion, no concrete objects.
- kind: person = a human; animal = a real animal (a rabbit, a horse, a wolf); creature = any other living or moving thing (a dragon, an angel, a ghost, a robot, a talking teapot). presence = something with no body to draw (God, a voice, the wind, fate, a spirit that is only felt): it is shown as light and mood, never as an object. Anything else that is not a human gets animal or creature, so it is drawn as itself.
- atmosphere: ONLY when the text gives the sky or air a distinctive look (a blood-red dusk, ash clouds, green aurora, thick yellow smog, golden haze, a dust storm); say it plainly and choose the colours the text implies. Otherwise omit the whole field.
- Ids reuse bible entries. Add new characters/locations only when first seen. Describe look, never plot.
- beats/spots anchor to sentence ids inside the scene. Only what the text states or directly implies.
- Direct it like a film. shots: first shot at scene.from establishes (wide); new shot every 2-5 sentences or on a change of focus; close on dialogue/emotion; into:fade only across time jumps, dissolve for soft changes, else cut.
- lines: one entry per sentence that is quoted speech or thought, naming the speaker. Omit narration.
- acting: only visible actions the text states; pick the most specific verb (a toast is drink, a song is sing, a slap on the table is slam; gesture only for plain talking with the hands) so people do not all move alike; at = sentence where it starts; to = where or toward whom.
- stage: be bold and playful: make the world perform the text, not just sit there. Use the EXACT how words below, nothing else. Cue every striking event the text names, in every scene; 1-6 per scene; to > at by 2-5 sentences so it plays long enough to be seen.
  moon: how "new>full" | "full>new" | "crescent>full" (the moon's phases change, or it rises/sets). what unused.
  sun: how "streak" (days racing across the sky) | "red" (a huge red/dying sun hangs on the horizon).
  creature: what "crab" | "butterfly" | "bird" | "insect" | any other creature, how "cross" (it walks or flies across the view) | "circle" (it circles). One cue per creature the text shows.
  grow: what "trees" | "towers" | "flowers" | "grass", how "sprout" (springs up then vanishes) | "rise" (springs up and stays) | "melt" (shrinks away).
  streak: how "rush" (speed lines: fast travel, falling, flight). flash: how "strobe" (day/night flicker) | "lightning".
  dim: how "eclipse" | "dusk" | "dark" (the light fails: eclipses, nightfall, darkness closing in). quake: how "shake" (impacts, tremors).
  cam: how "look_up" (swing up to the sky/moon/sun: pair it with moon or sun) | "roll" | "spin" | "crane" (rise up and look down) | "punch" (dolly-zoom, shock).
- Continue from prev_end when given: same lighting/time unless text changes it.`;

export function buildUser(bible: Bible, prevEnd: string | null, sentences: Sentence[]): string {
  const lines = sentences.map((s) => `[${s.id}] ${s.text.trim()}`).join("\n");
  return `bible: ${JSON.stringify(bible)}\nprev_end: ${prevEnd ?? "none"}\nsentences:\n${lines}`;
}

export function endState(s: Scene): string {
  return `${s.location}, ${s.time.end}, ${s.weather}, mood ${s.mood}, camera ${s.camera.framing}`;
}

/** Pull the first balanced JSON object out of a model reply (tolerates fences and chatter). */
export function extractJson(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const start = t.indexOf("{");
  if (start < 0) throw new Error("no JSON object in reply");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in reply");
}

const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const pick = <T extends string>(v: unknown, set: readonly T[], d: T): T => (set.includes(v as T) ? (v as T) : d);

/** Stage cues kept to known kinds and clamped inside the scene. */
function normStage(raw: any[], from: number, to: number): Cue[] {
  return raw
    .filter((x) => CUE_KINDS.includes(x?.k) && Number.isFinite(Number(x?.at)))
    .slice(0, 8)
    .map((x) => {
      const at = Math.min(to, Math.max(from, Math.round(Number(x.at))));
      return {
        k: x.k as Cue["k"],
        at,
        to: Math.min(to, Math.max(at, Math.round(Number(x.to ?? at + 1)))),
        what: str(x.what).slice(0, 40) || undefined,
        how: str(x.how).slice(0, 40) || undefined,
        amount: Math.min(1, Math.max(0, Number.isFinite(Number(x.amount)) ? Number(x.amount) : 0.6)),
      };
    });
}

/** Shots sorted, inside the scene, the first one starting the scene. Empty in, empty out (the director fills in). */
function normShots(raw: any[], from: number, to: number): Shot[] {
  const shots = raw
    .filter((x) => Number.isInteger(Number(x?.from)))
    .map((x) => ({
      from: Math.min(to, Math.max(from, Number(x.from))),
      framing: pick(x.framing, ["wide", "medium", "close", "extreme_close"] as const, "medium"),
      angle: pick(x.angle, ["eye", "low", "high", "over_shoulder"] as const, "eye"),
      focus: typeof x.focus === "string" && x.focus ? x.focus : "scene",
      move: pick(x.move, ["static", "push", "pull", "orbit", "drift", "pan"] as const, "static"),
      into: pick(x.into, ["cut", "dissolve", "fade"] as const, "cut"),
    }))
    .sort((a, b) => a.from - b.from)
    .filter((x, i, a) => i === 0 || x.from !== a[i - 1].from)
    .slice(0, 24) as Shot[];
  if (shots.length) shots[0].from = from;
  return shots;
}

/** Labels in a drawing that run into each other, or sit half on a box (the model's placement is approximate): each is moved the least distance to where it is clear, or wholly inside the box it belongs to. */
type Box = { x0: number; y0: number; x1: number; y1: number };
function textBox(q: DrawShape): Box | null {
  if (q.k === "text") { const w = q.s.length * (q.size ?? 4) * 0.5, h = (q.size ?? 4); const x0 = q.anchor === "middle" ? q.x - w / 2 : q.anchor === "end" ? q.x - w : q.x; return { x0, x1: x0 + w, y0: q.y - h * 0.85, y1: q.y + h * 0.25 }; }
  if (q.k === "tex") { const h = q.size ?? 5, w = Math.min(60, q.tex.length * h * 0.42); return { x0: q.x, x1: q.x + w, y0: q.y - h, y1: q.y + h * 0.8 }; }
  return null;
}
const solidBox = (q: DrawShape): Box | null => (q.k === "rect" ? { x0: q.x, y0: q.y, x1: q.x + q.w, y1: q.y + q.h } : q.k === "circle" ? { x0: q.x - q.r, y0: q.y - q.r, x1: q.x + q.r, y1: q.y + q.r } : null);
const hit = (a: Box, b: Box) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const inside = (a: Box, b: Box) => a.x0 >= b.x0 - 0.3 && a.x1 <= b.x1 + 0.3 && a.y0 >= b.y0 - 0.3 && a.y1 <= b.y1 + 0.3;
export function fixDraw(shapes: DrawShape[]): DrawShape[] {
  const solids = shapes.map(solidBox).filter(Boolean) as Box[];
  const placed: Box[] = [];
  return shapes.map((q) => {
    const b = textBox(q);
    if (!b) return q;
    const bad = (bb: Box) => solids.some((sb) => hit(bb, sb) && !inside(bb, sb)) || placed.some((pb) => hit(bb, pb)) || bb.x0 < -3 || bb.x1 > 103 || bb.y0 < -6 || bb.y1 > 72;
    let best: { dx: number; dy: number } | null = null;
    if (!bad(b)) best = { dx: 0, dy: 0 };
    else for (const r of [1.5, 3, 4.5, 6, 8, 10]) {
      for (const [ux, uy] of [[0, -1], [0, 1], [1, 0], [-1, 0], [1, -1], [-1, -1], [1, 1], [-1, 1]]) {
        const dx = ux * r, dy = uy * r;
        if (!bad({ x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy })) { best = { dx, dy }; break; }
      }
      if (best) break;
    }
    const d = best ?? { dx: 0, dy: 0 };
    placed.push({ x0: b.x0 + d.dx, x1: b.x1 + d.dx, y0: b.y0 + d.dy, y1: b.y1 + d.dy });
    return d.dx || d.dy ? { ...q, x: (q as any).x + d.dx, y: (q as any).y + d.dy } : q;
  });
}

/** A board's steps, inside the scene, in order; an item that is not understood is left out. A board with nothing left is no board. */
function normBoard(raw: any, from: number, to: number): Board | undefined {
  if (!raw || !Array.isArray(raw.steps)) return undefined;
  const num = (v: any): number | undefined => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : undefined);
  const pair = (v: any): [number, number] | undefined => (Array.isArray(v) && num(v[0]) !== undefined && num(v[1]) !== undefined && Number(v[0]) < Number(v[1]) ? [Number(v[0]), Number(v[1])] : undefined);
  const steps: BoardStep[] = [];
  for (const st of raw.steps.slice(0, 12)) {
    const at = Math.min(to, Math.max(from, Math.round(Number(st?.at ?? from))));
    const items: BoardItem[] = [];
    for (const it of arr<any>(st?.items).slice(0, 5)) {
      if (it?.t === "eq" && typeof it.tex === "string" && it.tex.trim()) items.push({ t: "eq", tex: it.tex.trim().slice(0, 400) });
      else if (it?.t === "note" && typeof it.s === "string" && it.s.trim()) items.push({ t: "note", s: it.s.trim().slice(0, 160) });
      else if (it?.t === "draw" && Array.isArray(it.shapes)) {
        const n = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Math.min(140, Math.max(-40, Number(v))) : d);
        const col = (v: any) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
        const shapes: DrawShape[] = [];
        for (const q of it.shapes.slice(0, 60)) {
          const sw = n(q?.sw, 0.6) > 0 ? Math.min(4, Math.abs(n(q?.sw, 0.6))) : 0.6;
          if (q?.k === "rect") shapes.push({ k: "rect", x: n(q.x), y: n(q.y), w: Math.max(0, n(q.w, 10)), h: Math.max(0, n(q.h, 10)), fill: col(q.fill), stroke: col(q.stroke), r: Math.min(10, Math.max(0, n(q.r))), sw });
          else if (q?.k === "circle") shapes.push({ k: "circle", x: n(q.x), y: n(q.y), r: Math.min(60, Math.max(0.2, n(q.r, 3))), fill: col(q.fill), stroke: col(q.stroke), sw });
          else if (q?.k === "line") shapes.push({ k: "line", x1: n(q.x1), y1: n(q.y1), x2: n(q.x2), y2: n(q.y2), stroke: col(q.stroke), sw, dash: q.dash === true, arrow: q.arrow === true });
          else if (q?.k === "poly" && Array.isArray(q.pts)) { const pts = q.pts.slice(0, 40).filter((p: any) => Array.isArray(p)).map((p: any) => [n(p[0]), n(p[1])] as [number, number]); if (pts.length >= 2) shapes.push({ k: "poly", pts, fill: col(q.fill), stroke: col(q.stroke), sw, closed: q.closed !== false }); }
          else if (q?.k === "path" && typeof q.d === "string" && /^[MmLlHhVvCcSsQqTtAaZz0-9eE.,\s-]+$/.test(q.d) && q.d.length < 600) shapes.push({ k: "path", d: q.d, fill: col(q.fill), stroke: col(q.stroke), sw });
          else if (q?.k === "text" && typeof q.s === "string") shapes.push({ k: "text", x: n(q.x), y: n(q.y), s: q.s.slice(0, 60), size: Math.min(12, Math.max(1.5, n(q.size, 4))), color: col(q.color), anchor: q.anchor === "middle" || q.anchor === "end" ? q.anchor : "start", italic: q.italic === true });
          else if (q?.k === "tex" && typeof q.tex === "string") shapes.push({ k: "tex", x: n(q.x), y: n(q.y), tex: q.tex.slice(0, 120), size: Math.min(12, Math.max(2, n(q.size, 5))), color: col(q.color) });
        }
        if (shapes.length) items.push({ t: "draw", id: typeof it.id === "string" ? it.id.slice(0, 16) : "d", title: typeof it.title === "string" ? it.title.slice(0, 40) : undefined, replace: it.replace === true, shapes: fixDraw(shapes) });
      } else if (it?.t === "map" && Array.isArray(it.points)) {
        const points = arr<any>(it.points).filter((q) => typeof q?.id === "string" && typeof q?.name === "string" && num(q?.x) !== undefined && num(q?.y) !== undefined).slice(0, 14).map((q) => ({ id: q.id.slice(0, 20), name: q.name.slice(0, 22), x: Math.min(100, Math.max(0, Number(q.x))), y: Math.min(100, Math.max(0, Number(q.y))) }));
        if (points.length) items.push({ t: "map", title: typeof it.title === "string" ? it.title.slice(0, 40) : undefined, points, route: arr<any>(it.route).map(String).filter((id) => points.some((q) => q.id === id)).slice(0, 20) });
      } else if (it?.t === "tree" && Array.isArray(it.nodes)) {
        const nodes = arr<any>(it.nodes).filter((q) => typeof q?.id === "string" && typeof q?.label === "string").slice(0, 30).map((q) => ({ id: q.id.slice(0, 20), label: q.label.slice(0, 24), parent: typeof q.parent === "string" ? q.parent : undefined }));
        if (nodes.length) items.push({ t: "tree", nodes: nodes.map((q) => ({ ...q, parent: q.parent && nodes.some((x) => x.id === q.parent && x.id !== q.id) ? q.parent : undefined })) });
      } else if (it?.t === "timeline" && Array.isArray(it.events)) {
        const events = arr<any>(it.events).filter((q) => typeof q?.label === "string" && num(q?.at) !== undefined).slice(0, 12).map((q) => ({ label: q.label.slice(0, 44), at: Math.min(100, Math.max(0, Number(q.at))) })).sort((a, b) => a.at - b.at);
        if (events.length) items.push({ t: "timeline", events, from: typeof it.from === "string" ? it.from.slice(0, 20) : undefined, to: typeof it.to === "string" ? it.to.slice(0, 20) : undefined });
      } else if (it?.t === "plot") {
        const x = pair(it.x);
        const fns = arr<any>(it.fns).filter((f) => typeof f?.expr === "string" && f.expr.trim()).slice(0, 3).map((f) => ({ expr: String(f.expr).slice(0, 120), label: typeof f.label === "string" ? f.label.slice(0, 12) : undefined }));
        if (x && fns.length) {
          items.push({ t: "plot", fns, x, y: pair(it.y), marks: arr<any>(it.marks).filter((m) => num(m?.x) !== undefined).slice(0, 6).map((m) => ({ x: Number(m.x), label: typeof m.label === "string" ? m.label.slice(0, 10) : undefined })), chord: pair(it.chord), tangent: num(it.tangent) });
        }
      }
    }
    if (items.length) steps.push({ at, say: typeof st?.say === "string" ? st.say.slice(0, 80) : undefined, items });
  }
  steps.sort((a, b) => a.at - b.at);
  return steps.length ? { steps, ...(raw.inset === true ? { inset: true } : {}) } : undefined;
}

function normAtmosphere(a: any): Scene["atmosphere"] {
  if (!a || typeof a !== "object") return undefined;
  const hex = (v: any) => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
  const sky = typeof a.sky === "string" && a.sky.trim() ? a.sky.trim().slice(0, 80) : undefined;
  const lum = (h?: string) => (h ? (0.3 * parseInt(h.slice(1, 3), 16) + 0.59 * parseInt(h.slice(3, 5), 16) + 0.11 * parseInt(h.slice(5, 7), 16)) / 255 : 1);
  const darkText = /dark|black|night|void|gloom|dim|shadow|murk|blind|abyss/i.test(sky ?? "");
  // (a model that fills the fields in when asked for nothing gives placeholders: black fog and black light would muddy a bright day)
  const fog = hex(a.fog) && (lum(hex(a.fog)) > 0.08 || darkText) ? hex(a.fog) : undefined;
  const light = hex(a.light) && (lum(hex(a.light)) > 0.2 || darkText) ? hex(a.light) : undefined;
  const out = { sky, fog, fogDensity: Number.isFinite(Number(a.fogDensity)) ? Math.min(0.06, Math.max(0, Number(a.fogDensity) * 0.1)) : undefined, light };
  return out.sky || out.fog || out.light || out.fogDensity !== undefined ? out : undefined;
}

/** Validate against the chunk's sentence range; repair what's safe, throw on what isn't. */
export function validateChunk(raw: unknown, first: number, last: number, prior: Bible): Chunk {
  const r = raw as Record<string, any>;
  if (!r || !Array.isArray(r.scenes) || r.scenes.length === 0) throw new Error("reply has no scenes");
  const bible: Bible = {
    characters: [...prior.characters],
    locations: [...prior.locations],
  };
  for (const c of arr<Character>(r.bible?.characters)) {
    if (c?.id && !bible.characters.some((x) => x.id === c.id)) bible.characters.push({ id: str(c.id), desc: str(c.desc), ...(c.kind === "animal" || c.kind === "creature" || c.kind === "person" || c.kind === "presence" ? { kind: c.kind } : {}) });
  }
  for (const l of arr<Location>(r.bible?.locations)) {
    if (l?.id && !bible.locations.some((x) => x.id === l.id)) bible.locations.push({ id: str(l.id), desc: str(l.desc) });
  }
  const scenes: Scene[] = r.scenes.map((s: any, i: number) => {
    const from = Number(s.from);
    const to = Number(s.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error(`scene ${i}: bad range ${s.from}-${s.to}`);
    const inRange = (n: unknown) => Number.isInteger(Number(n)) && Number(n) >= from && Number(n) <= to;
    return {
      id: str(s.id, `s${i + 1}`),
      from,
      to,
      visual: s.visual !== false,
      kind: (["static", "timelapse", "motion", "abstract", "interior", "board"].includes(s.kind) ? s.kind : "static") as Scene["kind"],
      location: str(s.location),
      interior: !!s.interior,
      time: {
        start: str(s.time?.start, "noon"),
        end: str(s.time?.end, str(s.time?.start, "noon")),
        progression: (["steady", "accelerating", "slowing"].includes(s.time?.progression) ? s.time.progression : "steady") as Scene["time"]["progression"],
      },
      weather: str(s.weather, "clear"),
      subjects: arr<any>(s.subjects).map((x) => ({ ref: str(x.ref), pose: str(x.pose), action: str(x.action), position: str(x.position, "center") })),
      props: arr<string>(s.props).map(String).slice(0, 8),
      effects: arr<string>(s.effects).map(String).slice(0, 4),
      mood: str(s.mood),
      atmosphere: normAtmosphere(s.atmosphere),
      camera: { framing: str(s.camera?.framing, "medium"), motion: str(s.camera?.motion, "static") },
      beats: arr<any>(s.beats).filter((b) => inRange(b?.at)).map((b) => ({ at: Number(b.at), action: str(b.action) })),
      audio: {
        bed: str(s.audio?.bed),
        spots: arr<any>(s.audio?.spots).filter((b) => inRange(b?.at)).map((b) => ({ at: Number(b.at), sound: str(b.sound) })),
      },
      confidence: Math.min(1, Math.max(0, Number(s.confidence ?? 0.5))),
      board: normBoard(s.board, from, to),
      shots: normShots(arr<any>(s.shots), from, to),
      stage: normStage(arr<any>(s.stage), from, to),
      lines: arr<any>(s.lines).filter((l) => inRange(l?.at) && typeof l?.speaker === "string").map((l) => ({ at: Number(l.at), speaker: String(l.speaker), kind: l.kind === "thought" ? "thought" : "dialogue" })) as Line[],
      acting: arr<any>(s.acting).filter((a) => inRange(a?.at) && typeof a?.who === "string" && typeof a?.do === "string").slice(0, 40).map((a) => ({ at: Number(a.at), who: String(a.who), do: String(a.do), to: typeof a.to === "string" ? a.to : undefined })) as Act[],
      place: arr<any>(s.place).filter((p) => typeof p?.asset === "string").slice(0, 40).map((p) => ({ asset: String(p.asset), x: Number(p.x ?? 0), y: Number(p.y ?? 0), z: Number(p.z ?? 0), height: p.height === undefined ? undefined : Number(p.height), rotY: p.rotY === undefined ? undefined : Number(p.rotY) })),
    };
  });
  // contiguity: scenes must tile [first, last]; close small gaps/overlaps instead of failing the whole chunk
  scenes.sort((a, b) => a.from - b.from);
  scenes[0].from = first;
  for (let i = 1; i < scenes.length; i++) {
    scenes[i - 1].to = scenes[i].from - 1;
  }
  scenes[scenes.length - 1].to = last;
  for (const sc of scenes) if (sc.kind === "board" && !sc.board) sc.kind = "abstract"; // (a board that did not survive validation is no board)
  const kept = scenes.filter((s) => s.from <= s.to);
  if (!kept.length) throw new Error("no scene survived range repair");
  return { scenes: kept, bible };
}
