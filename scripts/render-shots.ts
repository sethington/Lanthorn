// Dev check: render the middle of every shot in one scene, to see the director's cuts. Usage:
//   node --experimental-strip-types scripts/render-shots.ts <sceneIndex> <outDir>
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { buildTimeline, shotsForScene } from "../src/lib/director.ts";
import { resolveScene } from "../src/lib/resolve.ts";
import { paragraphsOf, splitSentences } from "../src/lib/text.ts";
import { fetchAsset } from "./ph.mjs";

const [idxArg, out = "/tmp/lanthorn-shots"] = process.argv.slice(2);
const idx = Number(idxArg);
const root = new URL("../examples/the-time-machine-iv/", import.meta.url);
const sentences = splitSentences(paragraphsOf(readFileSync(new URL("chapters/iv.txt", root), "utf8")));
const fx = JSON.parse(readFileSync(new URL("scenes/iv.json", root), "utf8"));
const tl = buildTimeline(sentences, fx.scenes);
const scene = fx.scenes[idx];
const shots = shotsForScene(tl, idx);
const FRAMES = 200;
const r = resolveScene(scene, fx.bible, { frames: FRAMES, shots });
console.log(`scene ${idx} ${scene.id} [${scene.from}-${scene.to}] ${scene.location} ${scene.time.start}>${scene.time.end}: ${shots.length} shots`);
for (const s of shots) console.log(`  p ${s.p0.toFixed(2)}-${s.p1.toFixed(2)}  ${s.shot.framing.padEnd(13)} ${s.shot.angle.padEnd(9)} focus=${s.shot.focus.padEnd(16)} move=${s.shot.move} into=${s.shot.into}`);

const need: [string, string, string][] = [];
for (const s of new Set([r.sky.night.id, r.sky.dawn.id, r.sky.day.id, r.sky.dusk.id])) need.push(["hdri", s, "2k"]);
for (const a of r.assets) if (!a.id.startsWith("pkg:")) need.push(["model", a.id, "1k"]);
if (r.ground) need.push(["texture", r.ground.id, "1k"]);
if (r.room) need.push(["texture", r.room.floor, "1k"]);
for (const t of r.textures) need.push(["texture", t, "1k"]);
for (const [k, id, res] of need) { try { await fetchAsset(k, id, res); } catch (e) { console.log(`  fetch failed ${k} ${id}`); } }

const work = new URL(`../.work/shots-${idx}/`, import.meta.url).pathname;
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
copyFileSync(new URL("../runtime/scene.tsx", import.meta.url).pathname, work + "scene.tsx");
writeFileSync(work + "scene.json", JSON.stringify(r));
symlinkSync(new URL("../assets", import.meta.url).pathname, work + "media");
mkdirSync(out, { recursive: true });
shots.forEach((s, i) => {
  const p = (s.p0 + s.p1) / 2;
  const frame = Math.round(p * (FRAMES - 1));
  const png = `${out}/s${idx}-shot${i}-${s.shot.framing}.png`;
  const res = spawnSync("raea", ["render", work + "scene.tsx", "--frame", String(frame), "-o", png], { encoding: "utf8", env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` } });
  console.log(`  shot ${i} -> ${png.split("/").pop()}  ${/APPLIED/.test(res.stdout + res.stderr) ? "ok" : "FAILED " + (res.stdout + res.stderr).split("\n").filter((l) => /rror|REFUSED/.test(l)).join(" ").slice(0, 200)}`);
});
