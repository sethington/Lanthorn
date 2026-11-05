// Checks the director on the example package's real chapter and scenes. Run: npm run test:director
import { readFileSync } from "node:fs";
import { Player, autoShots, buildTimeline, sentenceSeconds } from "../src/lib/director.ts";
import { splitSentences, paragraphsOf } from "../src/lib/text.ts";

const root = new URL("../examples/the-time-machine-iv/", import.meta.url);
const text = readFileSync(new URL("chapters/iv.txt", root), "utf8");
const { scenes } = JSON.parse(readFileSync(new URL("scenes/iv.json", root), "utf8"));
const sentences = splitSentences(paragraphsOf(text));

let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => { console.log(`${cond ? "  ok " : "  FAIL"} ${name}${detail ? `  (${detail})` : ""}`); if (!cond) failed++; };

// the scenes in the file carry no director fields yet (they predate them): this is the "auto-directed" path
const tl = buildTimeline(sentences, scenes);
console.log(`\n${sentences.length} sentences, ${scenes.length} scenes -> ${tl.beats.length} beats, ${tl.shots.length} shots, ${tl.transitions.length} transitions, ${Math.round(tl.duration)} s (${(tl.duration / 60).toFixed(1)} min)\n`);

ok("a beat for every sentence", tl.beats.length === sentences.length);
ok("beats in order, no overlap", tl.beats.every((b, i) => b.t1 > b.t0 && (i === 0 || b.t0 >= tl.beats[i - 1].t1 - 1e-9)));
ok("hold times within limits", tl.beats.every((b) => b.t1 - b.t0 >= 1.4 - 1e-9 && b.t1 - b.t0 <= 9 + 1e-9));
ok("duration equals the last beat's end", Math.abs(tl.duration - tl.beats[tl.beats.length - 1].t1) < 1e-9);
ok("scenes cover the timeline in order", tl.scenes[0].t0 === 0 && tl.scenes.every((s, i) => s.t1 >= s.t0 && (i === 0 || s.t0 >= tl.scenes[i - 1].t1 - 1e-9)));
ok("every visual scene has shots", scenes.every((s: any, i: number) => !s.visual || tl.shots.some((x) => x.scene === i)));
ok("first shot of a scene starts with the scene", tl.scenes.every((sc) => { const f = tl.shots.find((x) => x.scene === sc.index); return !f || Math.abs(f.t0 - sc.t0) < 1e-9; }));
ok("shots tile each scene", tl.scenes.every((sc) => { const sh = tl.shots.filter((x) => x.scene === sc.index); return !sh.length || (sh.every((x, i) => i === 0 || Math.abs(x.t0 - sh[i - 1].t1) < 1e-9) && Math.abs(sh[sh.length - 1].t1 - sc.t1) < 1e-9); }));
ok("scene changes produce transitions", tl.transitions.filter((t) => t.sceneChange).length >= 1, `${tl.transitions.filter((t) => t.sceneChange).map((t) => t.kind).join(",")}`);
ok("dialogue is detected from quotes", tl.beats.some((b) => b.kind === "dialogue"), `${tl.beats.filter((b) => b.kind === "dialogue").length} spoken lines`);
ok("sound cues are placed on the clock", tl.spots.length > 0 && tl.spots.every((s) => s.t >= 0 && s.t <= tl.duration));
ok("longer sentences are held longer", sentenceSeconds("x".repeat(200)) > sentenceSeconds("x".repeat(20)));

// an explicit shot list is honoured
const directed = JSON.parse(JSON.stringify(scenes));
directed[0].shots = [{ from: 0, framing: "wide", angle: "low", focus: "scene", move: "pull", into: "cut" }, { from: 2, framing: "close", angle: "eye", focus: "time_traveller", move: "push", into: "dissolve" }];
directed[0].lines = [{ at: 1, speaker: "time_traveller", kind: "dialogue" }];
const tl2 = buildTimeline(sentences, directed);
const s0 = tl2.shots.filter((x) => x.scene === 0);
ok("explicit shots are used as written", s0.length === 2 && s0[0].angle === "low" && s0[1].framing === "close");
ok("a dissolve inside a scene is a transition", tl2.transitions.some((t) => !t.sceneChange && t.kind === "dissolve"));
ok("a named speaker is kept", tl2.beats[1].speaker === "time_traveller" && tl2.beats[1].kind === "dialogue");
ok("autoShots never repeats the same picture back to back", scenes.every((sc: any) => { const sh = autoShots(sc, sentences); return sh.every((x, i) => i === 0 || x.framing !== sh[i - 1].framing || x.focus !== sh[i - 1].focus || x.angle !== sh[i - 1].angle); }));
ok("autoShots varies the framing", new Set(autoShots(scenes[3], sentences).map((s) => s.framing)).size >= 2);

// the player
const p = new Player(tl);
p.play();
let f = p.tick(0);
ok("starts at the first line", f.beatIndex === 0 && f.scene === 0 && !f.done);
for (let i = 0; i < 100; i++) f = p.tick(0.5); // 50 s
ok("advances on its own clock", f.t > 49 && f.beatIndex > 5);
const mid = p.at(tl.scenes[2].t0 + 1);
ok("scene progress is by time", mid.scene === 2 && mid.sceneProgress > 0 && mid.sceneProgress < 0.5);
const fadeAt = tl.transitions.find((t) => t.kind === "fade");
ok("a fade goes fully dark at its middle", !fadeAt || Math.abs(p.at(fadeAt.t).fade - 1) < 1e-9);
ok("a fade is not dark away from it", !fadeAt || p.at(Math.max(0, fadeAt.t - fadeAt.d)).fade === 0);
p.seek(tl.beats[10].t0 + 0.2); p.next();
ok("next jumps to the following line", Math.abs(p.t - tl.beats[11].t0) < 1e-9);
p.seek(tl.beats[10].t0 + 0.3); p.prev();
ok("prev just after a line starts goes to the previous line", Math.abs(p.t - tl.beats[9].t0) < 1e-9);
p.seek(tl.beats[10].t0 + 1.2); p.prev(); // inside the line (every line holds at least 1.4 s)
ok("prev later in a line restarts it", Math.abs(p.t - tl.beats[10].t0) < 1e-9);
p.seek(tl.duration - 0.01); p.play(); p.tick(1);
ok("playback stops at the end", p.at().done && !p.playing);
p.seekSentence(40);
ok("seekSentence lands on that line", p.at().beat?.sentence === 40);
p.pause(); const before = p.t; p.tick(5);
ok("paused time does not move", p.t === before);
p.setSpeed(2); p.play(); p.tick(1);
ok("speed scales the clock", Math.abs(p.t - (before + 2)) < 1e-9);

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
