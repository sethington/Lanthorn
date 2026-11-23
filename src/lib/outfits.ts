// What a person wears and carries, written by the model from the book's description of them (a shepherd's headcloth and staff, a captain's hat
// and cutlass, a queen's crown and long gown, a schoolgirl's satchel), kept for every later book. The runtime paints the colours onto the body
// and hangs the skirt and each item on a joint, so any costume is data, not code. (personLook in resolve.ts is the fallback.)
import { api } from "./api";
import { askMany } from "./author";

export type OutfitItem = { at: "head" | "chest" | "hips" | "back" | "hand_r" | "hand_l" | "feet"; s: "ell" | "box" | "cyl" | "cone"; d: number[]; c: string; p: [number, number, number]; r?: [number, number, number]; m?: number };
export type Outfit = {
  coat?: string; vest?: string; trousers?: string; boots?: string; hair?: string; skin?: string; beard?: boolean; old?: boolean;
  /** a skirt, robe, gown or long coat: how far it hangs from the waist (metres, up to the floor), how wide at the hem, its colour */
  skirt?: { len: number; flare: number; c: string };
  items: OutfitItem[];
};
const hex = (v: any): string | undefined => (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v : undefined);
const num = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const AT = ["head", "chest", "hips", "back", "hand_r", "hand_l", "feet"];

const HEADGEAR = /\b(hats?|caps?|hoods?|hooded|helmets?|helms?|crowns?|turbans?|veils?|cowls?|bonnets?|tricorn|tricorne|wigs?|headdress|mitre|miter|tiara|circlet|halo|horns?|horned|antlers?|wreath|laurel|scarf|headband|bandana|kippah|yarmulke|feathers?|headcloth|beret|fez|coif|kerchief|topper|bowler|stetson|sombrero|crested|plume|diadem|skullcap|balaclava|hair ?(?:pin|band|bun)|ribbon|flowers? in)\b/i;

export function parseOutfit(text: string, desc?: string): Outfit | null {
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    const j = JSON.parse(text.slice(a, b + 1));
    const items: OutfitItem[] = [];
    for (const q of (Array.isArray(j.items) ? j.items : []).slice(0, 10)) {
      // nothing is worn on the head unless the description says so (a model will add a hat to anyone): it would float over the hair
      if (q?.at === "head" && desc !== undefined && !HEADGEAR.test(desc)) continue;
      if (!AT.includes(q?.at) || !["ell", "box", "cyl", "cone"].includes(q?.s) || !Array.isArray(q?.d)) continue;
      const dn = q.s === "ell" || q.s === "box" ? 3 : 2;
      // on the chest or back a long thin box is a strap or a sash: it runs up the body (y), never out in front of it (z)
      const dd0: number[] = Array.isArray(q.d) ? q.d : [];
      if (q.s === "box" && (q.at === "chest" || q.at === "back") && Number(dd0[2]) > 0.25 && Number(dd0[2]) > 3 * Number(dd0[1]) && !(Array.isArray(q.r) && q.r.some((x: any) => Math.abs(Number(x)) > 0.2))) q.d = [dd0[0], dd0[2], dd0[1]];
      items.push({ at: q.at, s: q.s, d: Array.from({ length: dn }, (_, i) => num(q.d[i], 0.003, 3, 0.05)), c: hex(q.c) ?? "#6a5a48", p: [num(q.p?.[0], -2, 2, 0), num(q.p?.[1], -2, 2, 0), num(q.p?.[2], -2, 2, 0)], r: [num(q.r?.[0], -7, 7, 0), num(q.r?.[1], -7, 7, 0), num(q.r?.[2], -7, 7, 0)], m: q.m ? 1 : 0 });
    }
    const sk = j.skirt && typeof j.skirt === "object" ? { len: num(j.skirt.len, 0.15, 1.05, 0.4), flare: num(j.skirt.flare, 0.14, 0.5, 0.25), c: hex(j.skirt.c) ?? hex(j.coat) ?? "#6a5340" } : undefined;
    return { coat: hex(j.coat), vest: hex(j.vest), trousers: hex(j.trousers), boots: hex(j.boots), hair: hex(j.hair), skin: hex(j.skin), beard: j.beard === true ? true : undefined, old: j.old === true ? true : undefined, skirt: sk, items };
  } catch { return null; }
}

export const outfitSystem = () => `You dress a character for a picture book as data for a 3D figure (about 1.75 m tall, standing on the ground, facing +z). Reply with ONE JSON object only.
{"coat":"#rrggbb","vest":"#rrggbb","trousers":"#rrggbb","boots":"#rrggbb","hair":"#rrggbb","skin":"#rrggbb","beard":bool,"old":bool,"skirt":{"len":0.15-1.05,"flare":0.14-0.5,"c":"#rrggbb"} or omit,"items":[{"at":"head|chest|hips|back|hand_r|hand_l|feet","s":"ell|box|cyl|cone","d":[...],"c":"#rrggbb","p":[x,y,z],"r":[rx,ry,rz],"m":0|1}]}
- coat is the top and sleeves (a robe, jacket, gown), vest shows at the chest, trousers and boots the legs and feet; use the real colours of the period and the description. skin and hair too.
- skirt hangs from the waist: len in metres (0.4 a coat tail, 0.9 a gown, 1.05 a robe to the ankle), flare the hem's radius. Omit it for trousers and short jackets.
- items are anything worn or carried, in metres in the local frame of the joint named by "at" (x across the body, y up, z forward; a strap or sash on the chest is a thin box long in y): head (origin at the base of the skull, y up: a hat or crown sits at y 0.15-0.3), chest, hips (a belt, a scabbard, a purse), back (a satchel, a quiver, a cloak), hand_r and hand_l (origin in the palm: a staff is a cyl running along y, a cutlass a box, a lantern hangs below), feet. d: ell three radii, box three full lengths, cyl and cone [radius, height]. m 1 for metal. 2 to 8 items, only what the description or the period gives them. Put nothing on the head (no hat, cap or hood) unless the description names it.
Examples:
Description: Abram, a tall robed elder, grey beard, desert traveller with a staff -> {"coat":"#8a6a48","vest":"#b49a6a","trousers":"#6a5238","boots":"#4a3a2a","hair":"#c8c4bc","skin":"#b88a64","beard":true,"old":true,"skirt":{"len":1.0,"flare":0.28,"c":"#8a6a48"},"items":[{"at":"head","s":"ell","d":[0.115,0.09,0.12],"c":"#d8cdb0","p":[0,0.16,-0.01]},{"at":"head","s":"ell","d":[0.095,0.17,0.06],"c":"#d8cdb0","p":[0,0.02,-0.1]},{"at":"hand_r","s":"cyl","d":[0.022,1.7],"c":"#5a4128","p":[0,0.1,0]},{"at":"hips","s":"box","d":[0.34,0.05,0.2],"c":"#4a3320","p":[0,0,0]}]}
Description: Captain Flint, a sea captain in a blue coat and tricorn hat, with a cutlass -> {"coat":"#2f3f6a","vest":"#c8b88a","trousers":"#cfc8b0","boots":"#2a211b","hair":"#3a2a1c","skin":"#c99a7a","skirt":{"len":0.45,"flare":0.22,"c":"#2f3f6a"},"items":[{"at":"head","s":"cyl","d":[0.17,0.07],"c":"#1f1f26","p":[0,0.16,0.02]},{"at":"head","s":"cone","d":[0.13,0.08],"c":"#1f1f26","p":[0,0.2,0.02]},{"at":"hips","s":"box","d":[0.05,0.05,0.85],"c":"#b0b4bc","p":[0.17,-0.05,0.0],"r":[1.2,0,0],"m":1},{"at":"hips","s":"box","d":[0.42,0.06,0.12],"c":"#3a2a1c","p":[0,0.02,0]}]}`;

export async function makeOutfit(key: string, desc: string, cacheOnly = false, feedback?: string): Promise<Outfit | null> {
  const k = `${desc}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90) || key;
  try {
    const hit = feedback ? null : await api.cacheGet("outfit", k);
    if (hit) { const o = parseOutfit(hit, desc); if (o) return o; }
    if (cacheOnly) return null;
    const c = await api.llmComplete("author", outfitSystem(), `Description: ${desc}${feedback ? `\nA previous attempt was criticised: ${feedback}. Dress them again, fixing that.` : ""}`);
    const o = parseOutfit(c.text, desc);
    if (o) await api.cachePut("outfit", k, c.text);
    return o;
  } catch { return null; }
}

/** Outfits for several people in ONE model call (cached ones are not asked for again). key -> outfit. */
export async function makeOutfits(list: { key: string; desc: string; feedback?: string }[], cacheOnly = false): Promise<Record<string, Outfit>> {
  const out: Record<string, Outfit> = {};
  const todo: { key: string; desc: string; k: string; feedback?: string }[] = [];
  for (const it of list) {
    const k = `${it.desc}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 90) || it.key;
    try {
      const hit = it.feedback ? null : await api.cacheGet("outfit", k);
      const o = hit ? parseOutfit(hit, it.desc) : null;
      if (o) out[it.key] = o; else todo.push({ ...it, k });
    } catch { todo.push({ ...it, k }); }
  }
  if (!todo.length || cacheOnly) return out;
  try {
    const got = await askMany(outfitSystem(), todo.slice(0, 6).map((t) => ({ name: t.key, ask: t.desc + (t.feedback ? `. A previous attempt was criticised: ${t.feedback}. Dress them again, fixing that.` : "") })));
    for (const t of todo) {
      const item = got[t.key.toLowerCase()];
      const o = item ? parseOutfit(JSON.stringify(item), t.desc) : null;
      if (o) { out[t.key] = o; await api.cachePut("outfit", t.k, JSON.stringify(item)); }
    }
  } catch { /* no model routed, or it failed: the built-in dress stands */ }
  return out;
}
