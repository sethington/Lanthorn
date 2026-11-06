// A room the recipes don't cover: the language model describes it as data (size, floor, colours, windows, fixtures) and the runtime builds it.
import { api } from "./api";
import { ROOMS, type RoomR } from "./resolve";

export const FLOORS = ["cobblestone_floor_01", "stone_tiles", "marble_tiles", "dark_wooden_planks", "plank_flooring_02", "wood_planks_grey", "wood_floor", "large_floor_tiles_02"];
export const FIXTURES = ["beams", "hearth", "counter", "columns", "shelves", "barrels"];

const exampleOf = (name: string) => { const r = ROOMS.find((x) => x[0] === name)![2]; return JSON.stringify({ w: r.w, d: r.d, h: r.h, floor: r.floor, tile: r.tile, wallC: r.wallC, wain: r.wain ?? null, trim: r.trim, ceilC: r.ceilC, rug: r.rug ?? null, windows: r.windows, pictures: !!r.pictures, door: r.door !== false, firelit: !!r.firelit, fixtures: r.fixtures ?? [] }); };
const SYSTEM = () => `You design the inside of one room for a book's 3D scene. Reply with one JSON object only:
{"w":<width m 3-14>,"d":<depth m 3-12>,"h":<ceiling m 2.2-8>,"floor":"<one of: ${FLOORS.join(", ")}>","tile":<metres per floor-texture repeat 0.8-2.4>,
"wallC":"#rrggbb","wain":"#rrggbb or null (a darker panel on the lower wall)","trim":"#rrggbb","ceilC":"#rrggbb","rug":"#rrggbb or null",
"windows":[{"x":<-0.4..0.4 along the back wall>,"w":<half-width m 0.15-0.9>,"h":<half-height m 0.15-1.4>,"y":<centre height m>}] (0 to 3),
"pictures":bool,"door":bool,"firelit":bool (true when it is lit by flame, not daylight),
"fixtures":[from: ${FIXTURES.join(", ")}] (0 to 4: beams across the ceiling, a hearth on one wall, a long counter, columns, shelves of goods, barrels)}
Fit the place to the text: its size, age, wealth, light and what is in it. Colours should be natural for the materials.\nExamples (real rooms already in use; follow their scale and economy):\nan inn's parlour -> ${exampleOf("tavern")}\na cellar -> ${exampleOf("cellar")}\na study -> ${exampleOf("study")}`;

const hex = (v: unknown, d: string) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v) : d);
const num = (v: unknown, lo: number, hi: number, d: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
export function parseRoom(text: string): RoomR | null {
  try {
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const floor = FLOORS.includes(j.floor) ? j.floor : "wood_floor";
    const wins = (Array.isArray(j.windows) ? j.windows : []).slice(0, 3).map((q: any) => ({ x: num(q?.x, -0.4, 0.4, 0), w: num(q?.w, 0.15, 0.9, 0.4), h: num(q?.h, 0.15, 1.4, 0.5), y: num(q?.y, 0.8, 4, 1.7) }));
    return {
      w: num(j.w, 3, 14, 7), d: num(j.d, 3, 12, 6), h: num(j.h, 2.2, 8, 3), floor, wall: floor, tile: num(j.tile, 0.8, 2.4, 1.6),
      wallC: hex(j.wallC, "#bda98c"), wain: j.wain ? hex(j.wain, "#5c4332") : null, trim: hex(j.trim, "#4a3426"), ceilC: hex(j.ceilC, "#a89a82"), rug: j.rug ? hex(j.rug, "#6b2f2a") : null,
      windows: wins, pictures: !!j.pictures, door: j.door !== false, firelit: !!j.firelit, style: "custom",
      fixtures: (Array.isArray(j.fixtures) ? j.fixtures : []).filter((x: unknown) => FIXTURES.includes(String(x))).slice(0, 4),
    };
  } catch { return null; }
}
const dbg = (kind: string, data: unknown) => { if (import.meta.env.DEV) fetch("/__debug", { method: "POST", body: JSON.stringify({ kind, data }) }).catch(() => {}); };

/** A room for this description (cached: the same place is not designed twice). */
export async function makeRoom(description: string): Promise<RoomR | null> {
  const key = description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 70);
  try {
    const hit = await api.cacheGet("room", key);
    if (hit) { const r = parseRoom(hit); if (r) return r; }
    const c = await api.llmComplete("scan", SYSTEM(), `Room: ${description}`);
    const r = parseRoom(c.text);
    if (r) await api.cachePut("room", key, c.text);
    dbg("room", { description, ok: !!r });
    return r;
  } catch (e) { dbg("room-error", String(e)); return null; }
}
