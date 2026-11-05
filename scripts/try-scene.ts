// Dev check: run the real scene prompt against a chapter through the claude CLI and validate the reply.
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { splitSentences, paragraphsOf } from "../src/lib/text.ts";
import { SYSTEM, buildUser, extractJson, validateChunk, endState } from "../src/lib/scene.ts";

const model = process.argv[2] ?? "sonnet";
const count = Number(process.argv[3] ?? 40);
const raw = readFileSync(new URL("../books/time-machine.txt", import.meta.url), "utf8").replace(/\r/g, "");
const a = raw.search(/\n IV\.\n/);
const b = raw.search(/\n V\.\n/);
const chapter = raw.slice(a, b).replace(/^\n IV\.\n\s*Time Travelling\n/, "");
const sentences = splitSentences(paragraphsOf(chapter)).slice(0, count);
const user = buildUser({ characters: [], locations: [] }, null, sentences);

const t = Date.now();
const r = spawnSync("claude", ["-p", "--model", model, "--tools", "", "--no-session-persistence", "--setting-sources", "", "--output-format", "json", "--system-prompt", SYSTEM], { input: user, encoding: "utf8", cwd: "/tmp", maxBuffer: 20_000_000 });
const out = JSON.parse(r.stdout);
console.log({ model: Object.keys(out.modelUsage ?? {}), cost: out.total_cost_usd, ms: Date.now() - t, error: out.is_error });
if (out.is_error) { console.log(out.result); process.exit(1); }
const chunk = validateChunk(extractJson(out.result), sentences[0].id, sentences[sentences.length - 1].id, { characters: [], locations: [] });
console.log("bible:", JSON.stringify(chunk.bible));
for (const s of chunk.scenes) console.log(`${s.id} [${s.from}-${s.to}] visual=${s.visual} kind=${s.kind} loc=${s.location} time=${s.time.start}->${s.time.end}/${s.time.progression} mood=${s.mood} beats=${s.beats.length} spots=${s.audio.spots.length} conf=${s.confidence}`);
console.log("end:", endState(chunk.scenes[chunk.scenes.length - 1]));
console.log("first scene full:", JSON.stringify(chunk.scenes[0], null, 1));
