// Props the picture library has no model for: the language model draws each as a small assembly of simple shapes, once, and the result is kept.
import { api } from "./api";

export type Part = { s: "box" | "cyl" | "sphere" | "cone"; p: [number, number, number]; d: number[]; c: string; m?: number; r?: [number, number, number] };

const SYSTEM = `You build a simple 3D prop from basic shapes, in metres, standing on the floor. Reply with one JSON object only: {"parts":[...]} with 2 to 14 parts.
Each part: {"s":"box|cyl|sphere|cone","p":[x,y,z],"d":[...],"c":"#rrggbb","m":0 or 1,"r":[rx,ry,rz]}.
p is the part's centre: x sideways, y up from the floor (0 = floor), z toward the viewer. d is the size: box [width,height,depth] (full lengths), cyl [radius,height], sphere [radius], cone [radius,height]. c is the colour. m is 1 for metal. r is an optional rotation in radians (a cylinder lying on its side is r [0,0,1.5708]).
Make it recognisable and true to size (a tankard is 0.14 m tall, a telescope 0.7 m long, a counter 1.1 m high and 2.5 m wide). Use a few well-placed parts, not many tiny ones. Use period-appropriate materials and colours.`;

const num = (v: unknown, lo: number, hi: number, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function parseParts(text: string): Part[] | null {
  try {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    const j = JSON.parse(text.slice(a, b + 1));
    const out: Part[] = [];
    for (const q of (Array.isArray(j.parts) ? j.parts : []).slice(0, 14)) {
      const s = q?.s;
      if (s !== "box" && s !== "cyl" && s !== "sphere" && s !== "cone") continue;
      const d = (Array.isArray(q.d) ? q.d : []).slice(0, 3).map((x: unknown) => num(x, 0.005, 4, 0.1));
      const need = s === "box" ? 3 : s === "sphere" ? 1 : 2;
      while (d.length < need) d.push(0.1);
      const p = (Array.isArray(q.p) ? q.p : [0, 0, 0]).slice(0, 3).map((x: unknown, i: number) => num(x, i === 1 ? 0 : -3, i === 1 ? 4 : 3));
      while (p.length < 3) p.push(0);
      const r = Array.isArray(q.r) ? q.r.slice(0, 3).map((x: unknown) => num(x, -7, 7)) : undefined;
      out.push({ s, p: p as [number, number, number], d, c: /^#[0-9a-f]{6}$/i.test(String(q.c)) ? String(q.c) : "#6b5a47", m: q.m ? 1 : 0, r: r && r.length === 3 ? (r as [number, number, number]) : undefined });
    }
    return out.length >= 2 ? out : null;
  } catch { return null; }
}

/** Parts for each phrase (cached across books: a tankard is a tankard). Phrases that fail are left out. */
export async function makeProps(phrases: string[]): Promise<Record<string, Part[]>> {
  const out: Record<string, Part[]> = {};
  await Promise.all(phrases.slice(0, 5).map(async (ph) => {
    const key = ph.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    try {
      const hit = await api.cacheGet("prop", key);
      if (hit) { const p = parseParts(hit); if (p) { out[ph.toLowerCase()] = p; return; } }
      const c = await api.llmComplete("scan", SYSTEM, `Prop: ${ph}`);
      const p = parseParts(c.text);
      if (p) { out[ph.toLowerCase()] = p; await api.cachePut("prop", key, c.text); }
    } catch { /* no model routed, or it failed: the prop stays out */ }
  }));
  return out;
}
