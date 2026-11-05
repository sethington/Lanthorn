#!/usr/bin/env node
// lanthorn: check and pack .lanthorn packages.
//   npm run lanthorn -- check <folder|file.lanthorn>
//   npm run lanthorn -- pack <folder> [-o out.lanthorn]
//   npm run lanthorn -- sentences <chapter.txt>        (the sentence numbers scenes refer to)
// The rules here mirror the app's installer (src-tauri/src/package.rs). The app re-checks everything when it loads a package.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { paragraphsOf, splitSentences } from "../src/lib/text.ts";

const ASSET_EXT = ["gltf", "glb", "bin", "jpg", "jpeg", "png", "webp", "ktx2", "hdr", "exr", "ogg", "wav", "mp3", "json"];
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const KINDS = ["static", "timelapse", "motion", "abstract", "interior"];
const LIMITS = { total: 600 * 1024 * 1024, entry: 200 * 1024 * 1024, text: 8 * 1024 * 1024, scenes: 4 * 1024 * 1024 };

const ext = (p) => (p.includes(".") ? p.split(".").pop().toLowerCase() : "");
const safePath = (p, under) => !!p && !p.startsWith("/") && !p.includes("\\") && p.startsWith(under) && p.split("/").every((s) => s && s !== "." && s !== "..");

function walk(dir, base = dir, out = {}) {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out[p.slice(base.length + 1).split("\\").join("/")] = new Uint8Array(readFileSync(p));
  }
  return out;
}

function load(target) {
  const st = statSync(target);
  if (st.isDirectory()) return walk(target);
  return unzipSync(new Uint8Array(readFileSync(target)));
}

const text = (files, p) => new TextDecoder().decode(files[p]);

/** Returns { errors, warnings, manifest }. */
function check(files) {
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push(m);
  const warn = (m) => warnings.push(m);
  if (!files["manifest.json"]) return { errors: ["No manifest.json at the top of the package."], warnings, manifest: null };
  let m;
  try { m = JSON.parse(text(files, "manifest.json")); } catch (e) { return { errors: [`manifest.json isn't valid JSON: ${e.message}`], warnings, manifest: null }; }

  if (m.format !== "lanthorn" || m.version !== 1) err(`format must be "lanthorn" and version 1 (got ${m.format} v${m.version}).`);
  if (!ID.test(m.id ?? "")) err(`"id" must be lowercase letters, digits, - or _ (max 64), starting with a letter or digit.`);
  if (!m.title || !String(m.title).trim()) err(`"title" is required.`);
  const STYLES = ["cinematic", "storybook", "cartoon", "dream", "noir", "pixel"];
  if (m.style !== undefined && !STYLES.includes(m.style)) err(`"style" must be one of ${STYLES.join(", ")}.`);
  for (const c of m.chapters ?? []) if (c?.style !== undefined && !STYLES.includes(c.style)) err(`chapter "${c.id}": "style" must be one of ${STYLES.join(", ")}.`);
  if (!Array.isArray(m.chapters) || !m.chapters.length) err(`"chapters" needs at least one chapter.`);
  if (!m.license) warn(`No package "license": say what others may do with this package.`);

  let total = 0;
  for (const [p, b] of Object.entries(files)) {
    total += b.length;
    if (b.length > LIMITS.entry) err(`${p} is too large (limit 200 MB per file).`);
    if (!safePath(p, "")) err(`Unsafe path: ${p}`);
  }
  if (total > LIMITS.total) err("The package is over 600 MB unpacked.");

  const assetIds = new Set();
  for (const a of m.assets ?? []) {
    if (!ID.test(a.id ?? "") || assetIds.has(a.id)) err(`asset id "${a.id}" is invalid or repeated.`);
    assetIds.add(a.id);
    if (a.kind !== "model") err(`asset "${a.id}": kind "${a.kind}" isn't supported yet (v1: "model").`);
    if (!a.license || !String(a.license).trim()) err(`asset "${a.id}" needs a "license" (CC0-1.0, CC-BY-4.0, or your own terms).`);
    if (!safePath(a.path, "assets/") || !files[a.path] || !["gltf", "glb"].includes(ext(a.path ?? ""))) err(`asset "${a.id}": path must be a .gltf or .glb under assets/ that exists.`);
    if (a.height === undefined) warn(`asset "${a.id}": no "height" (metres). Models have no real-world scale; it will be treated as 1 m tall.`);
    if (!a.author && !a.source) warn(`asset "${a.id}": add an "author" or "source" so it can be credited.`);
  }
  for (const p of Object.keys(files)) {
    if (p.startsWith("assets/") && !ASSET_EXT.includes(ext(p))) err(`File type not allowed in assets/: ${p} (models, images, skies and sound only; no scripts or programs).`);
  }

  const seen = new Set();
  for (const c of m.chapters ?? []) {
    if (!ID.test(c.id ?? "") || seen.has(c.id)) { err(`chapter id "${c.id}" is invalid or repeated.`); continue; }
    seen.add(c.id);
    if (!c.title) err(`chapter "${c.id}" needs a "title".`);
    if (!safePath(c.text, "chapters/") || !files[c.text] || ![ "txt", "md" ].includes(ext(c.text))) { err(`chapter "${c.id}": text must be a .txt or .md file under chapters/ that exists.`); continue; }
    if (files[c.text].length > LIMITS.text) err(`chapter "${c.id}": text is over 8 MB.`);
    const sentences = splitSentences(paragraphsOf(text(files, c.text)));
    if (sentences.length < 3) warn(`chapter "${c.id}": very short (${sentences.length} sentences).`);
    if (!c.scenes) { warn(`chapter "${c.id}": no scenes file. The app will analyse the text with the reader's model.`); continue; }
    if (!safePath(c.scenes, "scenes/") || !files[c.scenes] || ext(c.scenes) !== "json") { err(`chapter "${c.id}": scenes must be a .json file under scenes/ that exists.`); continue; }
    if (files[c.scenes].length > LIMITS.scenes) err(`chapter "${c.id}": scenes file is over 4 MB.`);
    let sc;
    try { sc = JSON.parse(text(files, c.scenes)); } catch (e) { err(`chapter "${c.id}": scenes file isn't valid JSON: ${e.message}`); continue; }
    const list = sc.scenes;
    if (!Array.isArray(list) || !list.length) { err(`chapter "${c.id}": scenes file needs a non-empty "scenes" array.`); continue; }
    const last = sentences.length - 1;
    let prevTo = -1;
    list.forEach((s, i) => {
      const where = `chapter "${c.id}" scene ${i + 1} (${s.id ?? "no id"})`;
      if (!Number.isInteger(s.from) || !Number.isInteger(s.to) || s.from > s.to) { err(`${where}: "from"/"to" must be sentence numbers with from <= to.`); return; }
      if (s.from < 0 || s.to > last) err(`${where}: sentences ${s.from}-${s.to} are outside this chapter (it has 0-${last}).`);
      if (s.from !== prevTo + 1) warn(`${where}: starts at ${s.from} but the previous scene ended at ${prevTo}. The app will close gaps, but scenes should tile the chapter.`);
      prevTo = s.to;
      if (s.kind && !KINDS.includes(s.kind)) warn(`${where}: unknown kind "${s.kind}" (use ${KINDS.join(", ")}).`);
      for (const b of s.beats ?? []) if (!(b.at >= s.from && b.at <= s.to)) warn(`${where}: a beat at ${b.at} is outside the scene.`);
      for (const sp of s.audio?.spots ?? []) if (!(sp.at >= s.from && sp.at <= s.to)) warn(`${where}: a sound cue at ${sp.at} is outside the scene.`);
      for (const pl of s.place ?? []) if (!assetIds.has(pl.asset)) err(`${where}: "place" names asset "${pl.asset}", which isn't in the manifest.`);
    });
    if (prevTo !== last) warn(`chapter "${c.id}": scenes end at sentence ${prevTo} but the chapter ends at ${last}.`);
  }
  return { errors, warnings, manifest: m };
}

function report(label, r) {
  console.log(`\n${label}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  for (const e of r.errors) console.log(`  ERROR:   ${e}`);
  if (!r.errors.length) console.log(`  ok${r.warnings.length ? ` (${r.warnings.length} warning${r.warnings.length > 1 ? "s" : ""})` : ""}`);
}

const [cmd, target, ...rest] = process.argv.slice(2);
if (cmd === "check" && target) {
  const r = check(load(resolve(target)));
  report(target, r);
  process.exit(r.errors.length ? 1 : 0);
} else if (cmd === "pack" && target) {
  const dir = resolve(target);
  const files = walk(dir);
  const r = check(files);
  report(target, r);
  if (r.errors.length) { console.log("\nNot packed: fix the errors above."); process.exit(1); }
  const oi = rest.indexOf("-o");
  const out = resolve(oi >= 0 ? rest[oi + 1] : join(dirname(dir), `${r.manifest.id}.lanthorn`));
  mkdirSync(dirname(out), { recursive: true });
  const ordered = { "manifest.json": files["manifest.json"], ...files };
  writeFileSync(out, zipSync(ordered, { level: 6 }));
  console.log(`\nWrote ${out} (${(statSync(out).size / 1024 / 1024).toFixed(2)} MB, ${Object.keys(files).length} files)`);
} else if (cmd === "sentences" && target) {
  const s = splitSentences(paragraphsOf(readFileSync(resolve(target), "utf8")));
  for (const x of s) console.log(`[${x.id}] ${x.text.trim().replace(/\s+/g, " ")}`);
  console.error(`\n${s.length} sentences (0-${s.length - 1})`);
} else {
  console.log(`lanthorn: check and pack .lanthorn packages

  npm run lanthorn -- check <folder|file.lanthorn>
  npm run lanthorn -- pack <folder> [-o out.lanthorn]
  npm run lanthorn -- sentences <chapter.txt>`);
  process.exit(cmd ? 1 : 0);
}
