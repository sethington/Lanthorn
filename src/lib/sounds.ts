// Sounds the engine has no recipe for: the language model writes one as data (layers of noise and tones, shaped by filters and
// envelopes), it is kept for every later book, and audio.ts plays it. Voices and music it cannot make are left silent.
import { api } from "./api";

export type Layer = {
  src: "white" | "pink" | "brown" | "sine" | "triangle" | "square" | "sawtooth";
  f0?: number; f1?: number; // a tone's pitch, gliding from f0 to f1
  filter?: { type: "lowpass" | "highpass" | "bandpass"; f: number; f1?: number; q?: number }; // f1: the filter sweeps there
  at: number; dur: number; attack: number; peak: number;
  n: number; gap: number; jitter: number; // repeats (a gallop, footsteps, a patter)
  verb: boolean;
};
export type Recipe = { layers: Layer[] };

const num = (v: any, lo: number, hi: number, d: number) => { const x = Number(v); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
const SRC = new Set(["white", "pink", "brown", "sine", "triangle", "square", "sawtooth"]);
const FT = new Set(["lowpass", "highpass", "bandpass"]);

export function parseRecipe(text: string): Recipe | null {
  try {
    const a = text.indexOf("{"), b = text.lastIndexOf("}");
    if (a < 0 || b < a) return null;
    const j = JSON.parse(text.slice(a, b + 1));
    if (!Array.isArray(j.layers)) return null;
    const layers: Layer[] = [];
    for (const l of j.layers.slice(0, 6)) {
      if (!SRC.has(l?.src)) continue;
      const f = l.filter && FT.has(l.filter.type) ? { type: l.filter.type, f: num(l.filter.f, 40, 12000, 1000), f1: l.filter.f1 != null ? num(l.filter.f1, 40, 12000, 1000) : undefined, q: num(l.filter.q, 0.1, 12, 0.8) } : undefined;
      layers.push({
        src: l.src, f0: num(l.f0, 20, 12000, 440), f1: l.f1 != null ? num(l.f1, 20, 12000, 440) : undefined, filter: f as Layer["filter"],
        at: num(l.at, 0, 3, 0), dur: num(l.dur, 0.02, 3, 0.3), attack: num(l.attack, 0.002, 1.5, 0.01), peak: num(l.peak, 0.01, 0.5, 0.2),
        n: Math.round(num(l.n, 1, 24, 1)), gap: num(l.gap, 0.03, 2, 0.3), jitter: num(l.jitter, 0, 0.5, 0), verb: !!l.verb,
      });
    }
    return { layers }; // (no layers: a sound this cannot make, kept so it is not asked for again)
  } catch { return null; }
}

const SYSTEM = `You write short sound effects as JSON for a small synthesizer (Web Audio). A sound is a few layers of noise or tones. Reply with ONLY the JSON.

{"layers":[{"src":"white|pink|brown|sine|triangle|square|sawtooth","f0":Hz,"f1":Hz,"filter":{"type":"lowpass|highpass|bandpass","f":Hz,"f1":Hz,"q":n},"at":sec,"dur":sec,"attack":sec,"peak":0.01-0.5,"n":repeats,"gap":sec,"jitter":sec,"verb":bool}]}

- noise (white, pink, brown) is shaped by the filter; tones glide from f0 to f1 (leave f1 out to hold). Filter f1 sweeps the filter there.
- at: start in seconds (0-3); dur: how long each hit rings; attack: rise time; peak: loudness (a quiet detail 0.05, a normal sound 0.2, a blow 0.45).
- n, gap, jitter: repeat the layer (hoofbeats, footsteps, rain on a roof); jitter randomises the timing.
- verb: true sends it through a room's echo (bells, metal, anything in a big space).
- At most 6 layers, 3 seconds in all. Layer a low thump under a bright click for a hit; a short noise burst for a rustle; a sweep for a gust.
- Human voices, singing, speech and music cannot be made: reply {"layers":[]}.

Examples:
"door slams": {"layers":[{"src":"white","filter":{"type":"lowpass","f":700},"at":0,"dur":0.5,"attack":0.004,"peak":0.35,"n":1,"gap":0.3,"jitter":0,"verb":false},{"src":"sine","f0":130,"f1":38,"at":0,"dur":0.6,"attack":0.004,"peak":0.5,"n":1,"gap":0.3,"jitter":0,"verb":false}]}
"rain on the roof": {"layers":[{"src":"white","filter":{"type":"bandpass","f":4200,"q":1.5},"at":0,"dur":0.05,"attack":0.004,"peak":0.12,"n":14,"gap":0.13,"jitter":0.06,"verb":false}]}
"church bell": {"layers":[{"src":"sine","f0":523,"at":0,"dur":1.6,"attack":0.004,"peak":0.12,"n":1,"gap":0.3,"jitter":0,"verb":true},{"src":"sine","f0":784,"at":0.02,"dur":1.6,"attack":0.004,"peak":0.08,"n":1,"gap":0.3,"jitter":0,"verb":true},{"src":"sine","f0":1318,"at":0.04,"dur":1.6,"attack":0.004,"peak":0.06,"n":1,"gap":0.3,"jitter":0,"verb":true}]}
"horse hooves": {"layers":[{"src":"white","filter":{"type":"lowpass","f":500},"at":0,"dur":0.1,"attack":0.004,"peak":0.3,"n":10,"gap":0.22,"jitter":0.02,"verb":false},{"src":"sine","f0":220,"f1":90,"at":0,"dur":0.12,"attack":0.004,"peak":0.2,"n":10,"gap":0.22,"jitter":0.02,"verb":false}]}`;

/** Recipes for these phrases (kept across books). A phrase that fails stays out and may be tried again. */
export async function makeSounds(phrases: string[]): Promise<Record<string, Recipe>> {
  const out: Record<string, Recipe> = {};
  await Promise.all(phrases.slice(0, 6).map(async (ph) => {
    const key = ph.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    try {
      const hit = await api.cacheGet("sound", key);
      if (hit) { const r = parseRecipe(hit); if (r) { out[ph.toLowerCase()] = r; return; } }
      const c = await api.llmComplete("author", SYSTEM, `Sound: ${ph}`);
      const r = parseRecipe(c.text);
      if (r) { out[ph.toLowerCase()] = r; await api.cachePut("sound", key, JSON.stringify(r)); }
    } catch { /* no model routed, or it failed */ }
  }));
  return out;
}
