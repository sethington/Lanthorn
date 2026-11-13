// A rig is a creature (or any living thing) as data: a tree of shaped parts, each hung on a pivot of its parent, each saying what it does when
// the figure walks, turns its head, flaps, wags or talks. One interpreter in the runtime animates any rig, so the language model can author a
// rabbit, a dragon, an angel or a talking teapot for the book in hand, and it is kept for every later book. The built-in builders below are the
// fallback when no model is routed, and the worked examples the model is shown.
import { api } from "./api";

export type RigRole = "body" | "head" | "leg" | "arm" | "wing" | "tail" | "ear" | "jaw" | "seg" | "none";
export type RigPart = {
  id: string;
  parent: string | null;
  /** the shape: ell = an ellipsoid of these radii, box = full lengths, cyl = [radius, height], cone = [radius, height] */
  s: "ell" | "box" | "cyl" | "cone";
  d: number[];
  c: string;
  /** the pivot, in the parent's frame (metres; the root's is on the ground) */
  p: [number, number, number];
  /** where the shape's centre is from its pivot (a leg hangs below its hip) */
  o?: [number, number, number];
  /** a fixed turn (radians) of the part and everything on it */
  r?: [number, number, number];
  role?: RigRole;
  /** which side (wings, legs, ears): -1 left, 1 right; and phase 0|1 for the half of the limbs that swing together */
  side?: number;
  phase?: number;
  m?: number;
};
export type Rig = { parts: RigPart[]; gait: "walk" | "hop" | "fly" | "slither" | "none"; height: number };

const num = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const v3 = (v: any, d: [number, number, number] = [0, 0, 0]): [number, number, number] => (Array.isArray(v) ? [num(v[0], -30, 30, d[0]), num(v[1], -30, 30, d[1]), num(v[2], -30, 30, d[2])] : d);
const ROLES = new Set(["body", "head", "leg", "arm", "wing", "tail", "ear", "jaw", "seg", "none"]);

export function parseRig(text: string): Rig | null {
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j.parts)) return null;
    const parts: RigPart[] = [];
    const ids = new Set<string>();
    for (const q of j.parts.slice(0, 48)) {
      if (typeof q?.id !== "string" || !["ell", "box", "cyl", "cone"].includes(q.s) || !Array.isArray(q.d)) continue;
      const parent = typeof q.parent === "string" && ids.has(q.parent) ? q.parent : null; // a parent comes before its children
      if (ids.has(q.id)) continue;
      ids.add(q.id);
      const dn = q.s === "ell" || q.s === "box" ? 3 : 2;
      const d = Array.from({ length: dn }, (_, i) => num(q.d[i], 0.003, 30, 0.1));
      parts.push({ id: q.id, parent, s: q.s, d, c: /^#[0-9a-fA-F]{6}$/.test(q.c) ? q.c : "#8a7a6a", p: v3(q.p), o: v3(q.o), r: v3(q.r), role: ROLES.has(q.role) ? q.role : "none", side: q.side === -1 ? -1 : q.side === 1 ? 1 : 0, phase: q.phase ? 1 : 0, m: q.m ? 1 : 0 });
    }
    if (parts.length < 2 || !parts.some((x) => x.parent === null)) return null;
    // height: the highest point any part reaches (by its pivot chain), for framing
    const pos = new Map<string, number>();
    let top = 0;
    for (const q of parts) { const y = (q.parent ? pos.get(q.parent) ?? 0 : 0) + q.p[1]; pos.set(q.id, y); top = Math.max(top, y + (q.o?.[1] ?? 0) + (q.s === "cyl" || q.s === "cone" ? q.d[1] / 2 : q.d[1] * (q.s === "ell" ? 1 : 0.5))); }
    return { parts, gait: ["walk", "hop", "fly", "slither", "none"].includes(j.gait) ? j.gait : "walk", height: Math.max(0.1, top) };
  } catch { return null; }
}

// ---- the built-in builders (and the examples the model is shown)
export type Traits = { cls: "quad" | "bird"; size: number; body: string; belly: string; dark: string; ears: string; tail: string; snout: string; dress?: string; species?: string };
const LEGS: Record<string, number> = { rabbit: 0.26, hedgehog: 0.14, mouse: 0.2, cat: 0.38, squirrel: 0.28, pig: 0.3, sheep: 0.48, bear: 0.45, dog: 0.5, fox: 0.45, wolf: 0.55, goat: 0.5, cow: 0.55, horse: 0.78, deer: 0.78, lion: 0.5, frog: 0.14 };
export function rigFor(t: Traits): Rig {
  const s = t.size;
  const P: RigPart[] = [];
  const add = (id: string, parent: string | null, sh: RigPart["s"], d: number[], c: string, p: [number, number, number], o: Partial<RigPart> = {}) => P.push({ id, parent, s: sh, d, c, p: p.map((x) => +(x * s).toFixed(4)) as [number, number, number], ...o, o: (o.o ?? [0, 0, 0]).map((x) => +(x * s).toFixed(4)) as [number, number, number] });
  const R = (a: number[]) => a.map((x) => +(x * s).toFixed(4));
  const eye = (parent: string, x: number, y: number, z: number, r = 0.034) => { add(`${parent}_eye${x > 0 ? "R" : "L"}`, parent, "ell", R([r, r, r]), "#14100e", [x, y, z]); };
  if (t.cls === "bird") {
    add("body", null, "ell", R([0.2, 0.22, 0.3]), t.body, [0, 0.55, 0], { role: "body", r: [0.25, 0, 0] });
    add("belly", "body", "ell", R([0.16, 0.15, 0.22]), t.belly, [0, -0.08, 0.06]);
    add("tail", "body", "ell", R([0.07, 0.04, 0.2]), t.dark, [0, 0.03, -0.34], { role: "tail", r: [-0.3, 0, 0] });
    for (const sd of [-1, 1]) add(`wing${sd}`, "body", "ell", R([0.04, 0.16, 0.26]), t.dark, [sd * 0.2, 0.05, -0.02], { role: "wing", side: sd });
    add("head", "body", "ell", R([0.12, 0.12, 0.13]), t.body, [0, 0.31, 0.2], { role: "head" });
    add("beak", "head", "ell", R([0.05, 0.035, 0.1]), "#e8a030", [0, -0.02, 0.14]);
    eye("head", 0.07, 0.03, 0.08, 0.026); eye("head", -0.07, 0.03, 0.08, 0.026);
    for (const sd of [-1, 1]) {
      add(`leg${sd}`, "body", "ell", R([0.018, 0.17, 0.018]), "#e8a030", [sd * 0.07, -0.21, 0], { role: "leg", side: sd, phase: sd > 0 ? 1 : 0, o: [0, -0.16, 0] });
      add(`foot${sd}`, `leg${sd}`, "ell", R([0.05, 0.015, 0.07]), "#e8a030", [0, -0.33, 0.04]);
    }
    return { parts: P, gait: "walk", height: s * 1.0 };
  }
  const lh = LEGS[t.species ?? ""] ?? 0.45;
  const fat = ["pig", "sheep", "bear", "cow"].includes(t.species ?? "") ? 1.4 : t.species === "rabbit" ? 1.25 : 1;
  const long = t.species === "horse" || t.species === "deer";
  const hop = t.species === "rabbit" || t.species === "frog";
  const ty = lh + 0.12;
  add("torso", null, "ell", R([0.27 * (fat > 1 ? 1.1 : 1), 0.27 * (fat > 1 ? 1.15 : 1), 0.46]), t.body, [0, ty, 0], { role: "body" });
  add("belly", "torso", "ell", R([0.2, 0.17, 0.38]), t.belly, [0, -0.1, 0.03]);
  for (const sd of [-1, 1]) add(`haunch${sd}`, "torso", "ell", R([0.12, 0.17, 0.2]), t.body, [sd * 0.17, -0.07, -0.22]);
  if (t.dress) { add("jacket", "torso", "ell", R([0.3, 0.3, 0.3]), t.dress, [0, 0.01, 0.1]); add("collar", "torso", "ell", R([0.18, 0.07, 0.07]), t.dress, [0, 0.16, 0.32]); }
  add("head", "torso", "ell", R([0.2, 0.18, 0.21]), t.body, [0, long ? 0.34 : 0.2, long ? 0.58 : 0.5], { role: "head", r: [long ? 0.45 : 0, 0, 0], o: [0, 0.03, 0.03] });
  const sn: Record<string, [number[], number[]]> = { short: [[0, -0.03, 0.19], [0.09, 0.075, 0.09]], long: [[0, -0.035, 0.27], [0.075, 0.07, 0.2]], flat: [[0, -0.04, 0.2], [0.11, 0.09, 0.07]], beak: [[0, -0.03, 0.2], [0.05, 0.04, 0.1]] };
  const [sp, sr] = sn[t.snout] ?? sn.short;
  const pig = t.species === "pig";
  add("snout", "head", "ell", R(sr), pig ? t.body : t.belly, sp as any);
  add("nose", "head", "ell", R([0.03, 0.025, 0.025]), pig ? "#c07a78" : "#2a1c18", [sp[0], sp[1] + 0.025, sp[2] + sr[2] * 0.85]);
  eye("head", 0.1, 0.09, 0.14); eye("head", -0.1, 0.09, 0.14);
  for (const sd of [-1, 1]) {
    if (t.ears === "long") add(`ear${sd}`, "head", "ell", R([0.045, 0.27, 0.03]), t.body, [sd * 0.09, 0.2, -0.04], { role: "ear", side: sd, r: [-0.25, 0, sd * 0.18], o: [0, 0.12, 0] });
    else if (t.ears === "point") add(`ear${sd}`, "head", "ell", R([0.06, 0.12, 0.035]), t.body, [sd * 0.1, 0.19, 0], { role: "ear", side: sd, r: [-0.1, 0, sd * 0.15] });
    else if (t.ears === "round") add(`ear${sd}`, "head", "ell", R([0.07, 0.07, 0.03]), t.body, [sd * 0.13, 0.17, -0.02], { role: "ear", side: sd });
    else if (t.ears === "floppy") add(`ear${sd}`, "head", "ell", R([0.05, 0.15, 0.09]), t.dark, [sd * 0.18, 0.02, -0.02], { role: "ear", side: sd, r: [0, 0, sd * 0.35] });
  }
  const legPos: [number, number, number, number][] = [[0.15, 0.3, 0, 1], [-0.15, 0.3, 1, -1], [0.15, -0.26, 1, 1], [-0.15, -0.26, 0, -1]];
  legPos.forEach(([x, z, ph], i) => {
    add(`leg${i}`, "torso", "ell", [0.055 * s * fat, lh * 0.52 * s, 0.055 * s * fat], t.body, [x, -0.12, z], { role: "leg", side: x > 0 ? 1 : -1, phase: hop ? 0 : ph, o: [0, -lh * 0.5, 0] });
    add(`paw${i}`, `leg${i}`, "ell", R([0.06 * fat, 0.035, 0.09]), t.belly, [0, -lh * 0.97, 0.03]);
  });
  if (t.tail === "puff") add("tail", "torso", "ell", R([0.1, 0.1, 0.1]), "#f4f0e6", [0, 0.1, -0.5], { role: "tail" });
  else if (t.tail === "short") add("tail", "torso", "ell", R([0.05, 0.05, 0.07]), t.body, [0, 0.1, -0.48], { role: "tail" });
  else if (t.tail === "long" || t.tail === "bushy") {
    add("tail", "torso", "ell", t.tail === "bushy" ? R([0.1, 0.1, 0.32]) : R([0.035, 0.035, 0.3]), t.body, [0, 0.08, -0.46], { role: "tail", r: [-0.45, 0, 0], o: [0, 0, -0.28] });
    if (t.tail === "bushy") add("tailtip", "tail", "ell", R([0.08, 0.08, 0.1]), "#f4f0e6", [0, 0, -0.5]);
  }
  return { parts: P, gait: hop ? "hop" : "walk", height: s * (t.ears === "long" ? 1.5 : 1.1) };
}

// ---- the model writes rigs
const compact = (r: Rig) => JSON.stringify({ gait: r.gait, parts: r.parts.map((q) => ({ id: q.id, parent: q.parent, s: q.s, d: q.d.map((x) => +x.toFixed(3)), c: q.c, p: q.p.map((x) => +x.toFixed(3)), ...(q.o && q.o.some((x) => x) ? { o: q.o.map((x) => +x.toFixed(3)) } : {}), ...(q.r && q.r.some((x) => x) ? { r: q.r } : {}), ...(q.role && q.role !== "none" ? { role: q.role } : {}), ...(q.side ? { side: q.side } : {}), ...(q.phase ? { phase: q.phase } : {}) })) });
const EX_RABBIT = compact(rigFor({ cls: "quad", size: 0.4, body: "#8a6a4a", belly: "#cdbfa8", dark: "#4a3a2a", ears: "long", tail: "puff", snout: "short", species: "rabbit", dress: "#3f5f9a" }));
const EX_DUCK = compact(rigFor({ cls: "bird", size: 0.4, body: "#f2eee4", belly: "#ffffff", dark: "#d8d2c2", ears: "none", tail: "short", snout: "beak", species: "duck" }));
export const rigSystem = () => `You design a living thing for a picture book, as data for a small animation engine. It is a tree of shaped parts, in metres, standing on the ground (y up, the creature faces +z). Reply with ONE JSON object only: {"gait":"walk|hop|fly|slither|none","parts":[...]}.
Each part: {"id","parent":<id of an earlier part or null for the single root>,"s":"ell|box|cyl|cone","d":[...],"c":"#rrggbb","p":[x,y,z],"o":[x,y,z],"r":[rx,ry,rz],"role":"body|head|leg|arm|wing|tail|ear|jaw|seg|none","side":-1|1,"phase":0|1}.
- p is the part's PIVOT in its parent's frame (the root's is on the ground; its children hang off it). o is where the shape's centre sits from its pivot (a leg's pivot is the hip and o points down). r is a fixed turn in radians.
- d: ell = three radii [x,y,z]; box = three full lengths; cyl and cone = [radius, height].
- role says how it moves: body (bobs), head (turns, nods), leg and arm (swing; phase 0 and 1 swing opposite; side -1 left, 1 right), wing (flaps), tail (wags), ear (twitches), jaw (opens when it talks), seg (a body segment in a chain; each seg is the child of the one before and the chain ripples like a snake or a dragon's tail).
- Give it a face (two small dark eye ellipsoids on the head), the markings and colours the description says, and anything it wears. 12 to 40 parts. Make it charming and clear from a distance; size to its real size unless the description says otherwise.
Examples:
Description: Peter, a small brown rabbit in a blue jacket -> ${EX_RABBIT}
Description: a white duck -> ${EX_DUCK}`;
/** A rig for this character (kept across books). Null when no model is routed or it fails: the caller falls back to the built-in. */
export async function makeRig(key: string, desc: string, cacheOnly = false): Promise<Rig | null> {
  const k = `${desc}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 80) || key;
  try {
    const hit = await api.cacheGet("rig", k);
    if (hit) { const r = parseRig(hit); if (r) return r; }
    if (cacheOnly) return null;
    const c = await api.llmComplete("scan", rigSystem(), `Description: ${desc}`);
    const r = parseRig(c.text);
    if (r) await api.cachePut("rig", k, c.text);
    return r;
  } catch { return null; }
}
