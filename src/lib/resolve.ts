// Resolver: LLM scene JSON -> concrete render plan (assets, sizes, positions, sky, light, camera).
// Pure and deterministic (seeded by the scene). The LLM selects and directs; this places and sizes in metres.
// Poly Haven dims are Blender axes in metres: [x, y, depth, height = dims[2]].

import catalog from "../catalog/polyhaven.json" with { type: "json" };
import beasts from "../catalog/creatures.json" with { type: "json" };
import type { PackageAsset } from "./book";
import type { Act, Bible, Cue, Scene, Shot } from "./scene";
import { furniture, type FurnKind } from "./furniture";
import { rigFor, type Rig } from "./rigs";
import type { Outfit, OutfitItem } from "./outfits";

type Model = { id: string; name: string; tags: string[]; cats: string[]; dims: number[]; poly: number };
type Tagged = { id: string; name: string; tags: string[]; cats: string[] };
const MODELS = catalog.models as Model[];
const HDRIS = catalog.hdris as Tagged[];
const TEXTURES = (catalog as any).textures as Tagged[];

export type Placed = { id: string; file: string; pos: [number, number, number]; rotY: number; scale: number; label: string; parts?: import("./props").Part[] };
type SkyRef = { id: string; file: string };
export type Creature = { /** a real low-poly model of it (src/catalog/creatures.json), else it is built from the book's words */ model?: string; species: string; cls: "quad" | "bird" | "snake"; size: number; body: string; belly: string; dark: string; ears: "long" | "round" | "point" | "floppy" | "none"; tail: "puff" | "long" | "bushy" | "short" | "none"; snout: "short" | "long" | "beak" | "flat"; dress?: string; legs: number };
export type Fig = {
  ref: string;
  kind: "man" | "woman" | "eloi" | "generic" | "creature";
  /** an animal, built from what the book says it is (species, colours, ears, tail, what it wears) */
  creature?: Creature;
  /** how it is built and moves: written by the model for the book, or the built-in guess from its species */
  rig?: Rig;
  pose: "seated" | "standing" | "walking" | "crouch";
  x: number;
  z: number;
  yaw: number;
  onMachine: boolean;
  walk: [number, number, number, number] | null; // x0, z0, x1, z1 over the scene
  scale: number;
  /** what they wear and look like, from the book's own description of them */
  look?: { coat: string; vest: string; trou: string; boot: string; hair: string; skin: string; old: boolean; beard?: boolean; robe?: boolean; headcloth?: string; /** written by the model: a skirt or gown, and what is worn or carried */ custom?: boolean; skirt?: { len: number; flare: number; c: string }; items?: OutfitItem[] };
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
  /** creature: the drawn type (crab, butterfly, bird, beast) and the text's own word for it */
  kind?: string;
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
  room: RoomR | null;
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
const ACTS_KNOWN = ["walk_to", "sit", "stand", "reach", "use_lever", "look_at", "turn", "gesture", "crouch", "wave", "point", "drink", "sing", "cheer", "slam", "clap", "shrug", "nod", "bow", "cover_face", "draw", "shake_fist", "beckon", "think", "laugh", "plead"];
/** What a described action looks like when played: the first that matches (specific before general). */
const ACTION_WORDS: [string, RegExp][] = [
  ["sing", /\b(sing|sings|sang|singing|song|songs|chant|chants|chorus|hum|hums|shanty|pipe up|pipes up|bursts? into)\b/],
  ["drink", /\b(drink|drinks|drank|drinking|swig|swigs|quaff|quaffs|gulp|gulps|sip|sips|toast|rum|ale|grog)\b/],
  ["draw", /\b(draw|draws|drew|unsheath\w*|brandish\w*|clasp-knife|knife|sword|cutlass|pistol|aims?|levels?)\b/],
  ["slam", /\b(slap|slaps|slapped|slam|slams|slammed|bang|bangs|thump|thumps|pound|pounds|rap|raps|knock|knocks)\b/],
  ["shake_fist", /\b(threaten\w*|menac\w*|fist|snarl\w*|rage|rages|fury|furious|angry|curse|curses|oath|swears?|growl\w*)\b/],
  ["cheer", /\b(cheer\w*|shout\w*|roar\w*|hurrah|huzza\w*|exult\w*|triumph\w*|celebrat\w*|yell\w*)\b/],
  ["clap", /\b(clap|claps|clapped|applaud\w*)\b/],
  ["laugh", /\b(laugh\w*|chuckl\w*|guffaw\w*|giggl\w*)\b/],
  ["cover_face", /\b(weep\w*|sob\w*|cries|cry|cover\w* (his|her) (face|eyes)|hide\w* (his|her) face|terrified|frighten\w*)\b/],
  ["plead", /\b(plead\w*|beg|begs|begged|implor\w*|entreat\w*)\b/],
  ["point", /\b(point|points|pointed|pointing|indicat\w*)\b/],
  ["beckon", /\b(beckon\w*|summon\w*|motion\w* (him|her|them))\b/],
  ["shrug", /\b(shrug\w*)\b/],
  ["nod", /\b(nod|nods|nodded|agree\w*)\b/],
  ["bow", /\b(bow|bows|bowed|curtsy|curtsies|salut\w*)\b/],
  ["think", /\b(think|thinks|ponder\w*|muse|muses|wonder\w*|consider\w*)\b/],
  ["wave", /\b(wave|waves|waved|waving|farewell|greet\w*)\b/],
];
export const actionFor = (text: string): string | null => ACTION_WORDS.find(([, re]) => re.test(text.toLowerCase()))?.[0] ?? null;

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

const SPECIES: [RegExp, Omit<Creature, "body" | "belly" | "dark" | "dress">, string][] = [
  // [words, build, usual colour]
  [/\b(snake|snakes|serpent|serpents|viper|adder|cobra|asp|python)\b/, { species: "snake", cls: "snake", size: 1, ears: "none", tail: "none", snout: "short", legs: 0 }, "#6a7a3a"],
  [/\b(rabbit|rabbits|bunny|bunnies|hare)\b/, { species: "rabbit", cls: "quad", size: 0.4, ears: "long", tail: "puff", snout: "short", legs: 4 }, "#8a6a4a"],
  [/\b(cat|kitten|kitty|tabby)\b/, { species: "cat", cls: "quad", size: 0.45, ears: "point", tail: "long", snout: "short", legs: 4 }, "#7a6a5a"],
  [/\b(dog|puppy|hound|pup|spaniel|terrier)\b/, { species: "dog", cls: "quad", size: 0.7, ears: "floppy", tail: "long", snout: "long", legs: 4 }, "#8a6a40"],
  [/\b(fox|vixen)\b/, { species: "fox", cls: "quad", size: 0.6, ears: "point", tail: "bushy", snout: "long", legs: 4 }, "#b4592a"],
  [/\b(wolf|wolves|jackal|coyote)\b/, { species: "wolf", cls: "quad", size: 0.95, ears: "point", tail: "bushy", snout: "long", legs: 4 }, "#6a6a70"],
  [/\b(bear|bears|cub)\b/, { species: "bear", cls: "quad", size: 1.4, ears: "round", tail: "short", snout: "long", legs: 4 }, "#5a4130"],
  [/\b(mouse|mice|rat|rats)\b/, { species: "mouse", cls: "quad", size: 0.16, ears: "round", tail: "long", snout: "long", legs: 4 }, "#8a8279"],
  [/\b(squirrel|chipmunk)\b/, { species: "squirrel", cls: "quad", size: 0.3, ears: "point", tail: "bushy", snout: "short", legs: 4 }, "#8a5a38"],
  [/\b(hedgehog)\b/, { species: "hedgehog", cls: "quad", size: 0.22, ears: "round", tail: "none", snout: "long", legs: 4 }, "#6a5a48"],
  [/\b(pig|pigs|piglet|hog|sow|boar)\b/, { species: "pig", cls: "quad", size: 0.85, ears: "floppy", tail: "short", snout: "flat", legs: 4 }, "#e8b0a8"],
  [/\b(sheep|lamb|lambs|ram|ewe)\b/, { species: "sheep", cls: "quad", size: 0.9, ears: "floppy", tail: "short", snout: "short", legs: 4 }, "#ece6d8"],
  [/\b(goat|kid goat|billy)\b/, { species: "goat", cls: "quad", size: 0.85, ears: "point", tail: "short", snout: "short", legs: 4 }, "#cfc8b8"],
  [/\b(cow|cows|calf|calves|bull|ox|oxen|cattle|kine|heifer)\b/, { species: "cow", cls: "quad", size: 1.5, ears: "point", tail: "long", snout: "flat", legs: 4 }, "#e8e0d0"],
  [/\b(horse|horses|pony|mare|stallion|colt|steed|mule|donkey|ass)\b/, { species: "horse", cls: "quad", size: 1.65, ears: "point", tail: "long", snout: "long", legs: 4 }, "#6a4a30"],
  [/\b(deer|stag|doe|fawn|elk|reindeer)\b/, { species: "deer", cls: "quad", size: 1.2, ears: "point", tail: "short", snout: "long", legs: 4 }, "#9a6a40"],
  [/\b(lion|lioness|tiger|leopard|panther)\b/, { species: "lion", cls: "quad", size: 1.1, ears: "round", tail: "long", snout: "short", legs: 4 }, "#c49a4a"],
  [/\b(whale|whales|dolphin|porpoise|leviathan)\b/, { species: "whale", cls: "quad", size: 1.5, ears: "none", tail: "short", snout: "short", legs: 4 }, "#8a96a6"],
  [/\b(fish|fishes|salmon|trout|pike|carp|minnow|goldfish)\b/, { species: "fish", cls: "quad", size: 0.3, ears: "none", tail: "short", snout: "short", legs: 4 }, "#7a9ab0"],
  [/\b(piranha|piranhas|shark|sharks)\b/, { species: "piranha", cls: "quad", size: 0.4, ears: "none", tail: "short", snout: "short", legs: 4 }, "#6a7a8a"],
  [/\b(dragon|dragons|wyrm|drake)\b/, { species: "dragon", cls: "quad", size: 2.2, ears: "point", tail: "long", snout: "long", legs: 4 }, "#6a8a4a"],
  [/\b(bat|bats)\b/, { species: "bat", cls: "bird", size: 0.3, ears: "point", tail: "short", snout: "short", legs: 2 }, "#3a3238"],
  [/\b(eagle|eagles|hawk|hawks|falcon|vulture|condor|albatross)\b/, { species: "eagle", cls: "bird", size: 0.7, ears: "none", tail: "short", snout: "beak", legs: 2 }, "#6a5a48"],
  [/\b(zebra|zebras)\b/, { species: "zebra", cls: "quad", size: 1.7, ears: "point", tail: "long", snout: "long", legs: 4 }, "#e8e8e8"],
  [/\b(llama|llamas|alpaca|alpacas|camel|camels|dromedary)\b/, { species: "llama", cls: "quad", size: 1.7, ears: "point", tail: "short", snout: "long", legs: 4 }, "#b8956a"],
  [/\b(pug|pugs)\b/, { species: "pug", cls: "quad", size: 0.4, ears: "floppy", tail: "short", snout: "flat", legs: 4 }, "#d8c090"],
  [/\b(skeleton|skeletons)\b/, { species: "skeleton", cls: "quad", size: 1.8, ears: "none", tail: "none", snout: "short", legs: 2 }, "#e8e4d0"],
  [/\b(slime|slimes|blob|jelly|ooze)\b/, { species: "slime", cls: "quad", size: 0.5, ears: "none", tail: "none", snout: "short", legs: 4 }, "#5ac85a"],
  [/\b(badger|badgers)\b/, { species: "badger", cls: "quad", size: 0.65, ears: "round", tail: "short", snout: "long", legs: 4 }, "#6a6a6e"],
  [/\b(mole|moles)\b/, { species: "mole", cls: "quad", size: 0.3, ears: "none", tail: "short", snout: "long", legs: 4 }, "#3a3430"],
  [/\b(otter|otters|weasel|weasels|stoat|stoats|ferret|ferrets|polecat)\b/, { species: "otter", cls: "quad", size: 0.5, ears: "round", tail: "long", snout: "short", legs: 4 }, "#6a4a30"],
  [/\b(owl|owls)\b/, { species: "owl", cls: "bird", size: 0.35, ears: "none", tail: "short", snout: "beak", legs: 2 }, "#8a7a62"],
  [/\b(monkey|monkeys|ape|apes|gorilla|baboon)\b/, { species: "monkey", cls: "quad", size: 0.7, ears: "round", tail: "long", snout: "short", legs: 4 }, "#7a5a3a"],
  [/\b(elephant|elephants)\b/, { species: "elephant", cls: "quad", size: 2.2, ears: "floppy", tail: "short", snout: "long", legs: 4 }, "#8a8a90"],
  [/\b(camel|camels)\b/, { species: "camel", cls: "quad", size: 1.7, ears: "round", tail: "short", snout: "long", legs: 4 }, "#b8955a"],
  [/\b(frog|toad)\b/, { species: "frog", cls: "quad", size: 0.18, ears: "none", tail: "none", snout: "flat", legs: 4 }, "#5a8a3a"],
  [/\b(duck|ducks|duckling|goose|geese|gosling|swan|hen|hens|chicken|chick|rooster|cock|turkey)\b/, { species: "duck", cls: "bird", size: 0.4, ears: "none", tail: "short", snout: "beak", legs: 2 }, "#e8e0c0"],
  [/\b(crow|crows|raven|ravens|rook|rooks|blackbird|blackbirds|starling|jackdaw|cormorant)\b/, { species: "bird", cls: "bird", size: 0.3, ears: "none", tail: "long", snout: "beak", legs: 2 }, "#26262d"],
  [/\b(dove|doves|pigeon|pigeons|gull|gulls|seagull|seagulls|albatross)\b/, { species: "bird", cls: "bird", size: 0.3, ears: "none", tail: "long", snout: "beak", legs: 2 }, "#e9e6df"],
  [/\b(robin|robins|cardinal)\b/, { species: "bird", cls: "bird", size: 0.22, ears: "none", tail: "long", snout: "beak", legs: 2 }, "#b5442f"],
  [/\b(bird|birds|robin|sparrow|crow|raven|owl|eagle|hawk|dove|pigeon|parrot|nightingale|lark|swallow|finch|wren|magpie|gull|seagull|albatross)\b/, { species: "bird", cls: "bird", size: 0.25, ears: "none", tail: "long", snout: "beak", legs: 2 }, "#7a6a58"],
];
/** which real model stands for which species (the rest are built from the book's words) */
const MODEL_OF: Record<string, string> = { cow: "cow", horse: "horse", pig: "pig", sheep: "sheep", dog: "dog", pug: "pug", cat: "cat", wolf: "wolf", fox: "red-fox", whale: "whale", fish: "fish", piranha: "piranha", dragon: "dragon", bat: "bat", eagle: "eagle", zebra: "zebra", llama: "llama", skeleton: "skeleton", slime: "slime" };
const BIRD_TONES: [string, string][] = [["bird", "#4f86c2"], ["bird-brown", "#7a5a3c"], ["bird-dark", "#26262d"], ["bird-white", "#e9e6df"], ["bird-red", "#b5442f"], ["bird-yellow", "#d9b43a"], ["bird-grey", "#7d8088"]];
/** The bird model whose colour is closest to this one. */
function nearestBird(hex: string): string {
  const c = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = c(hex);
  let best = "bird", bd = 1e9;
  for (const [n, h] of BIRD_TONES) { const b = c(h); const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; if (d < bd) { bd = d; best = n; } }
  return (beasts as any)[best] ? best : "bird";
}
/** a smaller or larger one of the same model (a pony, a lamb, a calf) */
const SIZE_OF = (t: string) => (/\b(pony|foal|colt|donkey|mule|ass)\b/.test(t) ? 0.72 : /\b(lamb|lambs|calf|piglet|puppy|pup|kitten|cub)\b/.test(t) ? 0.6 : /\b(huge|giant|great|enormous|vast)\b/.test(t) ? 1.4 : /\b(little|small|tiny|young|baby)\b/.test(t) ? 0.75 : 1);
const NOT_ANIMAL = /\b(man|woman|boy|girl|mr|mrs|miss|king|queen|lord|lady|sir|captain|doctor|professor|child|children)\b/;
/** An animal character (from its id and the book's description of it), or null when it is a person. Species gives the build; the words give the colours and clothes. */
export function creatureLook(ref: string, desc: string, rnd: () => number): Creature | null {
  const t = `${ref.replace(/_/g, " ")} ${desc}`.toLowerCase();
  let hit = SPECIES.find(([re]) => re.test(ref.replace(/_/g, " ").toLowerCase())) ?? SPECIES.find(([re]) => re.test(t));
  // "the beast of the field": no species named, so one of the real four-legged models (the same one every time for the same words)
  if (!hit && /\b(beasts?|animals?)\b/.test(ref.replace(/_/g, " ").toLowerCase())) { const pick = ["horse", "wolf", "zebra", "llama", "cow", "sheep"][hashStr(ref) % 6]; hit = SPECIES.find(([, c]) => c.species === pick); }
  if (!hit) return null;
  // "a doctor's horse" is a person with a horse near: only an animal when the id itself is the animal, or the description starts with one
  const idWords = ref.replace(/_/g, " ").toLowerCase();
  if (!hit[0].test(idWords) && NOT_ANIMAL.test(idWords)) return null;
  const word = (re: RegExp): string | null => { const m = re.exec(t); if (!m) return null; const near = t.slice(Math.max(0, m.index - 22), m.index + 22); for (const [c, hex] of COLOURS) if (c.test(near)) return hex; return null; };
  const body = word(hit[0]) ?? word(/\b(fur|coat|feathers|plumage|wool|fleece|hide)\b/) ?? hit[2];
  const light = /\b(white|cream)\b/.test(t) && !/\bwhite (?:tail|belly|chest|paws)\b/.test(t);
  const dress = word(/\b(jacket|coat|dress|apron|waistcoat|cloak|shawl|bonnet|vest|frock|shirt|scarf)\b/);
  const wears = /\b(jacket|dress|apron|waistcoat|cloak|shawl|bonnet|vest|frock|shirt|scarf|clothes)\b/.test(t);
  const size = hit[1].size * (/\b(little|small|tiny|young|baby|cub|kitten|puppy|chick|lamb|calf|foal)\b/.test(t) ? 0.8 : /\b(big|large|huge|great|giant|old)\b/.test(t) ? 1.15 : 1);
  const model = MODEL_OF[hit[1].species] && (beasts as any)[MODEL_OF[hit[1].species]] ? MODEL_OF[hit[1].species] : undefined;
  return { ...hit[1], ...(model ? { model, size: size * SIZE_OF(t) } : {}), size: model ? size * SIZE_OF(t) : size, body, belly: light ? "#f2eee4" : mixHexC(body, "#f2eee4", 0.55), dark: mixHexC(body, "#1a1612", 0.55), dress: wears ? dress ?? ["#3f5f9a", "#9a3f45", "#4a7a58", "#b08a3a"][Math.floor(rnd() * 4)] : undefined };
}

/** Is this phrase an animal or other living thing (so it is drawn as a creature, never built as a prop)? */
export const isLiving = (what: string): boolean => !!creatureLook(what, "", () => 0.5) || /\b(\w*fish|\w*fishes|crabs?|eels?|dab|plaice|skate|dace|pickerel|pickereel|mackerel|shrimp|insects?|worms?|snails?|beetles?|spiders?|birds?|serpents?|dragons?|beasts?|animals?|creatures?|men|man|women|woman|people|children)\b/i.test(what);

/** A living thing no species word names (a dragon, an angel, a ghost): a plain four-legged build in the colours the words give, until the model has drawn it. */
function genericCreature(t: string): Creature {
  const low = t.toLowerCase().replace(/_/g, " ");
  let body = "#8a7a6a";
  for (const [c, hex] of COLOURS) if (c.test(low)) { body = hex; break; }
  return { species: "creature", cls: "quad", size: 0.8, ears: "point", tail: "long", snout: "short", legs: 4, body, belly: mixHexC(body, "#f2eee4", 0.45), dark: mixHexC(body, "#1a1612", 0.5) };
}
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
  // dress of the ancient world: a long robe to the ankle, a cloth over the head (shepherds, patriarchs, prophets, veiled women)
  const robe = /\b(robe|robes|robed|tunic|mantle|garment|garments|sackcloth|shepherd|prophet|patriarch|apostle|disciple|rabbi|pharaoh|psalmist|levite|nazarite|sandals|sandaled|biblical|ancient|toga|caftan|kaftan|djellaba|burnous)\b/.test(t) && !/\b(coat|jacket|waistcoat|trousers|uniform|suit|breeches)\b/.test(t);
  const veil = /\b(veil|veiled|headcloth|head-cloth|turban|headdress|keffiyeh|kaffiyeh|head covering|shawl over)\b/.test(t) || (robe && /\b(shepherd|patriarch|nomad|prophet)\b/.test(t));
  const hairWord = /(black|brown|blond|blonde|golden|flaxen|red|ginger|auburn|grey|gray|white|silver|dark)[- ]?(?:hair|haired|beard|bearded)/.exec(t)?.[1];
  const hairMap: Record<string, string> = { black: "#1f1b18", brown: "#4a3626", blond: "#c7a65a", blonde: "#c7a65a", golden: "#d6b45c", flaxen: "#d6b45c", red: "#8a3a22", ginger: "#a2481f", auburn: "#6e3320", grey: "#9a9a9a", gray: "#9a9a9a", white: "#e2e0da", silver: "#c4c4c4", dark: "#2a2220" };
  const hair = old && !hairWord ? "#b9b6b0" : hairMap[hairWord ?? ""] ?? pick(["#4a3626", "#2a2220", "#6a4a2e", "#8a6a3e", "#1f1b18"]);
  const skin = /\b(pale|fair|white-skinned)\b/.test(t) ? "#ecc9ad" : /\b(dark-skinned|black-skinned|dark skin|ebony)\b/.test(t) ? "#8a5a3c" : /\b(tanned|swarthy|olive|brown-skinned|sunburnt|weathered)\b/.test(t) ? "#c08e66" : pick(["#e8c39d", "#d7b08f", "#c99a73", "#e3bd9f", "#b98458", "#f0d2b3"]);
  return {
    body,
    look: { coat: cloth, vest: mixHexC(cloth, "#d8cba8", 0.45), trou: body === "woman" ? cloth : mixHexC(cloth, "#2a2a2e", 0.55), boot: "#2a211b", hair, skin, old, ...(robe ? { robe: true } : {}), ...(veil ? { headcloth: mixHexC(cloth, "#e8e0cc", 0.55) } : {}), ...(body === "man" && (/\b(beard|bearded|whisker|whiskers|unshaven|stubble|sailor|seaman|pirate|buccaneer|captain|bearded|sea-dog|patriarch|prophet|elder|hermit|wizard|moses|noah|abraham|isaac|jacob)\b/.test(t) || (old && rnd() < 0.4)) ? { beard: true } : {}) },
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
    if (s >= 4 && (!best || s > best.s)) best = { m, s };
  }
  return best?.m ?? null;
}

/** Words that name the setting, not a thing in it: they are drawn by the ground, sky, water and light, never matched to a model. */
const ENVIRONMENT = /^(seas?|waters?|oceans?|rivers?|lakes?|ponds?|streams?|tides?|waves?|lands?|grounds?|earths?|soils?|skies?|heavens?|firmaments?|stars?|suns?|moons?|clouds?|mists?|fogs?|darkness|dark|lights?|air|winds?|rain|snow|grass|fields?|meadows?|hills?|horizons?|voids?|deep|abyss|shores?|sands?|deserts?|plains?|valleys?|cosmos|universe|space|heaven|night|dawn|dusk|daylight|sunlight|moonlight|starlight|haze|smoke|dust|ash|ashes|fire|flames?|storms?|thunder|lightning)$/;
/** The thing a phrase names: its last word, after trailing place words (\"waters above\" is waters, \"sea chest\" is a chest). */
const headWord = (phrase: string): string => { const w = words(phrase.toLowerCase()); while (w.length > 1 && /^(above|below|beneath|beyond|over|under|upon|around|together|apart|everywhere|aloft|again|there|here)$/.test(w[w.length - 1])) w.pop(); return w[w.length - 1] ?? ""; };
const height = (m: Model) => m.dims[2] || 1;
const mainFile = (id: string) => {
  const m = MODELS.find((x) => x.id === id)!;
  void m;
  return `polyhaven/${id}/${id}_1k.gltf`;
};

function pickSky(time: string, weather: string, taken: Set<string>, words = ""): { id: string; file: string } {
  const wantWords = words.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !/^(with|from|that|this|over|into|dark|light|like|heavy|thick|thin)$/.test(w));
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
    if (wantWords.length) { const hw = `${h.id} ${h.name} ${h.tags.join(" ")} ${h.cats.join(" ")}`.toLowerCase(); for (const w of wantWords) if (hw.includes(w)) s += 3; } // the text's own words for the sky
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

/** An indoor place: its size, surfaces and what is in it, chosen from what the text says the place is. */
export type RoomR = {
  w: number; d: number; h: number; floor: string; wall: string;
  tile?: number; // metres per repeat of the floor picture
  wallC?: string; wain?: string | null; trim?: string; ceilC?: string; rug?: string | null;
  windows?: { x: number; w: number; h: number; y: number }[]; // on the back wall; x as a fraction of the width
  pictures?: boolean; door?: boolean; style?: string;
  firelit?: boolean; fixtures?: string[]; // lit by flame; what is built into it (beams, hearth, counter, columns, shelves, barrels)
};
export const ROOMS: [string, RegExp, Omit<RoomR, "wall"> & { wall?: string }][] = [
  ["cellar", /cellar|dungeon|crypt|vault|prison|cell\b|tomb|catacomb|cave|cavern|mine\b|tunnel|basement|sewer/, { w: 7, d: 6, h: 2.9, floor: "cobblestone_floor_01", tile: 1.4, wallC: "#58544d", wain: null, trim: "#3d3a35", ceilC: "#3a3732", rug: null, windows: [{ x: 0.3, w: 0.28, h: 0.2, y: 2.3 }], pictures: false, door: true }],
  ["church", /church|chapel|cathedral|temple|abbey|monaster|shrine|mosque|minster/, { w: 9, d: 12, h: 7, floor: "stone_tiles", tile: 1.8, wallC: "#bdb5a4", wain: null, trim: "#8e8573", ceilC: "#a79f8d", rug: "#6e1c26", windows: [-0.3, 0, 0.3].map((x) => ({ x, w: 0.5, h: 2.4, y: 3.6 })), pictures: false, door: true }],
  ["tavern", /\binn\b|tavern|alehouse|ale-house|taproom|tap-room|public house|\bpub\b|saloon|hostelry|coffee-?house/, { w: 9, d: 7, h: 2.7, floor: "dark_wooden_planks", tile: 1.6, wallC: "#8a7656", wain: "#3b2b1d", trim: "#2c2016", ceilC: "#4a3a2a", rug: null, windows: [{ x: -0.28, w: 0.4, h: 0.45, y: 1.6 }], pictures: false, door: true, firelit: true, fixtures: ["beams", "hearth"] }],
  ["hall", /\bhall\b|ballroom|palace|great hall|banquet|throne|gallery|mansion|castle|court\b|assembly rooms?|salon|corridor/, { w: 12, d: 9, h: 5, floor: "marble_tiles", tile: 2, wallC: "#d0c7b3", wain: "#9d9482", trim: "#e7dfcc", ceilC: "#d9d1bf", rug: "#7a1f2b", windows: [-0.3, 0, 0.3].map((x) => ({ x, w: 0.6, h: 1.7, y: 2.5 })), pictures: true, door: true }],
  ["study", /study|library|office|laborator|workshop|studio|chambers|counting|bookshop|club\b|smoking|den\b/, { w: 7, d: 5.5, h: 3.2, floor: "dark_wooden_planks", tile: 1.6, wallC: "#6f5a45", wain: "#3b2b1d", trim: "#2c2016", ceilC: "#5a4a3a", rug: "#2f4a3a", windows: [{ x: 0.2, w: 0.65, h: 0.95, y: 1.8 }], pictures: true, door: true, fixtures: ["hearth"] }],
  ["kitchen", /kitchen|cottage|farm|hut\b|cabin|barn|stable|hovel|scullery|pantry|dairy|bakery|mill\b/, { w: 6, d: 5, h: 2.8, floor: "plank_flooring_02", tile: 1.5, wallC: "#cdbf9f", wain: null, trim: "#6a5238", ceilC: "#b8a98a", rug: null, windows: [{ x: 0.22, w: 0.5, h: 0.7, y: 1.7 }], pictures: false, door: true, firelit: true, fixtures: ["hearth"] }],
  ["ship", /ship|boat|cabin of|galley|forecastle|steerage|hold\b|deck below|submarine|capsule|train|carriage|coach|compartment/, { w: 5.2, d: 4.2, h: 2.3, floor: "wood_planks_grey", tile: 1.2, wallC: "#8a6c4a", wain: "#5b4630", trim: "#3f3022", ceilC: "#6f5a40", rug: null, windows: [{ x: -0.2, w: 0.34, h: 0.4, y: 1.5 }, { x: 0.2, w: 0.34, h: 0.4, y: 1.5 }], pictures: false, door: true }],
  ["bedroom", /bedroom|bedchamber|nursery|attic|dormitor|boudoir|sleeping|garret/, { w: 6, d: 5, h: 3, floor: "wood_floor", tile: 1.6, wallC: "#c9b9a3", wain: "#9a846d", trim: "#efe6d6", ceilC: "#ddd2bf", rug: "#4d5f7a", windows: [{ x: 0.2, w: 0.6, h: 0.9, y: 1.75 }], pictures: true, door: true }],
  ["future", /future|palace of green|porcelain|laborator.*future|metal(?:lic)? (?:hall|room)|machine room|engine room|spaceship|station/, { w: 9, d: 7, h: 4.5, floor: "large_floor_tiles_02", tile: 2, wallC: "#c5d2cf", wain: null, trim: "#8fa7a4", ceilC: "#dfe8e5", rug: null, windows: [-0.28, 0.28].map((x) => ({ x, w: 0.7, h: 1.4, y: 2.4 })), pictures: false, door: true }],
  ["room", /./, { w: 8, d: 6, h: 3.4, floor: "wood_floor", tile: 1.6, wallC: "#bda98c", wain: "#5c4332", trim: "#4a3426", ceilC: "#a89a82", rug: "#6b2f2a", windows: [-0.24, 0.24].map((x) => ({ x, w: 0.72, h: 0.95, y: 1.75 })), pictures: true, door: true }],
];
export const ROOM_STYLES = ROOMS.map((r) => r[0]);
/** True when no recipe fits this text (or the judge's words), so a room has to be designed for it. */
export const needsDesign = (text: string, forced?: string): boolean => (forced ? !ROOM_STYLES.includes(forced) : roomFor(text).style === "room");
export function roomFor(text: string, forced?: string): RoomR {
  const t = text.toLowerCase().replace(/_/g, " ");
  const hit = (forced ? ROOMS.find((r) => r[0] === forced) : undefined) ?? ROOMS.find(([, re]) => re.test(t)) ?? ROOMS[ROOMS.length - 1];
  return { ...hit[2], wall: hit[2].floor, style: hit[0] } as RoomR;
}



/** The ground this place stands on, chosen from the words of the place (sand for a desert, snow, cobbles, grass, mud, rock) among the catalogue's textures. */
const TERRAIN: [RegExp, string[], number][] = [
  [/\b(desert|dune|dunes|sahara|arid|sandy|sand|beach|shore|dust|dusty|wadi|oasis|canaan|mesopotamia|egypt)\b/, ["sand", "desert", "dune"], 3],
  [/\b(snow|snowy|ice|icy|frozen|glacier|arctic|tundra|frost|winter)\b/, ["snow", "ice"], 3],
  [/\b(cobble|cobbled|cobblestone|street|streets|pavement|lane|alley|square|market|plaza)\b/, ["cobblestone", "cobble", "pavement"], 3],
  [/\b(road|highway|asphalt|tarmac|motorway)\b/, ["asphalt", "road"], 2],
  [/\b(grass|meadow|lawn|pasture|field|fields|garden|green|hill|hills|prairie|moor|heath)\b/, ["grass", "meadow"], 2],
  [/\b(mud|muddy|swamp|marsh|bog|fen|mire|quagmire)\b/, ["mud", "swamp"], 3],
  [/\b(rock|rocky|cliff|crag|mountain|mountains|stone|scree|quarry|cave)\b/, ["rock", "stone", "cliff"], 2],
  [/\b(gravel|path|track|trail|stony)\b/, ["gravel", "dirt"], 1],
  [/\b(forest|wood|woods|woodland|jungle|leaves|undergrowth|copse|grove)\b/, ["forest", "leaves", "ground"], 2],
  [/\b(farm|plough|ploughed|field of|crop|soil|earth|dirt)\b/, ["soil", "dirt", "ground"], 1],
];
function pickGround(text: string, fallback: string, seed: number): { id: string; tile: number } {
  const t = text.toLowerCase();
  const want: [string[], number][] = TERRAIN.filter(([re]) => re.test(t)).map(([, w, k]) => [w, k] as [string[], number]);
  if (!want.length) return { id: fallback, tile: 2.5 };
  let best: { id: string; s: number } | null = null;
  for (const x of TEXTURES) {
    if (!x.cats.some((c) => ["terrain", "floor", "ground", "outdoor", "natural", "road"].includes(c)) || x.cats.includes("indoor") || x.cats.includes("wall") || x.cats.includes("roofing") || x.cats.includes("wood")) continue;
    const words = `${x.id} ${x.name} ${x.tags.join(" ")} ${x.cats.join(" ")}`.toLowerCase();
    let sc = 0;
    for (const [ws, k] of want) for (const w of ws) if (words.includes(w)) sc += k * (x.id.includes(w) ? 2 : 1);
    if (x.cats.includes("aerial")) sc -= 6; // aerial photographs are too big and flat to walk on
    if (sc > 0 && (!best || sc > best.s || (sc === best.s && ((hashStr(x.id) ^ seed) & 1)))) best = { id: x.id, s: sc };
  }
  return { id: best?.id ?? fallback, tile: 2.5 };
}
const hashStr = (s: string) => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h; };

/** What furnishes each kind of room: real models at real sizes, set against the walls and round the tables (x across, z back to front; the back wall is at -d/2).
 *  h is the height the model is scaled to (a table 0.78 m, a chair 0.92 m), y the height it stands at (on a table), face the spot it turns toward. */
type Slot = { proc?: { kind: FurnKind; len?: number; wid?: number; h?: number }; ids: string[]; x: number; z: number; h?: number; y?: number; face?: [number, number]; label: string; rot?: number };
const FRONT = 0; // which way round the models' fronts are in their files (added to the turn that faces a spot)
function layoutFor(style: string, w: number, d: number): Slot[] {
  const zb = -d / 2, xr = w / 2, xl = -w / 2;
  const P = (kind: FurnKind, x: number, z: number, label: string, o: Partial<Slot> & { len?: number; wid?: number; h?: number } = {}): Slot => ({ ids: [], proc: { kind, len: o.len, wid: o.wid, h: o.h }, x, z, label, face: o.face, rot: o.rot, y: o.y });
  /** a table with a bench along each long side and a chair at each end (benches only when benches is false: chairs all round) */
  const setTable = (cx: number, cz: number, len: number, wid: number, o: { benches?: boolean; ends?: number } = {}): Slot[] => {
    const out: Slot[] = [P("table", cx, cz, "table", { len, wid })];
    if (o.benches !== false) for (const sz of [-1, 1]) out.push(P("bench", cx, cz + sz * (wid / 2 + 0.22), "bench", { len: len * 0.88 }));
    else for (const sz of [-1, 1]) for (const sx of [-0.28, 0.28]) out.push(P("chair", cx + sx * len, cz + sz * (wid / 2 + 0.3), "chair", { face: [cx + sx * len, cz] }));
    const ends = o.ends ?? 2;
    if (ends >= 1) out.push(P("chair", cx - len / 2 - 0.32, cz, "chair", { face: [cx, cz] }));
    if (ends >= 2) out.push(P("chair", cx + len / 2 + 0.32, cz, "chair", { face: [cx, cz] }));
    return out;
  };
  switch (style) {
    case "tavern": return [
      ...setTable(0.9, zb + 1.3, 2.0, 0.85),
      { ids: ["wooden_bowl_01"], x: 0.5, z: zb + 1.3, y: 0.76, label: "bowl" },
      { ids: ["metal_jug"], x: 1.3, z: zb + 1.2, y: 0.76, h: 0.24, label: "jug" },
      { ids: ["wooden_lantern_01"], x: 0.9, z: zb + 1.45, y: 0.76, h: 0.32, label: "lamp" },
      P("round", xr - 1.1, 2.0, "table", { wid: 0.95, h: 0.74 }),
      P("stool", xr - 1.85, 2.0, "stool", { h: 0.46 }), P("stool", xr - 0.35, 2.0, "stool", { h: 0.46 }), P("stool", xr - 1.1, 2.75, "stool", { h: 0.46 }),
      { ids: ["wooden_candlestick"], x: xr - 1.1, z: 2.0, y: 0.74, h: 0.22, label: "candle" },
      { ids: ["wine_barrel_01"], x: xr - 0.7, z: zb + 0.7, h: 0.9, label: "barrel" }, { ids: ["wine_barrel_01"], x: xr - 1.65, z: zb + 0.65, h: 0.9, label: "barrel" },
      { ids: ["wooden_crate_01"], x: xr - 0.6, z: zb + 1.6, h: 0.4, label: "crate", face: [0, 0] },
      { ids: ["wooden_bookshelf_worn"], x: -2.7, z: zb + 0.4, h: 1.9, face: [-2.7, 0], label: "shelf" },
      { ids: ["lantern_chandelier_01"], x: 0.9, z: zb + 1.3, y: -0.55, h: 0.88, label: "chandelier" },
    ];
    case "kitchen": return [
      ...setTable(0.7, zb + 1.7, 1.7, 0.85, { ends: 1 }),
      { ids: ["wooden_bowl_01"], x: 0.4, z: zb + 1.7, y: 0.76, label: "bowl" }, { ids: ["metal_jug"], x: 1.1, z: zb + 1.6, y: 0.76, h: 0.24, label: "jug" },
      { ids: ["painted_wooden_cabinet"], x: xl + 0.8, z: zb + 0.4, h: 1.9, face: [xl + 0.8, 0], label: "cupboard" },
      { ids: ["barrel_stove"], x: xr - 0.6, z: zb + 0.6, h: 1.1, label: "stove" },
      { ids: ["wooden_bucket_01"], x: xl + 0.5, z: 0.6, h: 0.4, label: "bucket" }, { ids: ["wicker_basket_02"], x: xr - 0.6, z: 0.8, h: 0.25, label: "basket" },
      { ids: ["painted_wooden_shelves"], x: xr - 0.3, z: -0.2, h: 1.6, face: [0, -0.2], label: "shelf" },
    ];
    case "study": return [
      P("table", 0.6, zb + 0.9, "desk", { len: 1.6, wid: 0.75 }),
      P("chair", 0.6, zb + 1.7, "chair", { face: [0.6, zb + 0.9] }),
      { ids: ["vintage_oil_lamp"], x: 1.2, z: zb + 0.9, y: 0.76, h: 0.45, label: "lamp" },
      { ids: ["wooden_bookshelf_worn"], x: xl + 1.0, z: zb + 0.4, h: 2.1, face: [xl + 1.0, 0], label: "bookshelf" },
      { ids: ["wooden_bookshelf_worn"], x: xr - 1.0, z: zb + 0.4, h: 2.1, face: [xr - 1.0, 0], label: "bookshelf" },
      { ids: ["vintage_grandfather_clock_01"], x: xr - 0.55, z: -0.9, h: 2.1, face: [0, -0.9], label: "clock" },
      { ids: ["sofa_02"], x: xr - 0.7, z: 1.3, h: 0.75, face: [0, 1.3], label: "sofa" },
    ];
    case "hall": return [
      ...setTable(0, zb + 2.0, 3.4, 0.95),
      { ids: ["GothicCabinet_01"], x: -xr * 0.55, z: zb + 0.7, h: 2.3, face: [-xr * 0.55, 0], label: "cabinet" },
      { ids: ["GothicCabinet_01"], x: xr * 0.55, z: zb + 0.7, h: 2.3, face: [xr * 0.55, 0], label: "cabinet" },
      { ids: ["painted_wooden_sofa"], x: xr - 0.7, z: 0.5, h: 1.0, face: [0, 0.5], label: "sofa" },
      { ids: ["lantern_chandelier_01"], x: 0, z: zb + 2.0, y: -0.55, h: 0.88, label: "chandelier" },
    ];
    case "bedroom": return [
      { ids: ["GothicBed_01"], x: -1.3, z: zb + 1.3, h: 1.2, face: [-1.3, 5], label: "bed" },
      { ids: ["side_table_01"], x: -0.1, z: zb + 0.4, h: 0.55, label: "table" },
      { ids: ["vintage_oil_lamp"], x: -0.1, z: zb + 0.4, y: 0.55, h: 0.4, label: "lamp" },
      { ids: ["GothicCabinet_01"], x: xr - 0.8, z: zb + 0.7, h: 2.2, face: [xr - 0.8, 0], label: "wardrobe" },
      P("chair", xr - 1.4, 0.8, "chair", { face: [0, 0.4] }),
      { ids: ["treasure_chest"], x: -1.3, z: zb + 3.0, h: 0.5, face: [-1.3, 0], label: "chest" },
    ];
    case "ship": return [
      P("table", 0.3, zb + 1.2, "table", { len: 1.1, wid: 0.7 }),
      P("stool", -0.5, zb + 1.2, "stool", { h: 0.44 }), P("stool", 1.1, zb + 1.2, "stool", { h: 0.44 }),
      { ids: ["wooden_lantern_01"], x: 0.3, z: zb + 1.2, y: 0.76, h: 0.32, label: "lantern" },
      { ids: ["treasure_chest"], x: xl + 0.7, z: zb + 0.8, h: 0.55, face: [0, 0], label: "chest" },
      { ids: ["wine_barrel_01"], x: xr - 0.6, z: zb + 0.6, h: 0.85, label: "barrel" },
      { ids: ["wooden_crate_02"], x: xr - 0.7, z: zb + 1.5, h: 0.45, face: [0, 0], label: "crate" },
      { ids: ["old_bed_frame"], x: xl + 0.7, z: 0.6, h: 1.0, face: [5, 0.6], label: "bunk" },
    ];
    case "cellar": return [
      { ids: ["wine_barrel_01"], x: -2.2, z: zb + 0.7, h: 0.9, label: "barrel" }, { ids: ["wine_barrel_01"], x: -1.2, z: zb + 0.7, h: 0.9, label: "barrel" }, { ids: ["wine_barrel_01"], x: -2.2, z: zb + 1.7, h: 0.9, label: "barrel" },
      { ids: ["wooden_crate_02"], x: 2.0, z: zb + 0.6, h: 0.45, face: [0, 0], label: "crate" }, { ids: ["wooden_crate_01"], x: 2.9, z: zb + 0.5, h: 0.4, face: [0, 0], label: "crate" },
      { ids: ["wicker_basket_01"], x: 1.6, z: zb + 1.5, h: 0.3, label: "basket" }, { ids: ["wooden_ladder"], x: xr - 0.3, z: -0.5, h: 2.0, face: [0, -0.5], label: "ladder" },
      { ids: ["wine_bottles_01"], x: -2.2, z: zb + 0.7, y: 0.9, h: 0.33, label: "bottles" },
    ];
    case "church": return [
      ...[-3.5, -1.5, 0.5, 2.5].flatMap((z, i) => [-2.6, 2.6].map((x) => P("bench", x, z, `pew${i}`, { len: 2.4, h: 0.9, rot: Math.PI / 2 }))),
      P("table", 0, zb + 1.2, "altar", { len: 1.8, wid: 0.8, h: 1.0 }),
      { ids: ["wooden_candlestick"], x: -0.6, z: zb + 1.2, y: 1.0, h: 0.4, label: "candle" }, { ids: ["wooden_candlestick"], x: 0.6, z: zb + 1.2, y: 1.0, h: 0.4, label: "candle" },
    ];
    case "future": return [];
    default: return [ // any other room: a table and chairs, somewhere to sit, a shelf and a lamp
      ...setTable(0.8, zb + 1.5, 1.7, 0.85, { benches: false, ends: 0 }),
      { ids: ["vintage_oil_lamp"], x: 0.8, z: zb + 1.5, y: 0.76, h: 0.42, label: "lamp" },
      { ids: ["painted_wooden_cabinet"], x: xl + 0.8, z: zb + 0.4, h: 1.7, face: [xl + 0.8, 0], label: "cabinet" },
      { ids: ["wooden_bookshelf_worn"], x: xr - 1.0, z: zb + 0.4, h: 2.0, face: [xr - 1.0, 0], label: "bookshelf" },
      { ids: ["sofa_02"], x: xr - 0.7, z: 1.0, h: 0.75, face: [0, 1.0], label: "sofa" },
    ];
  }
}

/** The furniture of a room, by the kind of room it is: models from the library at real sizes, and plain wooden pieces built from boards. */
export function furnishRoom(room: RoomR | null, files: Map<string, string> = new Map()): any[] {
  const out: any[] = [];
  for (const sl of layoutFor(room?.style && room.style !== "custom" ? room.style : "room", room?.w ?? 8, room?.d ?? 6)) {
    if (sl.proc) {
      const rotP = sl.face ? Math.atan2(sl.face[0] - sl.x, sl.face[1] - sl.z) : (sl.rot ?? 0);
      const { kind: fk, len, wid, h } = sl.proc;
      out.push({ id: `proc:fx-${fk}`, file: "", pos: [sl.x, sl.y ?? 0, sl.z], rotY: rotP, scale: 1, label: sl.label, parts: furniture(fk, len, wid, h) });
      continue;
    }
    const m = sl.ids.map((id) => MODELS.find((x) => x.id === id)).find((x) => x);
    if (!m) continue;
    const sc = sl.h ? sl.h / height(m) : 1;
    const rotY = sl.face ? Math.atan2(sl.face[0] - sl.x, sl.face[1] - sl.z) + FRONT : (sl.rot ?? 0);
    const dy = sl.label === "chandelier" ? (room?.h ?? 2.7) + sl.y! : (sl.y ?? 0);
    out.push({ id: m.id, file: files.get(m.id) ?? mainFile(m.id), pos: [sl.x, dy, sl.z], rotY, scale: sc, label: sl.label });
  }
  return out;
}

export function resolveScene(scene: Scene, bible: Bible, opts: { frames?: number; size?: [number, number]; pkg?: PackageAsset[]; shots?: { shot: Shot; p0: number; p1: number }[]; stage?: { cue: Cue; p0: number; p1: number }[]; acting?: { act: Act; p0: number; p1: number }[]; style?: string; place?: "interior" | "exterior"; roomStyle?: string; roomSpec?: RoomR; seconds?: number; extra?: { kind: "prop" | "set"; what: string }[]; procs?: Record<string, import("./props").Part[]>; rigs?: Record<string, Rig>; outfits?: Record<string, Outfit>; /** the judge found things placed badly: lay the scene out again differently (0 = as first made) */ seed?: number } = {}): Resolved {
  const pkg = pkgModels(opts.pkg);
  const loc = bible.locations.find((l) => l.id === scene.location);
  const locText = `${scene.location} ${loc?.desc ?? ""}`;
  const lw = words(locText.replace(/_/g, " "));
  const kind: Kind = opts.place ?? (scene.interior && !EXT_WORDS.some((e) => lw.includes(e)) ? "interior" : "exterior");
  const r = rng(hash(`${scene.id}:${scene.from}:${scene.to}${opts.seed ? ":re" + opts.seed : ""}`));
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
  const skyWords = scene.atmosphere?.sky ?? "";
  const one = pickSky(t0, skyWeather, taken, skyWords);
  const skyPool: Record<string, SkyRef> = { night: one, dawn: one, day: one, dusk: one };
  if (moving) for (const b of ["night", "dawn", "day", "dusk"]) skyPool[b] = pickSky(b === "day" ? "noon" : b, skyWeather, taken, skyWords);
  else skyPool[bucket(t0)] = one;
  const cycles = scene.kind === "timelapse" ? (scene.time.progression === "accelerating" ? 3 : 2) : 0;

  // ---- hero and set dressing
  const propText = scene.props.join(" ; ").toLowerCase();
  const sceneText = `${propText} ${locText} ${scene.subjects.map((s) => s.ref).join(" ")}`.toLowerCase();
  const hero = {
    kind: /\b(time[- ]machine|quartz levers?|the machine|saddle)\b/.test(sceneText) || scene.subjects.some((s) => s.ref === "time_traveller") ? ("time_machine" as const) : ("none" as const),
    figure: scene.subjects.some((s) => s.ref === "time_traveller"),
    sphinx: /\b(white sphinx|sphinx)\b/.test(sceneText),
  };

  // ---- people: who is in the scene, doing what, where (slots are metres around the hero)
  let presence = false; // an unseen presence in the scene (God, a voice, fate): shown as radiant light
  const figures: Fig[] = [];
  const slotX: Record<string, number> = { left: -1.8, center: 0, right: 1.8, back: 0.6, front: -0.6 };
  for (const sj of scene.subjects) {
    const t = `${sj.ref} ${sj.pose} ${sj.action}`.toLowerCase();
    if (/sphinx|statue|pedestal/.test(sj.ref)) continue;
    const kind: Fig["kind"] = /eloi/.test(sj.ref) ? "eloi" : /mrs|woman|housekeeper|watchett|lady|girl/.test(sj.ref) ? "woman" : /traveller|traveler|man|narrator|doctor|host/.test(sj.ref) ? "man" : "generic";
    const rider = kind === "man" && hero.kind === "time_machine" && /traveller|traveler/.test(sj.ref) && !/walk|stand|step|stride/.test(t);
    const pose: Fig["pose"] = rider || /\b(sit|sits|sitting|sat|seated|seat|saddle|grip|lever|ride|rides|riding)\b/.test(t) ? "seated" : /\b(walk|walks|walking|cross|crossing|stride|striding|rush|rushing|hurry|hurrying|brisk|brisklyc?)\b/.test(t) ? "walking" : /\b(crouch|crouches|crouching|kneel|kneels|kneeling|bend|bends|bending|stoop|stoops|stooping)\b/.test(t) ? "crouch" : "standing";
    const group = /observer|group|crowd|figures|people|folk/.test(sj.ref);
    const sx = slotX[sj.position] ?? 0;
    if (group) {
      for (let i = 0; i < 3; i++) figures.push({ ref: sj.ref, kind, pose: "standing", x: -3 + i * 3 + (r() - 0.5), z: -9 - r() * 3, yaw: (r() - 0.5) * 0.8, onMachine: false, walk: null, scale: kind === "eloi" ? 0.7 : 1 });
      continue;
    }
    const walk = pose === "walking" ? ([sx - 2.4, -1.4, sx + 2.4, -1.4] as [number, number, number, number]) : null;
    const cdesc = bible.characters.find((c) => c.id === sj.ref)?.desc ?? "";
    const chr = bible.characters.find((c) => c.id === sj.ref);
    if (chr?.kind === "presence") { presence = true; continue; } // no body: it is light and mood
    // the analysis says what each character is; an older analysis without it is judged from the words
    const nonPerson = chr?.kind ? chr.kind !== "person" : !!creatureLook(sj.ref, cdesc, rng(hash(`${sj.ref}:look`)));
    if (nonPerson) {
      const cr = creatureLook(sj.ref, cdesc, rng(hash(`${sj.ref}:look`))) ?? genericCreature(`${sj.ref} ${cdesc}`);
      const bm = cr.model ? (beasts as any)[cr.model] : null;
      const rig = bm ? ({ parts: [], gait: "walk", height: Math.max(bm.height, bm.len * 0.55) * SIZE_OF(`${sj.ref} ${cdesc}`.toLowerCase()), body: bm.height * SIZE_OF(`${sj.ref} ${cdesc}`.toLowerCase()) } as Rig) /* (framed to fit its length as well as its height) */ : opts.rigs?.[sj.ref] ?? rigFor({ ...cr, ears: cr.ears, species: cr.species });
      figures.push({ ref: sj.ref, kind: "creature", creature: bm ? { ...cr, ...({ modelInfo: { name: cr.model, file: `creatures/${cr.model}.glb`, scale: bm.scale * SIZE_OF(`${sj.ref} ${cdesc}`.toLowerCase()), yaw: bm.yaw, idle: bm.idle ?? bm.any, walk: bm.walk ?? bm.idle ?? bm.any, jump: bm.jump } } as any) } : cr, rig, pose: pose === "seated" || pose === "crouch" ? "standing" : pose, x: sx, z: 0.3, yaw: walk ? Math.PI / 2 : 0, onMachine: false, walk, scale: Math.max(0.3, Math.min(3, rig.height * 0.6)) });
      continue;
    }
    // when the description does not say man or woman, the scene's own words for what this person does can (she took, the woman saw)
    const dsc0 = bible.characters.find((c) => c.id === sj.ref)?.desc ?? "";
    const said = /\b(he|she|his|her|him|man|woman|boy|girl|lady|mother|father|king|queen|wife|husband|son|daughter)\b/i.test(dsc0);
    const alone = scene.subjects.filter((x) => bible.characters.find((c) => c.id === x.ref)?.kind !== "animal").length === 1;
    const pl = personLook(sj.ref, said ? dsc0 : `${dsc0} ${sj.action ?? ""} ${alone ? scene.beats.map((b) => b.action).join(" ") : ""}`, rng(hash(`${sj.ref}:look`)));
    const of = opts.outfits?.[sj.ref];
    if (of) {
      const L = pl.look;
      pl.look = { ...L, coat: of.coat ?? L.coat, vest: of.vest ?? L.vest, trou: of.trousers ?? L.trou, boot: of.boots ?? L.boot, hair: of.hair ?? L.hair, skin: of.skin ?? L.skin, beard: of.beard ?? L.beard, old: of.old ?? L.old, robe: undefined, headcloth: undefined, custom: true, skirt: of.skirt, items: of.items };
    }
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

  // ---- staging: people who are together stand in a loose arc turned toward one another (the middle one set back), not in a line facing the lens
  {
    const here = figures.filter((g) => !g.onMachine && !g.walk && g.z > -5 && hero.kind !== "time_machine");
    if (here.length >= 2 && here.length <= 7) {
      const order = here.slice().sort((a, b) => a.x - b.x);
      const n = order.length, R = 1.5 + 0.18 * n, span = Math.min(2.4, 0.5 + 0.38 * n), cz = 0.3 + R * 0.55;
      order.forEach((g, i) => {
        const a = (i / (n - 1) - 0.5) * span;
        g.x = R * Math.sin(a);
        g.z = cz - R * Math.cos(a);
        g.yaw = -a + (g.kind === "creature" ? 0 : 0); // (facing the middle of the arc)
      });
    }
  }

  // ---- acting: each character's moves, with where they walk to resolved to metres
  for (const fg of figures) {
    const mine = (opts.acting ?? []).filter((a) => a.act.who === fg.ref && ACTS_KNOWN.includes(a.act.do)).map((a) => {
      if (a.act.do !== "gesture") return a;
      // a plain gesture is played as what the scene says is happening at that sentence (a slap, a toast, a song), else as talking with the hands
      const near = (scene.beats ?? []).filter((b) => b.at <= a.act.at).sort((x, y) => y.at - x.at)[0];
      const sj = scene.subjects.find((x) => x.ref === fg.ref);
      const what = actionFor(`${near && near.at === a.act.at ? near.action : ""} ${sj?.action ?? ""}`);
      return what ? { ...a, act: { ...a.act, do: what } } : a;
    });
    if (!mine.length) {
      const sj = scene.subjects.find((x) => x.ref === fg.ref);
      const what = sj ? actionFor(`${sj.action} ${sj.pose}`) : null;
      if (what && fg.pose === "standing") fg.acts = [{ p0: 0.05, p1: 0.95, do: what }];
      continue;
    }
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

  const room: RoomR | null = kind === "interior" ? (opts.roomSpec ? { ...opts.roomSpec, wall: opts.roomSpec.floor } : roomFor(`${locText} ${scene.mood ?? ""}`, opts.roomStyle)) : null;
  const place = (m: Model, x: number, z: number, targetH?: number, label = m.name) => {
    const s = targetH ? targetH / height(m) : 1;
    assets.push({ id: m.id, file: pkg.files.get(m.id) ?? mainFile(m.id), pos: [x, 0, z], rotY: r() * Math.PI * 2, scale: s, label });
  };

  const sizeOk = (maxH: number) => (m: Model) => height(m) <= maxH;

  if (kind === "exterior") {
    const wantTrees = /\b(trees?|birch|forests?|woods?|woodland|gardens?|hills?|landscape|bush(?:es)?|rhododendrons?|orchards?|groves?)\b/.test(sceneText);
    const trees = wantTrees ? matchModel("tree", (m) => m.cats.includes("trees") && height(m) > 2.5) : null;
    const stump = matchModel("tree stump", (m) => /stump/.test(m.id));
    const rock = matchModel("boulder rock", (m) => m.cats.includes("rocks") && height(m) < 6);
    const bushes = /\b(bush(?:es)?|rhododendrons?|shrubs?|hedges?|gardens?)\b/.test(sceneText) ? matchModel("bush shrub", (m) => m.cats.includes("plants") && height(m) < 3) : null;
    if (trees) for (let i = 0; i < 3; i++) place(trees, (i - 1) * 9 + (r() - 0.5) * 5, -9 - r() * 14, 7 + r() * 5, "tree");
    if (bushes) for (let i = 0; i < 5; i++) place(bushes, (r() - 0.5) * 14, -3 - r() * 6, 0.9 + r() * 0.8, "bush");
    // scenery comes from the text: rocks where it speaks of stone, hill, cliff, desert or ruin; a stump where there are woods
    const rocky = /\b(rocks?|rocky|stones?|boulders?|cliffs?|crags?|mountains?|hills?|deserts?|ruins?|caves?|quarr(?:y|ies)|moors?|scree|ledges?|tombs?|graves?|coast|shores?|beach|coves?)\b/.test(sceneText);
    const woody = /\b(woods?|forests?|trees?|groves?|copse|orchards?|gardens?|clearing|thicket)\b/.test(sceneText);
    if (rock && rocky) for (let i = 0; i < 2; i++) place(rock, (r() - 0.5) * 12, -2 - r() * 8, 0.8 + r() * 1.2, "rock");
    if (stump && woody && r() > 0.4) place(stump, -2.4 + r(), 1.4 + r(), 0.6, "stump");
  } else {
    // furnished for the kind of room it is
    assets.push(...furnishRoom(room, pkg.files));
    // whoever is sat has something to sit on, right under them (without it the hips float at seat height)
    for (const fg of figures) if (fg.pose === "seated" && !fg.onMachine) assets.push({ id: "proc:fx-stool", file: "", pos: [fg.x, 0, fg.z], rotY: 0, scale: 1, label: "stool", parts: furniture("stool", 0, 0, 0.46) });
  }
  // anything named that we couldn't place (and isn't part of the hero) is reported, not invented
  const heroish = /\b(time[- ]machine|machine|levers?|quartz|dials?|saddle|traveller|traveler)\b/;
  const extraKind = new Map((opts.extra ?? []).map((e) => [e.what.toLowerCase(), e.kind]));
  const fishProps: string[] = [];
  for (const p of [...scene.props, ...(opts.extra ?? []).map((e) => e.what)]) {
    if (heroish.test(p.toLowerCase())) continue;
    if (ENVIRONMENT.test(headWord(p)) && !/\b(beasts?|animals?|cattle|kine|herds?|flocks?)\b/.test(p.toLowerCase())) continue; // a sea, the land, the sky, light, mist: the world itself, not an object to find in a catalogue
    if (room) {
      const lp = p.toLowerCase();
      if ((room.fixtures ?? []).includes("hearth") && /fireplace|hearth|chimney|mantel|fire\b|firelight|embers|flames?/.test(lp)) continue; // the room has one built in
      const head = words(lp).pop() ?? "";
      if (assets.some((a) => a.label === head || a.label === head.replace(/s$/, ""))) continue; // already furnished with one
    }
    // fish and sea creatures named as things in the scene live in the water: placed there once it is known (never a box on the grass)
    if (!room && /\b(\w*fish|\w*fishes|mackerel|mackereel|eel|eels|dab|plaice|skate|dace|pickerel|pickereel|pike|herring|cod|trout|salmon|crab|crabs|shoal|minnow|minnows|sole|haddock|perch|carp)\b/.test(p.toLowerCase()) && !/\b(fisherman|fishing|fisher)\b/.test(p.toLowerCase())) { fishProps.push(p); continue; }
    // an animal named as a thing in the scene (cattle, a horse, the beasts of the field): the real model, a few of them if it is a herd, never a box
    if (!room && kind === "exterior") {
      const hw = /\b(cattle|kine)\b/.test(p.toLowerCase()) ? "cattle" : headWord(p);
      const generic = /\b(beast|beasts|animal|animals)\b/.test(p.toLowerCase());
      const pickSp = generic ? ["horse", "wolf", "zebra", "llama", "cow", "sheep"][Math.floor(r() * 6)] : hw;
      const cl = creatureLook(pickSp === hw ? p : pickSp, "", r);
      const bm = cl?.model ? (beasts as any)[cl.model] : null;
      if (cl?.model && bm && assets.length < 28) {
        const n = /\b(cattle|herd|flock|beasts|animals|kine|sheep|goats)\b/.test(p.toLowerCase()) ? 3 : 1;
        for (let k = 0; k < n; k++) {
          const ang = r() * Math.PI * 2, dd = 4 + r() * 6;
          assets.push({ id: `pkg:beast-${cl.model}-${k}-${hash(p) % 999}`, file: `creatures/${cl.model}.glb`, pos: [(Math.sin(ang) < 0 ? -1 : 1) * (4 + Math.abs(Math.sin(ang)) * (dd - 1)), 0, /\b(sea|seas|ocean|shore|beach|waves?|water|waters|lake|coast)\b/.test(sceneText) ? -3 - r() * 3 : -3 - Math.abs(Math.cos(ang)) * dd], rotY: bm.yaw + r() * Math.PI * 2, scale: bm.scale * SIZE_OF(p.toLowerCase()) * (0.9 + r() * 0.2), label: p } as any);
        }
        continue;
      }
    }
    const pm = matchPkg(p, pkg.models);
    const bk = !pm && kind === "exterior" ? buildingKind(p) : undefined;
    if (bk && assets.length < 30 && !assets.some((a) => a.id === `bld:${bk[0]}`)) {
      // no model for it: the runtime builds it
      assets.push({ id: `bld:${bk[0]}`, file: "", pos: [(r() - 0.5) * 22, 0, -bk[3] - r() * 8], rotY: (r() - 0.5) * 1.2, scale: bk[2] * (0.9 + r() * 0.3), label: p });
      continue;
    }
    const m = pm ?? matchModel(p, sizeOk(30));
    if (m && !assets.some((a) => a.id === m.id) && assets.length < 30) (room ? place(m, (r() - 0.5) * (room.w - 3), room.d * -0.5 + 0.7 + r() * (room.d * 0.3), undefined, p) : place(m, (r() - 0.5) * 10, -2 - r() * 7, undefined, p));
    else if (!m && !/tree|bush|rock|hill|sky|building|tower|garden/.test(p.toLowerCase())) {
      // no model in the library: a prop the language model has drawn from basic shapes, or reported as missing
      const parts = opts.procs?.[p.toLowerCase()];
      if (parts && assets.length < 30) assets.push({ id: `proc:${p.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, file: "", pos: extraKind.get(p.toLowerCase()) === "set" && kind === "exterior" ? [(r() - 0.5) * 24, 0, -9 - r() * 8] : room ? [(r() - 0.5) * (room.w - 3), 0, room.d * -0.5 + 0.7 + r() * (room.d * 0.3)] : [(r() - 0.5) * 5, 0, -0.5 - r() * 3], rotY: r() * Math.PI * 2, scale: 1, label: p, parts });
      else unresolved.push(p);
    }
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
    let bk = buildingKind(locText);
    // the model designs the structures of this place for its period and setting; a plain house until it has (never a modern skyline unless the text says so)
    if (bk && bk[0] !== "pyramid" && bk[0] !== "obelisk" && bk[0] !== "cyclopean") {
      const phrase = `set: ${locText.replace(/\s+/g, " ").slice(0, 160)}`;
      const made = opts.procs?.[phrase.toLowerCase()];
      if (made) {
        assets.push({ id: `proc:place-${hash(phrase) % 99999}`, file: "", pos: [(r() - 0.5) * 6 + 5, 0, -Math.max(10, bk[3] * 0.55)], rotY: -0.3 + (r() - 0.5) * 0.4, scale: 1, label: locText.slice(0, 24), parts: made });
        bk = undefined;
      } else {
        unresolved.push(phrase);
        if (bk[0] === "city" && !/\b(skyscrapers?|skyline|metropolis|modern|neon|traffic)\b/.test(locText)) bk = BUILDINGS.find((b) => b[0] === "house");
      }
    }
    if (bk) assets.push({ id: `bld:${bk[0]}`, file: "", pos: [(r() - 0.5) * 6 + 6, 0, -Math.max(9, bk[3] * 0.6)], rotY: -0.35 + (r() - 0.5) * 0.4, scale: bk[2] * 1.15, label: locText.slice(0, 24) });
  }

  // ---- ground / room
  const gid = grey || /storm|hail|rain/.test(scene.weather) ? "brown_mud_leaves_01" : "forrest_ground_01";
  const ground = kind === "exterior" ? pickGround(`${locText} ${propText}`, gid, hash(`${scene.id}:ground`)) : null;
  // water: the sea, a lake, a shore. The land ends at a shoreline and the water runs on to the horizon.
  const aquatic = figures.filter((g) => g.kind === "creature" && /^(whale|fish|piranha)$/.test(g.creature?.species ?? ""));
  const wet = aquatic.length > 0 || /\b(sea|seas|ocean|shore|shoreline|beach|waves?|tide|tides|surf|harbou?r|bay|lake|coast|swell|brine|strand|shoal|lagoon|estuary|river|water)\b/.test(sceneText + " " + (scene.weather ?? ""));
  const water: Resolved["water"] = kind === "exterior" && wet && !/\b(rain|raindrop)\b/.test(locText) ? {
    zEdge: /\b(lakes?|rivers?|harbou?rs?)\b/.test(sceneText) ? -9 : -6,
    mood: /\b(red (?:water|sea|waters|seas)|crimson|scarlet (?:sea|water)|blood)\b/.test(sceneText) ? "red" : /\b(oily|black water|dark water|slick|tar|tarry)\b/.test(sceneText) ? "oily" : /\b(storm|stormy|rough|gale|tempest|heavy seas)\b/.test(sceneText + " " + scene.weather) ? "storm" : "calm",
  } : null;
  // whales and fish live in the water: out in the sea, not on the shore
  if (water && fishProps.length && !aquatic.some((g) => g.creature?.species === "fish") && beasts && (beasts as any).fish) {
    const fm = (beasts as any).fish;
    const n = Math.min(7, 2 + fishProps.length);
    for (let k = 0; k < n; k++) assets.push({ id: `pkg:beast-fish-${k}-${hash(fishProps.join(","))%999}`, file: "creatures/fish.glb", pos: [(r() - 0.5) * 16, 0.05, water.zEdge - 2.5 - r() * 7], rotY: fm.yaw + r() * Math.PI * 2, scale: fm.scale * (0.7 + r() * 0.8), label: "fish" } as any);
  }
  aquatic.forEach((g, k) => { if (water) { g.z = water.zEdge - 3 - k * 1.8; g.x = (k - (aquatic.length - 1) / 2) * 3.2; g.yaw = 0.6; } });

  // ---- life: between the acts the book names, everyone keeps moving: changing gestures, glances at the others, short strolls.
  // Each person has their own timeline (seeded by name), shaped by the mood of the scene, so no two move alike.
  {
    const secs = Math.max(8, opts.seconds ?? 40);
    const mood = `${scene.mood ?? ""} ${scene.beats.map((b) => b.action).join(" ")}`.toLowerCase();
    const heat = /anger|angry|tense|menac|danger|fury|rage|threat|fight|quarrel|standoff/.test(mood);
    const glad = /merry|joy|rowdy|festive|cheer|celebrat|raucous|triumph|laugh/.test(mood);
    const dark = /sad|grief|mourn|fear|dread|ominous|terror|dismay|quiet|gloom|solemn/.test(mood);
    for (const fg of figures) {
      if (fg.onMachine || fg.walk) continue;
      const rnd = rng(hash(`${fg.ref}:life:${scene.id}`));
      const explicit = fg.acts ?? [];
      const sits = explicit.some((a) => a.do === "sit" || a.do === "crouch") || fg.pose !== "standing";
      const pool: string[] = ["talk", "talk", "talk", "nod", "think", "shrug", "look", "look", "point"];
      if (!sits) pool.push("walk", "walk");
      if (heat) pool.push("shake_fist", "point", "point");
      if (glad) pool.push("cheer", "laugh", "clap", "drink");
      if (dark) pool.push("cover_face", "think", "think", "plead");
      const out = [...explicit];
      const busy = (a: number, b: number) => out.some((x) => x.p0 < b + 0.01 && x.p1 > a - 0.01);
      let t = 1.5 + rnd() * 4;
      while (t < secs - 2) {
        const dur = 2.2 + rnd() * 3.2;
        const p0 = t / secs;
        const p1 = Math.min(0.99, (t + dur) / secs);
        if (!busy(p0, p1)) {
          const what = pool[Math.floor(rnd() * pool.length)];
          if (what === "walk") {
            let tx = fg.x + (rnd() - 0.5) * 2.6;
            let tz = fg.z + (rnd() - 0.5) * 1.8;
            if (room) { tx = Math.max(-room.w / 2 + 0.8, Math.min(room.w / 2 - 0.8, tx)); tz = Math.max(-room.d / 2 + 0.8, Math.min(room.d / 2 - 0.8, tz)); }
            out.push({ p0, p1, do: "walk_to", tx, tz });
          } else if (what === "look") {
            const o = figures.filter((q) => q !== fg)[Math.floor(rnd() * Math.max(1, figures.length - 1))];
            if (o) out.push({ p0, p1, do: "look_at", tx: o.x, tz: o.z });
          } else out.push({ p0, p1, do: what === "talk" ? "gesture" : what });
        }
        t += dur + 0.8 + rnd() * 3.5;
      }
      fg.acts = out.sort((a, b) => a.p0 - b.p0);
    }
  }

  // ---- camera: frame the hero (~1.8 m) by framing and move
  const onlyCreatures = figures.length > 0 && figures.every((g) => g.kind === "creature");
  const heroH = hero.sphinx ? 5 : onlyCreatures ? Math.max(0.45, Math.max(...figures.map((g) => g.rig?.height ?? 0.5)) * 1.5) : 1.9; // (a scene of small animals is framed for them, not for a person)
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
  /** the height in metres of a placed animal model (null for anything else) */
  const beastH = (a: { id: string; scale: number }): number | null => {
    const m = /^pkg:beast-(.+)-\d+-\d+$/.exec(a.id);
    const bm = m ? (beasts as any)[m[1]] : null;
    return bm ? bm.height * (a.scale / bm.scale) : null;
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
      if (fig.kind === "creature") return [fig.x, Math.max(0.15, (fig.rig?.body ?? fig.rig?.height ?? 0.5) * (framing === "wide" ? 0.55 : 0.6)), fig.z]; // (an animal is looked at in the middle of its body, not at a person's chest height)
      return [fig.onMachine ? 0 : fig.x, (level + seatedLift) * fig.scale, fig.onMachine ? 0.02 : fig.z];
    }
    if (/lever|dial|machine|rod|quartz/.test(f)) return [/lever/.test(f) ? 0.12 : 0, /lever/.test(f) ? 0.75 : 0.85, 0.35];
    const asset = assets.find((a) => f.includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(f));
    if (asset && f !== "scene") {
      // a wide shot of a thing with people about keeps the nearest person in frame too: aim between them
      const who = (framing as string) === "wide" ? figures.filter((g) => !g.onMachine).sort((a, b) => Math.hypot(a.x - asset.pos[0], a.z - asset.pos[2]) - Math.hypot(b.x - asset.pos[0], b.z - asset.pos[2]))[0] : undefined;
      if (who) return [(who.x + asset.pos[0]) / 2, Math.max(0.6, level * 0.6), (who.z + asset.pos[2]) / 2];
      const ah = beastH(asset); // an animal is aimed at its own middle, not at human chest height
      if (ah) return [asset.pos[0], ah * 0.55, asset.pos[2]];
      return [asset.pos[0], Math.max(0.4, level * 0.6), asset.pos[2]];
    }
    // nothing in particular to look at: look at the people (their middle, at chest height) rather than an empty centre
    const people = figures.filter((g) => !g.onMachine);
    const bodyH = (g: Fig) => (g.kind === "creature" ? (g.rig as any)?.body ?? g.rig?.height ?? 0.5 : 1.75 * (g.scale ?? 1));
    const heart = () => { const cx = people.reduce((a, g) => a + g.x, 0) / people.length, cz = people.reduce((a, g) => a + g.z, 0) / people.length; return [cx, (people.reduce((a, g) => a + bodyH(g), 0) / people.length) * 0.6, cz] as [number, number, number]; };
    if (people.length && kind !== "exterior" || people.length && (framing as string) !== "wide") {
      const cx = people.reduce((a, g) => a + g.x, 0) / people.length, cz = people.reduce((a, g) => a + g.z, 0) / people.length;
      return [cx, 1.1 * (people[0].kind === "creature" ? bodyH(people[0]) / 1.1 : people[0].scale ?? 1), cz];
    }
    if (people.length && onlyCreatures) return heart(); // (a wide shot of animals still looks at the animals)
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
    // nobody and nothing to look at (a landscape, "the heavens and the earth were finished"): look out at the horizon, not down at the gravel
    const landscape = !figures.some((g) => !g.onMachine) && !knownFocus(sh.focus) && hero.kind !== "time_machine" && kind !== "interior";
    if (landscape) tgt[1] = Math.max(tgt[1], 2.2);
    // a scene of small animals is framed close; of big ones, back
    const csc = figures.length && figures.every((g) => g.kind === "creature") ? Math.max(0.3, Math.min(3.5, Math.max(...figures.map((g) => g.scale)) * 1.25)) : 1;
    const fa = assets.find((a) => knownFocus(sh.focus) && !figures.some((g) => sh.focus.toLowerCase().includes(g.ref.toLowerCase())) && (sh.focus.toLowerCase().includes(a.label.toLowerCase()) || a.label.toLowerCase().includes(sh.focus.toLowerCase())) && beastH(a));
    const fh = fa ? beastH(fa)! : 0;
    const d00 = Math.min(kind === "interior" ? 5.2 : 45, ((fr.frame * csc) / (2 * Math.tan((fr.fov * Math.PI) / 360))) * (fh ? Math.max(1, fh / 1.5) * 1.6 : 1));
    // a long animal (a whale) is kept whole in the picture: far enough back that its length fits, whatever the framing
    const bigL = figures.length && figures.every((g) => g.kind === "creature") ? Math.max(...figures.map((g) => (g.rig?.height ?? 0) / 0.55)) : 0;
    const d0 = bigL > 2.5 && framing !== "close" && framing !== "extreme_close" ? Math.max(d00, (bigL * 1.5) / (2 * Math.tan((fr.fov * Math.PI) / 360))) : d00;
    // alternate the side the camera sits on, so a cut changes the view instead of repeating it
    const az = az0 + (i % 2 === 0 ? -0.3 : 0.55) + (sh.angle === "over_shoulder" ? 0.7 : 0);
    const camY = landscape ? tgt[1] + (sh.angle === "low" ? -0.5 : 0.25) : sh.angle === "low" ? Math.max(0.55, tgt[1] - Math.min(0.45, d0 * 0.17)) : sh.angle === "high" ? Math.max(2.4 * Math.min(1, csc * 1.5), tgt[1] + 1.4 * Math.min(1, csc * 1.5)) : sh.angle === "over_shoulder" ? tgt[1] + 0.15 : Math.max(0.9, Math.min(1.7, tgt[1] + 0.1));
    const push = sh.move === "push" ? [1.14, 0.9] : sh.move === "pull" ? [0.88, 1.12] : [1, 1];
    const sweep = sh.move === "orbit" ? 0.5 : sh.move === "drift" ? 0.18 : 0.02;
    const place2 = (a: number, d: number): [number, number, number] => {
      const e = Math.min(0.62, Math.asin(Math.max(-0.9, Math.min(0.9, (camY - tgt[1]) / d)))); // (never straight down on someone: at most about 35 degrees above)
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
  // a small room (a ship's cabin) has less floor than the props were laid out for: keep everything inside the walls
  if (room) {
    const fx = room.w / 2 - 0.55, fz = room.d / 2 - 0.55;
    for (const a of assets as any[]) { a.pos = [Math.max(-fx, Math.min(fx, a.pos[0])), a.pos[1], Math.max(-fz, Math.min(fz, a.pos[2]))]; }
    for (const g of figures as any[]) { if (g.onMachine) continue; g.x = Math.max(-fx, Math.min(fx, g.x)); g.z = Math.max(-fz, Math.min(fz, g.z)); }
  }
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
      const type: string = /butterfly|moth|bat|flutter|wing/.test(w) ? "butterfly" : /bird|gull|eagle|crow|raven|hawk|pterodactyl|swallow/.test(w) ? "bird" : /crab|lobster|crustacean|spider|insect|beetle|scorpion|monster|horror|blob|thing|creature/.test(w) ? "crab" : "beast";
      // a path across the ground in front of the default camera, left to right or right to left
      const dir = sr() < 0.5 ? -1 : 1;
      // a four-legged one that has a real model crosses as that model (a generic "beast" is one of the field animals)
      const birdM: string | null = type === "bird" ? (/eagle|hawk|vulture|falcon/.test(w) ? "eagle" : "bird") : null;
      const cl = type === "beast" ? creatureLook(/\b(beasts?|animals?)\b/.test(w) && !/horse|cow|dog|cat|wolf|fox|sheep|pig/.test(w) ? "beast" : w, w, sr) : null;
      // a bird of the one bird model, in the nearest of its colours to the colour the words give it (a crow dark, a gull white, a sparrow brown, a bluebird blue)
      const birdTone = type === "bird" && birdM === "bird" ? nearestBird(creatureLook(w, w, sr)?.body ?? "#7a5a3c") : null;
      const mname = birdTone ?? birdM ?? cl?.model;
      const bm = mname ? (beasts as any)[mname] : null;
      const model = bm ? { file: `creatures/${mname}.glb`, scale: bm.scale * SIZE_OF(w) * (birdM === "eagle" ? 4 : birdM ? 6 : 1), yaw: bm.yaw, clip: bm.walk ?? bm.idle ?? bm.any } : undefined;
      stage.push({ ...base, what: type, kind: w, az: fwdAz + dir * 0.0, items: [{ id: type, file: "", pos: [lookX + dir * -9, 0, 2.2 + sr() * 1.6], rotY: dir > 0 ? Math.PI / 2 : -Math.PI / 2, scale: 1, d: 0, ...(model ? { model } : {}) } as any] });
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
    sun: { startElev: SUN_ELEV[t0] ?? 30, endElev: SUN_ELEV[t1] ?? 30, cycles, azimuth: -0.8 + r() * 1.6, color: scene.atmosphere?.light ?? (presence ? "#ffe2a0" : SUN_COLOR[t0] ?? "#ffe9c9"), strength: (grey ? 0.35 : 1) * (presence ? 1.5 : 1) },
    ground,
    water,
    room,
    fog: { color: scene.atmosphere?.fog ?? (grey ? "#8f98a3" : (FOG[t0] ?? "#c6d4e6")), density: kind === "interior" ? 0 : scene.atmosphere?.fogDensity ?? (grey ? 0.03 : 0.012) },
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
  for (const a of r.assets) if (!a.id.startsWith("pkg:") && !a.id.startsWith("bld:") && !a.id.startsWith("proc:")) add("model", a.id, "1k"); // bundled models are already on disk; buildings are built in the runtime
  for (const c of r.stage ?? []) for (const it of c.items ?? []) if (it.file && !it.tower) add("model", it.id, "1k"); // towers and creatures are built in the runtime
  if (r.ground) add("texture", r.ground.id, "1k");
  if (r.room) add("texture", r.room.floor, "1k");
  for (const t of r.textures) add("texture", t, "1k");
  return [...out.values()];
}

/** Bump when runtime/scene.tsx changes in a way that alters frames, so cached renders are redone. */
export const RUNTIME_VERSION = "rt126";

/** Cache key: changes whenever the resolved plan or the runtime does. */
export function sceneKey(r: Resolved): string {
  return `${RUNTIME_VERSION}-${r.id}-${hash(RUNTIME_VERSION + JSON.stringify(r)).toString(36)}`;
}
