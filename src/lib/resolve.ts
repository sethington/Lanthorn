// Resolver: LLM scene JSON -> concrete render plan (assets, sizes, positions, sky, light, camera).
// Pure and deterministic (seeded by the scene). The LLM selects and directs; this places and sizes in metres.
// Poly Haven dims are Blender axes in metres: [x, y, depth, height = dims[2]].

import catalog from "../catalog/polyhaven.json" with { type: "json" };
import type { PackageAsset } from "./book";
import type { Act, Bible, Cue, Scene, Shot } from "./scene";

type Model = { id: string; name: string; tags: string[]; cats: string[]; dims: number[]; poly: number };
type Tagged = { id: string; name: string; tags: string[]; cats: string[] };
const MODELS = catalog.models as Model[];
const HDRIS = catalog.hdris as Tagged[];

export type Placed = { id: string; file: string; pos: [number, number, number]; rotY: number; scale: number; label: string };
type SkyRef = { id: string; file: string };
export type Fig = {
  ref: string;
  kind: "man" | "woman" | "eloi" | "generic";
  pose: "seated" | "standing" | "walking" | "crouch";
  x: number;
  z: number;
  yaw: number;
  onMachine: boolean;
  walk: [number, number, number, number] | null; // x0, z0, x1, z1 over the scene
  scale: number;
  /** what they wear and look like, from the book's own description of them */
  look?: { coat: string; vest: string; trou: string; boot: string; hair: string; skin: string; old: boolean };
  /** what this character does, in the world's 0..1 progress: sit, stand, crouch, walk_to (with a target), reach, use_lever, gesture, look_at, turn */
  acts?: { p0: number; p1: number; do: string; tx?: number; tz?: number }[];
};
export type CamShot = {
  p0: number; // span of the scene, 0..1
  p1: number;
  from: [number, number, number];
  to: [number, number, number];
  lookFrom: [number, number, number];
  lookTo: [number, number, number];
  fov: number;
  fstop: number;
  into: "cut" | "dissolve" | "fade";
};
export type StageR = {
  k: Cue["k"];
  p0: number;
  p1: number;
  how: string;
  amount: number;
  /** creature: its kind (crab, butterfly, bird) */
  what?: string;
  /** moon and sun: where in the sky (azimuth in radians from +Z toward +X, elevation in degrees) */
  az?: number;
  el?: number;
  /** moon: phase at the start and end, 0 new .. 1 full */
  ph?: [number, number];
  /** grow: the models, placed */
  items?: { id: string; file: string; pos: [number, number, number]; rotY: number; scale: number; d: number; tower?: { h: number; w: number } }[];
};

export type Resolved = {
  id: string;
  frames: number;
  fps: number;
  size: [number, number];
  interior: boolean;
  sky: { night: SkyRef; dawn: SkyRef; day: SkyRef; dusk: SkyRef; intensity: number; rotation: number };
  sun: { startElev: number; endElev: number; cycles: number; azimuth: number; color: string; strength: number };
  ground: { id: string; tile: number } | null;
  /** water at the edge of the land (the sea, a lake): where the shore runs (z) and what kind of water it is */
  water: { zEdge: number; mood: "calm" | "oily" | "red" | "storm" } | null;
  room: { w: number; d: number; h: number; floor: string; wall: string } | null;
  fog: { color: string; density: number };
  assets: Placed[];
  hero: { kind: "time_machine" | "none"; figure: boolean; sphinx: boolean };
  figures: Fig[];
  textures: string[];
  lights: { pos: [number, number, number]; color: string; intensity: number }[];
  /** stage cues, resolved: progress span in the world's 0..1, plus whatever each kind needs (sky position, phases, placed models) */
  stage?: StageR[];
  /** the picture's look (src/lib/style.ts): cinematic, storybook, cartoon, dream, noir, pixel */
  style?: string;
  /** directed camera: one rig per shot. When absent the single `camera` move is used. */
  shots?: CamShot[];
  camera: { from: [number, number, number]; to: [number, number, number]; lookFrom: [number, number, number]; lookTo: [number, number, number]; fov: number; focus: number; fstop: number };
  beats: { t: number; kind: string }[];
  exposure: number;
  weather: string;
  unresolved: string[];
  /** live world (raea play) rather than baked frames */
  live?: boolean;
  t0?: number; // narrative position to start from, 0..1
  loopSeconds?: number;
};

const SUN_ELEV: Record<string, number> = { dawn: 5, morning: 24, noon: 64, afternoon: 38, dusk: 3, night: -28 };
const FOG: Record<string, string> = { dawn: "#d9b8a0", morning: "#c6d4e6", noon: "#bccfe6", afternoon: "#d3c8b0", dusk: "#c18c6c", night: "#0e1630" };
const SUN_COLOR: Record<string, string> = { dawn: "#ffb48a", morning: "#ffe2bf", noon: "#fff4e0", afternoon: "#ffe2b8", dusk: "#ff8f52", night: "#7f9cff" };

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STOP = new Set(["a", "an", "the", "of", "and", "with", "in", "on", "at", "to", "old", "small", "large", "big", "dim", "distant", "rising", "shifting", "blurred", "swaying", "white", "brass", "ivory"]);
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => (w.length > 3 ? w.replace(/(es|s)$/, "") : w));

const POLY_BUDGET = 600_000;
const ACTS_KNOWN = ["walk_to", "sit", "stand", "reach", "use_lever", "look_at", "turn", "gesture", "crouch"];

/** Best catalog model for a phrase, or null. Heavy meshes are skipped. */
/** Buildings the runtime builds itself (Manifold solids): the catalogue has none. */
export const BUILDINGS: [string, RegExp, number, number][] = [
  // kind, words, scale, distance behind the action (m)
  ["church", /church|chapel|cathedral|temple|abbey|monaster/, 1.3, 16],
  ["ruin", /\bruin|ruined|crumbl|fallen (?:wall|tower)|broken (?:wall|tower)/, 1.1, 14],
  ["tower", /tower|lighthouse|spire|keep\b|turret|castle|fortress/, 1.2, 18],
  ["pyramid", /pyramid|ziggurat/, 1.8, 40],
  ["obelisk", /obelisk|monolith|pillar of stone|standing stone/, 1.0, 12],
  ["cyclopean", /cyclopean|r'lyeh|titan blocks|vast (?:masonry|city)|sunken city|non-euclid/, 1.6, 30],
  ["city", /\bcity\b|skyscraper|skyline|metropolis|towns?\b/, 1.0, 34],
  ["house", /house|cottage|hut|inn\b|tavern|barn|farm|mill\b|cabin|dwelling|village|building/, 1.0, 14],
];
export const buildingKind = (phrase: string): [string, RegExp, number, number] | undefined => BUILDINGS.find((b) => b[1].test(phrase.toLowerCase()));

const COLOURS: [RegExp, string][] = [
  [/\bblack\b|\bebony\b|\bsable\b/, "#26262b"], [/\bwhite\b|\bivory\b|\bcream\b/, "#e4e0d4"], [/\bgr[ae]y\b|\bsilver\b|\bslate\b/, "#70737a"],
  [/\bnavy\b|\bdark blue\b/, "#2b3550"], [/\bblue\b/, "#3f5679"], [/\bcrimson\b|\bscarlet\b/, "#7a2430"], [/\bred\b|\bmaroon\b/, "#8d3a32"],
  [/\bgreen\b|\bolive\b/, "#4a6244"], [/\byellow\b|\bgold(?:en)?\b/, "#c3a24a"], [/\bpurple\b|\bviolet\b|\bplum\b/, "#6d4a82"], [/\bpink\b/, "#c88ba0"],
  [/\borange\b/, "#b3693a"], [/\btan\b|\bbeige\b|\bkhaki\b|\bbuff\b/, "#a99772"], [/\bbrown\b|\bleather\b/, "#6a5340"],
];
const mixHexC = (a: string, b: string, k: number) => {
  const h = (s: string) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
  const x = h(a), y = h(b);
  return `#${x.map((v, i) => Math.round(v * (1 - k) + y[i] * k).toString(16).padStart(2, "0")).join("")}`;
};
/** Who this is, from the book's description of them: which body, how old, what they wear. Seeded by name so the same person always looks the same. */
export function personLook(ref: string, desc: string, rnd: () => number): { body: "man" | "woman" | "kid"; look: NonNullable<Fig["look"]> } {
  const t = `${ref.replace(/_/g, " ")} ${desc}`.toLowerCase();
  const she = /\b(she|her|woman|women|girl|lady|mrs|miss|ms|mother|daughter|queen|wife|madam|aunt|sister|widow|maid|housekeeper|actress|duchess|countess|princess)\b/.test(t);
  const he = /\b(he|his|him|man|men|boy|gentleman|mr|father|king|husband|uncle|brother|sir|lord|captain|doctor|professor|inspector|sailor|priest)\b/.test(t);
  const child = /\b(child|children|kid|little (?:boy|girl)|toddler|infant|schoolboy|schoolgirl|eloi|boy|girl)\b/.test(t) && !/\bold\b.*\bman\b/.test(t);
  const old = /\b(old|elderly|aged|ancient|grey-?haired|white-?haired|silver-?haired|bent|frail|stooped|venerable|withered)\b/.test(t);
  const body: "man" | "woman" | "kid" = child ? "kid" : she && !he ? "woman" : "man";
  const nearby = (re: RegExp): string | null => {
    const m = re.exec(t);
    if (!m) return null;
    const around = t.slice(Math.max(0, m.index - 28), m.index + 36);
    for (const [c, hex] of COLOURS) if (c.test(around)) return hex;
    return null;
  };
  const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
  const cloth = nearby(/\b(coat|jacket|dress|robe|suit|uniform|gown|cloak|tunic|shirt|clothes|clothing|garb|attire|cassock|frock)\b/)
    ?? pick(body === "woman" ? ["#7a5590", "#5b6f58", "#7f3f45", "#3f4f6b", "#6d5a4a", "#2f3037"] : ["#6a5340", "#3f4a58", "#4a4a50", "#5a6048", "#5d4a3a", "#2e3036"]);
  const hairWord = /(black|brown|blond|blonde|golden|flaxen|red|ginger|auburn|grey|gray|white|silver|dark)[- ]?(?:hair|haired|beard|bearded)/.exec(t)?.[1];
  const hairMap: Record<string, string> = { black: "#1f1b18", brown: "#4a3626", blond: "#c7a65a", blonde: "#c7a65a", golden: "#d6b45c", flaxen: "#d6b45c", red: "#8a3a22", ginger: "#a2481f", auburn: "#6e3320", grey: "#9a9a9a", gray: "#9a9a9a", white: "#e2e0da", silver: "#c4c4c4", dark: "#2a2220" };
  const hair = old && !hairWord ? "#b9b6b0" : hairMap[hairWord ?? ""] ?? pick(["#4a3626", "#2a2220", "#6a4a2e", "#8a6a3e", "#1f1b18"]);
  const skin = /\b(pale|fair|white-skinned)\b/.test(t) ? "#ecc9ad" : /\b(dark-skinned|black-skinned|dark skin|ebony)\b/.test(t) ? "#8a5a3c" : /\b(tanned|swarthy|olive|brown-skinned|sunburnt|weathered)\b/.test(t) ? "#c08e66" : pick(["#e8c39d", "#d7b08f", "#c99a73", "#e3bd9f", "#b98458", "#f0d2b3"]);
  return {
    body,
    look: { coat: cloth, vest: mixHexC(cloth, "#d8cba8", 0.45), trou: body === "woman" ? cloth : mixHexC(cloth, "#2a2a2e", 0.55), boot: "#2a211b", hair, skin, old },
  };
}

export function matchModel(phrase: string, allowed?: (m: Model) => boolean): Model | null {
  const ws = words(phrase);
  if (!ws.length) return null;
  // the thing named is its last word ("sea-chest" is a chest, not the sea): a model must answer to that word, or it is a wrong object
  const head = ws[ws.length - 1];
  const heads = new Set([head, head.replace(/ies$/, "y"), head.replace(/es$/, ""), head.replace(/s$/, "")]);
  let best: { m: Model; s: number } | null = null;
  for (const m of MODELS) {
    if (m.poly > POLY_BUDGET || (allowed && !allowed(m))) continue;
    const nameW = new Set(words(m.name.replace(/_/g, " ")));
    const tagW = new Set(m.tags.flatMap((t) => words(t)));
    const catW = new Set(m.cats.flatMap((t) => words(t)));
    if (ws.length > 1 && ![...heads].some((h) => nameW.has(h) || tagW.has(h))) continue;
    let s = 0;
    for (const w of ws) {
      if (nameW.has(w)) s += 4;
      else if (tagW.has(w)) s += 2;
      else if (catW.has(w)) s += 1;
    }
    if (s >= 3 && (!best || s > best.s)) best = { m, s };
  }
  return best?.m ?? null;
}

const height = (m: Model) => m.dims[2] || 1;
const mainFile = (id: string) => {
  const m = MODELS.find((x) => x.id === id)!;
  void m;
  return `polyhaven/${id}/${id}_1k.gltf`;
};

function pickSky(time: string, weather: string, taken: Set<string>): { id: string; file: string } {
  const night = time === "night";
  const dusk = time === "dawn" || time === "dusk";
  const grey = weather === "overcast" || weather === "rain" || weather === "storm" || weather === "fog";
  const want = night ? ["night"] : grey ? ["overcast"] : dusk ? ["sunrise-sunset"] : ["midday", "clear", "partly cloudy"];
  let best: { h: Tagged; s: number } | null = null;
  for (const h of HDRIS) {
    const c = new Set(h.cats);
    if (!c.has("outdoor") && !night) continue;
    let s = 0;
    for (const w of want) if (c.has(w)) s += 3;
    if (c.has("pure skies")) s += 4; // no ground clutter behind our own terrain
    if (c.has("indoor") || c.has("studio")) s -= 10;
    if (c.has("urban")) s -= 2;
    if (night && c.has("artificial light")) s -= 1;
    if (s > 0 && (!best || s > best.s || (s === best.s && h.id < best.h.id))) best = { h, s };
  }
  const h = best?.h ?? HDRIS[0];
  taken.add(h.id);
  return { id: h.id, file: `polyhaven/${h.id}/${h.id}_1k.hdr` };
}

type Kind = "exterior" | "interior";
const EXT_WORDS = ["hill", "hillside", "landscape", "garden", "lawn", "meadow", "field", "forest", "wood", "valley", "beach", "shore", "road", "street", "plain", "desert", "mountain", "cliff", "river", "sky", "rhododendron"];

/** A bundled model as a catalog-shaped entry, so the same placement code handles both. Ids are prefixed `pkg:`. */
function pkgModels(assets: PackageAsset[] | undefined): { models: Model[]; files: Map<string, string> } {
  const files = new Map<string, string>();
  const models = (assets ?? []).filter((a) => a.kind === "model").map((a) => {
    files.set(`pkg:${a.id}`, a.file);
    return { id: `pkg:${a.id}`, name: a.id.replace(/[-_]+/g, " "), tags: a.tags, cats: [] as string[], dims: [0, 0, a.height ?? 1], poly: 0 } as Model;
  });
  return { models, files };
}

function matchPkg(phrase: string, models: Model[]): Model | null {
  const ws = words(phrase);
  let best: { m: Model; s: number } | null = null;
  for (const m of models) {
    const nameW = new Set(words(m.name));
    const tagW = new Set(m.tags.flatMap((t) => words(t)));
    let s = 0;
    for (const w of ws) s += nameW.has(w) ? 4 : tagW.has(w) ? 3 : 0;
    if (s >= 3 && (!best || s > best.s)) best = { m, s };
  }
  return best?.m ?? null;
}

export function resolveScene(scene: Scene, bible: Bible, opts: { frames?: number; size?: [number, number]; pkg?: PackageAsset[]; shots?: { shot: Shot; p0: number; p1: number }[]; stage?: { cue: Cue; p0: number; p1: number }[]; acting?: { act: Act; p0: number; p1: number }[]; style?: string } = {}): Resolved {
  const pkg = pkgModels(opts.pkg);
  const loc = bible.locations.find((l) => l.id === scene.location);
  const locText = `${scene.location} ${loc?.desc ?? ""}`;
  const lw = words(locText.replace(/_/g, " "));
  const kind: Kind = scene.interior && !EXT_WORDS.some((e) => lw.includes(e)) ? "interior" : "exterior";
  const r = rng(hash(`${scene.id}:${scene.from}:${scene.to}`));
  const nSent = scene.to - scene.from + 1;
  // frames are scrubbed by reading position, so a scene needs resolution only where something changes: a static scene
  // barely moves, a time-lapse changes constantly. Fewer frames is the biggest lever on cache size.
  const perSentence = ({ static: 6, interior: 6, abstract: 10, motion: 12, timelapse: 16 } as Record<string, number>)[scene.kind] ?? 8;
  const frames = opts.frames ?? Math.max(48, Math.min(260, nSent * perSentence));
  const unresolved: string[] = [];
  const assets: Placed[] = [];
  const taken = new Set<string>();

  // ---- sky and sun: steps through the scene's time range; timelapse spins the sun
  const t0 = scene.time.start;
  const t1 = scene.time.end;
  const grey = ["overcast", "rain", "storm", "fog"].includes(scene.weather);
  const moving = scene.kind === "timelapse" || t0 !== t1;
  const bucket = (tm: string) => (tm === "night" ? "night" : tm === "dawn" ? "dawn" : tm === "dusk" ? "dusk" : "day");
  // indoors the sky only lights and reflects: an overcast one has no sun disc to glint off every surface (a clear one speckles)
  const skyWeather = kind === "interior" ? "overcast" : scene.weather;
  const one = pickSky(t0, skyWeather, taken);
  const skyPool: Record<string, SkyRef> = { night: one, dawn: one, day: one, dusk: one };
  if (moving) for (const b of ["night", "dawn", "day", "dusk"]) skyPool[b] = pickSky(b === "day" ? "noon" : b, skyWeather, taken);
  else skyPool[bucket(t0)] = one;
  const cycles = scene.kind === "timelapse" ? (scene.time.progression === "accelerating" ? 3 : 2) : 0;

  // ---- hero and set dressing
  const propText = scene.props.join(" ; ").toLowerCase();
  const sceneText = `${propText} ${locText} ${scene.subjects.map((s) => s.ref).join(" ")}`.toLowerCase();
  const hero = {
    kind: /machine|saddle|lever|quartz|dial/.test(sceneText) || scene.subjects.some((s) => s.ref === "time_traveller") ? ("time_machine" as const) : ("none" as const),
    figure: scene.subjects.some((s) => s.ref === "time_traveller"),
    sphinx: /sphinx|pedestal/.test(sceneText),
  };

  // ---- people: who is in the scene, doing what, where (slots are metres around the hero)
  const figures: Fig[] = [];
  const slotX: Record<string, number> = { left: -1.8, center: 0, right: 1.8, back: 0.6, front: -0.6 };
  for (const sj of scene.subjects) {
    const t = `${sj.ref} ${sj.pose} ${sj.action}`.toLowerCase();
    if (/sphinx|statue|pedestal/.test(sj.ref)) continue;
    const kind: Fig["kind"] = /eloi/.test(sj.ref) ? "eloi" : /mrs|woman|housekeeper|watchett|lady|girl/.test(sj.ref) ? "woman" : /traveller|traveler|man|narrator|doctor|host/.test(sj.ref) ? "man" : "generic";
    const rider = kind === "man" && hero.kind === "time_machine" && /traveller|traveler/.test(sj.ref) && !/walk|stand|step|stride/.test(t);
    const pose: Fig["pose"] = rider || /sit|seat|saddle|grip|lever|ride/.test(t) ? "seated" : /walk|cross|stride|rush|hurry|brisk/.test(t) ? "walking" : /crouch|kneel|bend|stoop/.test(t) ? "crouch" : "standing";
    const group = /observer|group|crowd|figures|people|folk/.test(sj.ref);
    const sx = slotX[sj.position] ?? 0;
    if (group) {
      for (let i = 0; i < 3; i++) figures.push({ ref: sj.ref, kind, pose: "standing", x: -3 + i * 3 + (r() - 0.5), z: -9 - r() * 3, yaw: (r() - 0.5) * 0.8, onMachine: false, walk: null, scale: kind === "eloi" ? 0.7 : 1 });
      continue;
    }
    const walk = pose === "walking" ? ([sx - 2.4, -1.4, sx + 2.4, -1.4] as [number, number, number, number]) : null;
    const pl = personLook(sj.ref, bible.characters.find((c) => c.id === sj.ref)?.desc ?? "", rng(hash(`${sj.ref}:look`)));
    figures.push({
      ref: sj.ref,
      kind: pl.body === "kid" && kind !== "eloi" ? "eloi" : kind === "generic" ? (pl.body === "woman" ? "woman" : "man") : kind,
      look: pl.look,
      pose,
      x: rider ? 0 : walk ? walk[0] : hero.kind === "time_machine" ? (sx > 0 ? 1.75 : -1.75) : sx,
      z: rider ? 0 : walk ? walk[1] : 0.3,
      yaw: walk ? Math.PI / 2 : 0,
      onMachine: rider,
      walk,
      scale: kind === "eloi" ? 0.7 : kind === "woman" ? 0.95 : 1,
    });
  }

  // ---- acting: each character's moves, with where they walk to resolved to metres
  for (const fg of figures) {
    const mine = (opts.acting ?? []).filter((a) => a.act.who === fg.ref && ACTS_KNOWN.includes(a.act.do));
    if (!mine.length) continue;
    fg.acts = mine.map(({ act, p0, p1 }) => {
      let tx: number | undefined;
      let tz: number | undefined;
      if (act.do === "walk_to" || act.do === "look_at" || act.do === "turn") {
        const to = (act.to ?? "").toLowerCase();
        const other = figures.find((o) => o !== fg && o.ref === act.to);
        if (other) { tx = other.x + (other.x < fg.x ? 0.9 : -0.9); tz = other.z; }
        else if (to === "left") { tx = fg.x - 2.4; tz = fg.z; }
        else if (to === "right") { tx = fg.x + 2.4; tz = fg.z; }
        else if (to === "center") { tx = 0; tz = 0.3; }
        else if (to === "back") { tx = fg.x; tz = fg.z - 3; }
        else if (to === "front") { tx = fg.x; tz = fg.z + 3; }
        else if (to === "machine") { tx = 1.1; tz = 0.9; }
      }
      return { p0, p1: Math.max(p1, p0 + 0.02), do: act.do, tx, tz };
    }).sort((a, b) => a.p0 - b.p0);
  }

  const place = (m: Model, x: number, z: number, targetH?: number, label = m.name) => {
    const s = targetH ? targetH / height(m) : 1;
    assets.push({ id: m.id, file: pkg.files.get(m.id) ?? mainFile(m.id), pos: [x, 0, z], rotY: r() * Math.PI * 2, scale: s, label });
  };

  const sizeOk = (maxH: number) => (m: Model) => height(m) <= maxH;

  if (kind === "exterior") {
    const wantTrees = /tree|birch|forest|wood|garden|hill|landscape|bush|rhododendron/.test(sceneText);
    const trees = wantTrees ? matchModel("tree", (m) => m.cats.includes("trees") && height(m) > 2.5) : null;
    const stump = matchModel("tree stump", (m) => /stump/.test(m.id));
    const rock = matchModel("boulder rock", (m) => m.cats.includes("rocks") && height(m) < 6);
    const bushes = /bush|rhododendron|shrub|hedge|garden/.test(sceneText) ? matchModel("bush shrub", (m) => m.cats.includes("plants") && height(m) < 3) : null;
    if (trees) for (let i = 0; i < 3; i++) place(trees, (i - 1) * 9 + (r() - 0.5) * 5, -9 - r() * 14, 7 + r() * 5, "tree");
    if (bushes) for (let i = 0; i < 5; i++) place(bushes, (r() - 0.5) * 14, -3 - r() * 6, 0.9 + r() * 0.8, "bush");
    if (rock) for (let i = 0; i < 2; i++) place(rock, (r() - 0.5) * 12, -2 - r() * 8, 0.8 + r() * 1.2, "rock");
    if (stump && r() > 0.4) place(stump, -2.4 + r(), 1.4 + r(), 0.6, "stump");
  } else {
    // a workshop: table at the back, shelf, lamp, clock, books as the props mention them
    const table = matchModel("table wood", (m) => /table/.test(m.id.toLowerCase()) && height(m) < 1.2);
    const shelf = matchModel("shelf", (m) => /shelf/.test(m.id.toLowerCase()));
    const lamp = matchModel("lamp workshop", (m) => /lamp/.test(m.id.toLowerCase()) && height(m) < 1.5);
    const clock = /clock/.test(sceneText) ? matchModel("clock", (m) => /clock/.test(m.id.toLowerCase())) : null;
    const books = matchModel("books", (m) => /book/.test(m.id.toLowerCase()));
    if (table) place(table, -2.0, -1.4, 0.9, "bench");
    if (shelf) place(shelf, 2.3, -2.3, 2.0, "shelf");
    if (lamp) place(lamp, -2.0, -1.4, undefined, "lamp");
    if (clock) place(clock, -1.6, -1.4, undefined, "clock");
    if (books) place(books, -2.4, -1.5, undefined, "books");
  }
  // anything named that we couldn't place (and isn't part of the hero) is reported, not invented
  const heroish = /machine|lever|quartz|dial|saddle|traveller|rod/;
  for (const p of scene.props) {
    if (heroish.test(p.toLowerCase())) continue;
    const pm = matchPkg(p, pkg.models);
    const bk = !pm && kind === "exterior" ? buildingKind(p) : undefined;
    if (bk && assets.length < 14 && !assets.some((a) => a.id === `bld:${bk[0]}`)) {
      // no model for it: the runtime builds it
      assets.push({ id: `bld:${bk[0]}`, file: "", pos: [(r() - 0.5) * 22, 0, -bk[3] - r() * 8], rotY: (r() - 0.5) * 1.2, scale: bk[2] * (0.9 + r() * 0.3), label: p });
      continue;
    }
    const m = pm ?? matchModel(p, sizeOk(30));
    if (m && !assets.some((a) => a.id === m.id) && assets.length < 14) place(m, (r() - 0.5) * 10, -2 - r() * 7, undefined, p);
    else if (!m && !/tree|bush|rock|hill|sky|building|tower|garden/.test(p.toLowerCase())) unresolved.push(p);
  }

  // explicit placement from a hand-made scene: exactly where the author put it
  for (const pl of scene.place ?? []) {
    const m = pkg.models.find((x) => x.id === `pkg:${pl.asset}`);
    if (!m) { unresolved.push(`place:${pl.asset}`); continue; }
    const h = pl.height ?? height(m);
    assets.push({ id: m.id, file: pkg.files.get(m.id)!, pos: [pl.x ?? 0, pl.y ?? 0, pl.z ?? 0], rotY: pl.rotY ?? 0, scale: h / height(m), label: pl.asset });
  }

  // the place itself is a building (an inn, a church, a castle...) when the scene is outdoors at it and no prop already stands for it
  if (kind === "exterior" && !assets.some((a) => a.id.startsWith("bld:"))) {
    const bk = buildingKind(locText);
    if (bk) assets.push({ id: `bld:${bk[0]}`, file: "", pos: [(r() - 0.5) * 6 + 6, 0, -Math.max(9, bk[3] * 0.6)], rotY: -0.35 + (r() - 0.5) * 0.4, scale: bk[2] * 1.15, label: locText.slice(0, 24) });
  }

  // ---- ground / room
  const gid = grey || /storm|hail|rain/.test(scene.weather) ? "brown_mud_leaves_01" : "forrest_ground_01";
  const ground = kind === "exterior" ? { id: gid, tile: 2.5 } : null;
  // water: the sea, a lake, a shore. The land ends at a shoreline and the water runs on to the horizon.
  const wet = /\b(sea|seas|ocean|shore|shoreline|beach|waves?|tide|tides|surf|harbou?r|bay|lake|coast|swell|brine|strand|shoal|lagoon|estuary|river|water)\b/.test(sceneText + " " + (scene.weather ?? ""));
  const water: Resolved["water"] = kind === "exterior" && wet && !/\b(rain|raindrop)\b/.test(locText) ? {
    zEdge: /lake|river|harbou?r/.test(sceneText) ? -9 : -6,
    mood: /red (?:water|sea)|crimson|scarlet (?:sea|water)|blood/.test(sceneText) ? "red" : /oily|black water|dark water|slick|tar/.test(sceneText) ? "oily" : /storm|rough|gale|tempest|heavy/.test(sceneText + scene.weather) ? "storm" : "calm",
  } : null;
  const room = kind === "interior" ? { w: 8, d: 6, h: 3.4, floor: "wood_floor", wall: "wood_floor" } : null;

  // ---- camera: frame the hero (~1.8 m) by framing and move
  const heroH = hero.sphinx ? 5 : 1.9;
  const fov = scene.camera.framing === "close" ? 32 : scene.camera.framing === "wide" ? 52 : 40;
  const fill = scene.camera.framing === "close" ? 0.55 : scene.camera.framing === "wide" ? 0.22 : 0.34;
  // a person standing beside the machine widens the shot
  const beside = figures.some((g) => !g.onMachine && !g.walk) && hero.kind === "time_machine";
  const dist = Math.min(kind === "interior" ? (beside ? 5.6 : 4.4) : 40, (heroH * (beside ? 1.4 : 1)) / (2 * Math.tan((fov * Math.PI) / 360) * fill));
  const eye = 1.35 + (scene.camera.framing === "wide" ? 0.5 : 0);
  const az0 = -0.35 + (r() - 0.5) * 0.3;
  const move = scene.camera.motion;
  const arc = move === "orbit" ? 0.7 : move === "drift" ? 0.25 : 0.08;
  const push = move === "push" ? 0.75 : move === "pull" ? 1.3 : 1;
  const pos = (az: number, d: number): [number, number, number] => [Math.sin(az) * d, eye, Math.cos(az) * d];
  const lookY = heroH * 0.5;
  const lookX = beside ? (figures.find((g) => !g.onMachine && !g.walk)?.x ?? 0) * 0.45 : 0;

  // ---- directed shots: each becomes a camera rig. Framing sets lens and distance, angle sets height, focus sets the target.
  const FRAMING = { wide: { fov: 52, frame: Math.max(3.2, heroH * 1.7), fstop: 5.6 }, medium: { fov: 40, frame: 1.7, fstop: 3.2 }, close: { fov: 34, frame: 0.75, fstop: 2.4 }, extreme_close: { fov: 28, frame: 0.34, fstop: 1.8 } } as const;
  // what a focus word points at that the world can actually show (a person, the machine, a placed model); anything else is only atmosphere
  const knownFocus = (focus: string): boolean => {
    const f = focus.toLowerCase();
    if (f === "scene" || !f) return false;
    return figures.some((g) => g.ref.toLowerCase() === f || f.includes(g.ref.toLowerCase()) || g.ref.toLowerCase().includes(f)) || /lever|dial|machine|rod|quartz/.test(f) || assets.some((a) => f.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(f));
  };
  const focusPoint = (focus: string, framing: Shot["framing"]): [number, number, number] => {
    const f = focus.toLowerCase();
    const level = framing === "extreme_close" || framing === "close" ? 1.5 : framing === "medium" ? 1.15 : 0.95;
    const fig = figures.find((g) => g.ref.toLowerCase() === f || f.includes(g.ref.toLowerCase()) || g.ref.toLowerCase().includes(f));
    if (fig && f !== "scene") {
      const seatedLift = fig.pose === "seated" ? -0.1 : 0;
      // a wide shot of a person beside a building keeps both in frame: aim between them
      const bld = (framing as string) === "wide" ? assets.find((a) => a.id.startsWith("bld:")) : undefined;
      if (bld && !fig.onMachine) return [(fig.x + bld.pos[0]) / 2, (level + seatedLift) * fig.scale, (fig.z + bld.pos[2]) / 2];
      return [fig.onMachine ? 0 : fig.x, (level + seatedLift) * fig.scale, fig.onMachine ? 0.02 : fig.z];
    }
    if (/lever|dial|machine|rod|quartz/.test(f)) return [/lever/.test(f) ? 0.12 : 0, /lever/.test(f) ? 0.75 : 0.85, 0.35];
    const asset = assets.find((a) => f.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(f));
    if (asset && f !== "scene") {
      // a wide shot of a thing with people about keeps the nearest person in frame too: aim between them
      const who = (framing as string) === "wide" ? figures.filter((g) => !g.onMachine).sort((a, b) => Math.hypot(a.x - asset.pos[0], a.z - asset.pos[2]) - Math.hypot(b.x - asset.pos[0], b.z - asset.pos[2]))[0] : undefined;
      if (who) return [(who.x + asset.pos[0]) / 2, Math.max(0.6, level * 0.6), (who.z + asset.pos[2]) / 2];
      return [asset.pos[0], Math.max(0.4, level * 0.6), asset.pos[2]];
    }
    return [lookX, heroH * 0.5, 0];
  };
  const rigShot = (sh: Shot, p0: number, p1: number, i: number): CamShot => {
    // never close in on something the world cannot show (a sea swell, a mood): step back to a medium shot of the scene
    let framing: Shot["framing"] = sh.framing;
    if (!knownFocus(sh.focus) && (framing === "close" || framing === "extreme_close")) framing = "medium";
    // and a lens held a few hand-spans from a thing shows only a blur: keep a readable distance
    const fr0 = FRAMING[framing] ?? FRAMING.medium;
    const fr = framing === "extreme_close" ? { ...fr0, frame: 0.7 } : framing === "close" ? { ...fr0, frame: 1.05 } : fr0;
    const tgt = focusPoint(sh.focus, sh.framing);
    const d0 = Math.min(kind === "interior" ? 5.2 : 45, fr.frame / (2 * Math.tan((fr.fov * Math.PI) / 360)));
    // alternate the side the camera sits on, so a cut changes the view instead of repeating it
    const az = az0 + (i % 2 === 0 ? -0.3 : 0.55) + (sh.angle === "over_shoulder" ? 0.7 : 0);
    const camY = sh.angle === "low" ? 0.5 : sh.angle === "high" ? Math.max(2.4, tgt[1] + 1.4) : sh.angle === "over_shoulder" ? tgt[1] + 0.15 : Math.max(0.9, Math.min(1.7, tgt[1] + 0.1));
    const push = sh.move === "push" ? [1.14, 0.9] : sh.move === "pull" ? [0.88, 1.12] : [1, 1];
    const sweep = sh.move === "orbit" ? 0.5 : sh.move === "drift" ? 0.18 : 0.02;
    const place2 = (a: number, d: number): [number, number, number] => {
      const e = Math.asin(Math.max(-0.9, Math.min(0.9, (camY - tgt[1]) / d)));
      let p: [number, number, number] = [tgt[0] + Math.sin(a) * Math.cos(e) * d, tgt[1] + Math.sin(e) * d, tgt[2] + Math.cos(a) * Math.cos(e) * d];
      if (room) p = [Math.max(-room.w / 2 + 0.4, Math.min(room.w / 2 - 0.4, p[0])), Math.max(0.35, Math.min(room.h - 0.35, p[1])), Math.max(-room.d / 2 + 0.4, Math.min(room.d / 2 - 0.4, p[2]))];
      // a lens inside someone's shoulder shows the top of a head: back it off anyone it isn't looking at
      for (const g of figures) {
        if (g.onMachine || Math.hypot(g.x - tgt[0], g.z - tgt[2]) < 0.8) continue;
        const dx = p[0] - g.x, dz = p[2] - g.z, dd = Math.hypot(dx, dz);
        if (dd < 2.2) { const k = dd < 0.01 ? 0 : 2.2 / dd; p = [g.x + (dd < 0.01 ? 2.2 : dx * k), p[1], g.z + (dd < 0.01 ? 0 : dz * k)]; }
      }
      return p;
    };
    const panX = sh.move === "pan" ? 0.9 : 0;
    return {
      p0, p1,
      from: place2(az - sweep, d0 * push[0]),
      to: place2(az + sweep, d0 * push[1]),
      lookFrom: [tgt[0] - panX, tgt[1], tgt[2]],
      lookTo: [tgt[0] + panX, tgt[1], tgt[2]],
      fov: fr.fov,
      fstop: fr.fstop,
      into: sh.into,
    };
  };
  const camShots = opts.shots?.length ? opts.shots.map((x, i) => rigShot(x.shot, x.p0, x.p1, i)) : undefined;

  const beats = scene.beats.map((b) => {
    const a = b.action.toLowerCase();
    const kindOf = /lever|press|start|pull/.test(a) ? "lever" : /overturn|thrown|hurl|fell|fall|tumbl|cast/.test(a) ? "tumble" : /sun|day|night|sky|dark|light/.test(a) ? "time" : "other";
    return { t: Math.min(1, Math.max(0, (b.at - scene.from) / Math.max(1, nSent))), kind: kindOf };
  });

  const lights: Resolved["lights"] = [];
  if (hero.kind === "time_machine") lights.push({ pos: [0.5, 1.6, 0.9], color: "#9fe6ff", intensity: 40_000 });
  if (kind === "interior") lights.push({ pos: [-1.9, 1.7, -1.1], color: "#ffb766", intensity: 160_000 });
  if (t0 === "night" || t1 === "night") lights.push({ pos: [1.4, 0.9, 1.0], color: "#ffb060", intensity: 60_000 });

  // ---- stage cues: what the text makes the world do, resolved to sky positions and placed models
  const PHASE: Record<string, number> = { new: 0, dark: 0, crescent: 0.2, quarter: 0.5, half: 0.5, gibbous: 0.78, full: 1 };
  const phaseOf = (w: string | undefined, d: number) => (w && PHASE[w.trim().toLowerCase()] !== undefined ? PHASE[w.trim().toLowerCase()] : d);
  const camFrom = pos(az0, dist * 1.05);
  const fwdAz = Math.atan2(lookX - camFrom[0], -(0 - camFrom[2])); // the way the default camera faces, as an azimuth
  const stage: StageR[] = [];
  (opts.stage ?? []).forEach(({ cue, p0, p1 }, ci) => {
    const sr = rng(hash(`${scene.id}:stage:${ci}:${cue.k}`));
    const how = (cue.how ?? "").toLowerCase();
    const base: StageR = { k: cue.k, p0, p1: Math.max(p1, p0 + 0.05), how, // at least a few seconds on screen, whatever the model's span
      amount: cue.amount ?? 0.6 };
    if (cue.k === "moon") {
      const [a, b] = how.split(/>|→|-| to /).map((x) => x.trim());
      stage.push({ ...base, az: fwdAz + 0.5, el: 34, ph: [phaseOf(a, 0), phaseOf(b ?? a, b === undefined ? phaseOf(a, 1) : 1)] });
    } else if (cue.k === "sun") {
      stage.push({ ...base, az: fwdAz - (/red|halt|huge|giant|set|dying|low/.test(how) ? 0.25 : 0.9), el: /red|halt|huge|giant|set|dying|low/.test(how) ? 9 : 8 });
    } else if (cue.k === "grow" && kind !== "interior") {
      const w = (cue.what ?? "tree").toLowerCase();
      const isTower = /build|tower|house|spire|column|castle|palace|city|skyscraper|hall/.test(w);
      const n = Math.max(4, Math.min(18, Math.round(5 + (cue.amount ?? 0.6) * 12)));
      const place = () => {
        // a ring around the scene's centre, outside where the pulled-back camera sits (about 12 m from the subject, plus a crane)
        const ang = sr() * Math.PI * 2;
        const rad = 16 + sr() * 20;
        return { pos: [lookX + Math.sin(ang) * rad, 0, Math.cos(ang) * rad] as [number, number, number], rotY: sr() * 6.28, d: sr() * 0.4 };
      };
      let items: NonNullable<StageR["items"]>;
      if (isTower) {
        // no building in the catalog: towers are built in the runtime (a stack of glassy boxes with lit windows)
        items = Array.from({ length: n }, () => ({ id: "tower", file: "", ...place(), scale: 1, tower: { h: 10 + sr() * 18, w: 3 + sr() * 3.5 } }));
      } else {
        const ok = (m: Model) => !/dead|trunk|stump|log|rock|boulder/.test(m.id) && height(m) > 0.6;
        // green growth of any kind is plants, never a fuzzy match to some object (a red buoy once stood in for "vegetation")
        const plantish = /veget|plant|moss|lichen|alga|slime|grass|green|weed|fern|shrub|bush|flower|growth/.test(w);
        const okPlant = (m: Model) => ok(m) && /plant|bush|fern|shrub|grass|flower|leaf|moss|clover|weed|nettle|bloom|bramble|ivy/.test(m.id);
        const m = plantish ? matchModel(w, okPlant) ?? matchModel("plant", okPlant) ?? matchModel("tree", ok) : matchModel(w, ok) ?? matchModel("tree", ok);
        if (!m) return;
        const target = /tree|pine|oak|palm|forest|birch|sapling/.test(w) ? 9 : /flower|plant|bush|fern|shrub|grass|weed/.test(w) ? 1.1 : 4;
        items = Array.from({ length: n }, () => ({ id: m.id, file: mainFile(m.id), ...place(), scale: Math.min(4, (target * (0.7 + sr() * 0.6)) / height(m)) }));
      }
      stage.push({ ...base, items });
    } else if (cue.k === "creature") {
      const w = (cue.what ?? "crab").toLowerCase();
      const type = /butterfly|moth|bat|flutter|wing/.test(w) ? "butterfly" : /bird|gull|eagle|crow|raven|hawk|pterodactyl|swallow/.test(w) ? "bird" : "crab";
      // a path across the ground in front of the default camera, left to right or right to left
      const dir = sr() < 0.5 ? -1 : 1;
      stage.push({ ...base, what: type, az: fwdAz + dir * 0.0, items: [{ id: type, file: "", pos: [lookX + dir * -9, 0, 2.2 + sr() * 1.6], rotY: dir > 0 ? Math.PI / 2 : -Math.PI / 2, scale: 1, d: 0 }] });
    } else if (cue.k === "dim") {
      stage.push({ ...base, az: fwdAz + 0.3, el: 38 });
    } else if (cue.k !== "grow") {
      stage.push(base);
    }
  });

  return {
    id: scene.id,
    frames,
    fps: 30,
    size: opts.size ?? [720, 900],
    interior: kind === "interior",
    sky: { night: skyPool.night, dawn: skyPool.dawn, day: skyPool.day, dusk: skyPool.dusk, intensity: grey ? 0.9 : t0 === "night" ? 0.7 : 0.6, rotation: (hash(scene.id) % 628) / 100 },
    sun: { startElev: SUN_ELEV[t0] ?? 30, endElev: SUN_ELEV[t1] ?? 30, cycles, azimuth: -0.8 + r() * 1.6, color: SUN_COLOR[t0] ?? "#ffe9c9", strength: grey ? 0.35 : 1 },
    ground,
    water,
    room,
    fog: { color: grey ? "#8f98a3" : (FOG[t0] ?? "#c6d4e6"), density: grey ? 0.03 : kind === "interior" ? 0 : 0.012 },
    assets,
    hero,
    figures,
    textures: [...(hero.kind === "time_machine" ? ["marble_01", "brown_leather"] : []), ...(figures.length ? ["poly_wool_herringbone"] : [])],
    lights,
    camera: { from: pos(az0, dist * 1.05), to: pos(az0 + arc, dist * push), lookFrom: [lookX, lookY, 0], lookTo: [lookX, lookY, 0], fov, focus: dist, fstop: scene.camera.framing === "wide" ? 4.5 : 2.4 },
    beats,
    shots: camShots,
    stage: stage.length ? stage : undefined,
    style: opts.style && opts.style !== "cinematic" ? opts.style : undefined,
    exposure: t0 === "night" ? 0.4 : -0.1,
    weather: scene.weather,
    unresolved,
  };
}

/** Assets one resolved scene needs, in the shape the renderer's fetcher takes. */
export function assetsNeeded(r: Resolved): { kind: string; id: string; res: string }[] {
  const out = new Map<string, { kind: string; id: string; res: string }>();
  const add = (kind: string, id: string, res: string) => out.set(`${kind}:${id}`, { kind, id, res });
  for (const s of [r.sky.night, r.sky.dawn, r.sky.day, r.sky.dusk]) add("hdri", s.id, "1k");
  for (const a of r.assets) if (!a.id.startsWith("pkg:") && !a.id.startsWith("bld:")) add("model", a.id, "1k"); // bundled models are already on disk; buildings are built in the runtime
  for (const c of r.stage ?? []) for (const it of c.items ?? []) if (it.file && !it.tower) add("model", it.id, "1k"); // towers and creatures are built in the runtime
  if (r.ground) add("texture", r.ground.id, "1k");
  if (r.room) add("texture", r.room.floor, "1k");
  for (const t of r.textures) add("texture", t, "1k");
  return [...out.values()];
}

/** Bump when runtime/scene.tsx changes in a way that alters frames, so cached renders are redone. */
export const RUNTIME_VERSION = "rt63";

/** Cache key: changes whenever the resolved plan or the runtime does. */
export function sceneKey(r: Resolved): string {
  return `${RUNTIME_VERSION}-${r.id}-${hash(RUNTIME_VERSION + JSON.stringify(r)).toString(36)}`;
}
