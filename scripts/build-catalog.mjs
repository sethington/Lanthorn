// Builds src/catalog/polyhaven.json from Poly Haven's public API (all CC0). Slim: only what the resolver needs.
import { writeFileSync } from "node:fs";

const get = async (t) => (await fetch(`https://api.polyhaven.com/assets?t=${t}`)).json();
const [models, hdris, textures] = await Promise.all([get("models"), get("hdris"), get("textures")]);

const cats = (v) => (v.categories ?? []).filter((c) => !c.startsWith("collection:"));
const out = {
  source: "https://polyhaven.com (CC0)",
  built: new Date().toISOString().slice(0, 10),
  models: Object.entries(models).map(([id, v]) => ({
    id,
    name: v.name,
    tags: v.tags ?? [],
    cats: cats(v),
    // raw dimensions are millimetres; store metres [x, y, z] (y up in the glTF)
    dims: (v.dimensions ?? [0, 0, 0]).map((d) => Math.round(d) / 1000),
    poly: v.polycount ?? 0,
  })),
  hdris: Object.entries(hdris).map(([id, v]) => ({ id, name: v.name, tags: v.tags ?? [], cats: cats(v) })),
  textures: Object.entries(textures).map(([id, v]) => ({ id, name: v.name, tags: v.tags ?? [], cats: cats(v) })),
};
writeFileSync(new URL("../src/catalog/polyhaven.json", import.meta.url), JSON.stringify(out));
console.log(Object.fromEntries(Object.entries(out).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])));
