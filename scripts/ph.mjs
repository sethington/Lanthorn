// Poly Haven fetcher (CC0). Library + CLI: node scripts/ph.mjs model|hdri|texture <id> [res]
// Downloads into assets/polyhaven/<id>/ keeping the glTF's relative include paths, and writes license.json.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = new URL("../assets/polyhaven/", import.meta.url).pathname;

export async function fetchAsset(kind, id, res = "1k") {
  const dir = join(root, id);
  if (existsSync(join(dir, "license.json"))) return dir; // already complete
  const files = await (await fetch(`https://api.polyhaven.com/files/${id}`)).json();
  async function get(url, dest) {
    if (existsSync(dest)) return;
    mkdirSync(dirname(dest), { recursive: true });
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  }
  const lic = (main) => writeFileSync(join(dir, "license.json"), JSON.stringify({ id, source: `https://polyhaven.com/a/${id}`, license: "CC0-1.0", main }));
  if (kind === "model") {
    const g = files.gltf?.[res]?.gltf;
    if (!g) throw new Error(`no gltf at ${res} for ${id}`);
    const name = g.url.split("/").pop();
    await get(g.url, join(dir, name));
    for (const [rel, f] of Object.entries(g.include ?? {})) await get(f.url, join(dir, rel));
    lic(name);
  } else if (kind === "hdri") {
    const h = files.hdri?.[res]?.hdr;
    if (!h) throw new Error(`no hdr at ${res} for ${id}`);
    const name = h.url.split("/").pop();
    await get(h.url, join(dir, name));
    lic(name);
  } else if (kind === "texture") {
    for (const [key, out] of [["Diffuse", "diff.jpg"], ["nor_gl", "nor.jpg"], ["arm", "arm.jpg"]]) {
      const u = files[key]?.[res]?.jpg?.url;
      if (!u) throw new Error(`no ${key} at ${res} for ${id}`);
      await get(u, join(dir, out));
    }
    lic("diff.jpg");
  } else throw new Error("kind must be model|hdri|texture");
  return dir;
}

if (process.argv[1] && process.argv[1].endsWith("ph.mjs")) {
  const [kind, id, res] = process.argv.slice(2);
  const dir = await fetchAsset(kind, id, res);
  console.log(`${kind} ${id} -> ${dir}`);
}
