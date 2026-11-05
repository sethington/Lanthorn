// Scene JSON contract v0.2, prompt builder, parser/validator. Pure: no DOM, no Tauri.
// Vocabularies are open for now; they close once the asset catalog and compiler exist (docs/spec.md).

import type { Sentence } from "./text";

export type Character = { id: string; desc: string };
export type Location = { id: string; desc: string };
export type Bible = { characters: Character[]; locations: Location[] };

export type Scene = {
  id: string;
  from: number; // first sentence id
  to: number; // last sentence id (inclusive)
  visual: boolean;
  kind: "static" | "timelapse" | "motion" | "abstract" | "interior";
  location: string;
  interior: boolean;
  time: { start: string; end: string; progression: "steady" | "accelerating" | "slowing" };
  weather: string;
  subjects: { ref: string; pose: string; action: string; position: string }[];
  props: string[];
  effects: string[];
  mood: string;
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

export const ACTS = ["walk_to", "sit", "stand", "reach", "use_lever", "look_at", "turn", "gesture", "crouch"] as const;

export type Chunk = { scenes: Scene[]; bible: Bible };

/** Bump when SYSTEM or the output contract changes, so cached model replies are not reused. */
export const PROMPT_VERSION = "p4";
/** The previous contract, still readable: analyses made with it keep working (they are directed automatically). */
export const LEGACY_PROMPT_VERSIONS = ["p1", "p2", "p3"];

export const SYSTEM = `Role: scene director for a book reader. Input: numbered sentences. Output: one JSON object, no prose, no code fence.
Schema:
{"bible":{"characters":[{"id":"snake_case","desc":"<=15 words, look only"}],"locations":[{"id":"snake_case","desc":"<=15 words"}]},
"scenes":[{"id":"s<n>","from":<sentence id>,"to":<sentence id>,"visual":bool,
"kind":"static|timelapse|motion|abstract|interior","location":"<location id>","interior":bool,
"time":{"start":"dawn|morning|noon|afternoon|dusk|night","end":"<same set>","progression":"steady|accelerating|slowing"},
"weather":"clear|overcast|rain|snow|fog|storm",
"subjects":[{"ref":"<character id>","pose":"<=3 words","action":"<=4 words","position":"left|center|right|back|front"}],
"props":["<=3 words each, max 8"],"effects":["<=3 words each, max 4"],"mood":"1-2 words",
"camera":{"framing":"wide|medium|close","motion":"static|push|pull|orbit|drift"},
"beats":[{"at":<sentence id>,"action":"<=6 words, visible change"}],
"audio":{"bed":"<=5 words ambient","spots":[{"at":<sentence id>,"sound":"<=4 words"}]},
"shots":[{"from":<sentence id>,"framing":"wide|medium|close|extreme_close","angle":"eye|low|high|over_shoulder","focus":"<character id|prop word|scene>","move":"static|push|pull|orbit|drift|pan","into":"cut|dissolve|fade"}],
"lines":[{"at":<sentence id>,"speaker":"<character id>","kind":"dialogue|thought"}],
"acting":[{"at":<sentence id>,"who":"<character id>","do":"walk_to|sit|stand|reach|use_lever|look_at|turn|gesture|crouch","to":"left|center|right|back|front|machine|<character id>"}],
"stage":[{"k":"moon|sun|grow|streak|flash|cam|quake|creature|dim","at":<sentence id>,"to":<sentence id>,"what":"<=3 words","how":"<exact word from the list>","amount":0-1}],
"confidence":0-1}]}
Rules:
- Scenes contiguous, cover every given sentence, ordered, no overlap. New scene on location, time-jump, or mood change.
- visual:false for dialogue/exposition with nothing to draw; keep other fields minimal.
- kind timelapse: passage describes accelerated time. abstract: sensation/emotion, no concrete objects.
- Ids reuse bible entries. Add new characters/locations only when first seen. Describe look, never plot.
- beats/spots anchor to sentence ids inside the scene. Only what the text states or directly implies.
- Direct it like a film. shots: first shot at scene.from establishes (wide); new shot every 2-5 sentences or on a change of focus; close on dialogue/emotion; into:fade only across time jumps, dissolve for soft changes, else cut.
- lines: one entry per sentence that is quoted speech or thought, naming the speaker. Omit narration.
- acting: only visible actions the text states; at = sentence where it starts; to = where or toward whom.
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

/** Validate against the chunk's sentence range; repair what's safe, throw on what isn't. */
export function validateChunk(raw: unknown, first: number, last: number, prior: Bible): Chunk {
  const r = raw as Record<string, any>;
  if (!r || !Array.isArray(r.scenes) || r.scenes.length === 0) throw new Error("reply has no scenes");
  const bible: Bible = {
    characters: [...prior.characters],
    locations: [...prior.locations],
  };
  for (const c of arr<Character>(r.bible?.characters)) {
    if (c?.id && !bible.characters.some((x) => x.id === c.id)) bible.characters.push({ id: str(c.id), desc: str(c.desc) });
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
      kind: (["static", "timelapse", "motion", "abstract", "interior"].includes(s.kind) ? s.kind : "static") as Scene["kind"],
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
      camera: { framing: str(s.camera?.framing, "medium"), motion: str(s.camera?.motion, "static") },
      beats: arr<any>(s.beats).filter((b) => inRange(b?.at)).map((b) => ({ at: Number(b.at), action: str(b.action) })),
      audio: {
        bed: str(s.audio?.bed),
        spots: arr<any>(s.audio?.spots).filter((b) => inRange(b?.at)).map((b) => ({ at: Number(b.at), sound: str(b.sound) })),
      },
      confidence: Math.min(1, Math.max(0, Number(s.confidence ?? 0.5))),
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
  const kept = scenes.filter((s) => s.from <= s.to);
  if (!kept.length) throw new Error("no scene survived range repair");
  return { scenes: kept, bible };
}
