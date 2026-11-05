// Dev harness: resolve one scene from a fixture, fetch its assets, render with raea.
// Usage: node --experimental-strip-types scripts/render-scene.ts <fixture.json> <sceneIndex> [frame|all] [outDir]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolveScene } from "../src/lib/resolve.ts";
import { fetchAsset } from "./ph.mjs";

const [fixture, idx, which = "30", out = "/tmp/lanthorn-out"] = process.argv.slice(2);
const fx = JSON.parse(readFileSync(fixture, "utf8"));
const scene = fx.scenes[Number(idx)];
const frames = which === "all" ? undefined : 120;
const r = resolveScene(scene, fx.bible, { frames });
console.log(`scene ${idx} ${scene.id} [${scene.from}-${scene.to}] ${scene.kind} ${scene.location} ${scene.time.start}>${scene.time.end} ${scene.weather}`);
console.log(`  interior=${r.interior} frames=${r.frames} hero=${JSON.stringify(r.hero)} assets=${r.assets.map((a) => a.label + ":" + a.id).join(", ") || "-"}`);
console.log(`  sky night=${r.sky.night.id} dawn=${r.sky.dawn.id} day=${r.sky.day.id} dusk=${r.sky.dusk.id} unresolved=${JSON.stringify(r.unresolved)}`);

const need: [string, string, string][] = [];
for (const s of new Set([r.sky.night.id, r.sky.dawn.id, r.sky.day.id, r.sky.dusk.id])) need.push(["hdri", s, "2k"]);
for (const a of r.assets) need.push(["model", a.id, "1k"]);
if (r.ground) need.push(["texture", r.ground.id, "1k"]);
if (r.room) need.push(["texture", r.room.floor, "1k"]);
for (const [k, id, res] of new Set(need.map((n) => n.join("|"))).values() ? need : []) {
  try { await fetchAsset(k, id, res); } catch (e) { console.log(`  fetch failed ${k} ${id}: ${e}`); }
}

const work = new URL(`../.work/${scene.id}-${scene.from}/`, import.meta.url).pathname;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(new URL("../runtime/scene.tsx", import.meta.url).pathname, work + "scene.tsx");
writeFileSync(work + "scene.json", JSON.stringify(r));
symlinkSync(new URL("../assets", import.meta.url).pathname, work + "media");
mkdirSync(out, { recursive: true });
const args = which === "all" ? ["render", work + "scene.tsx", "-o", out] : ["render", work + "scene.tsx", "--frame", which, "-o", `${out}/scene-${idx}.png`];
const t = Date.now();
const p = spawnSync("raea", args, { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
const log = (p.stdout + p.stderr).split("\n").filter((l) => /APPLIED|REFUSED|rror|panick|failed/i.test(l) && !/WARN|INFO/.test(l));
console.log(`  render ${Date.now() - t}ms:`, log.join("\n  ").slice(0, 600) || "(no status line)");
