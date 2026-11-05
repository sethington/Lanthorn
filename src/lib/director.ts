// The director: turns a chapter (sentences) and its scenes into a cutscene timeline, and plays it.
// Pure logic, no DOM and no engine: the world is told what the director decides (scene, shot, progress, fade).
//
// Film-style pacing: every sentence is held long enough to read, the camera, acting and sound cues fall at their
// sentences, and the whole thing advances on its own clock. The viewer can pause, skip a line, or go back.

import type { Act, Scene, Shot } from "./scene";
import type { Sentence } from "./text";

export type Config = {
  /** subtitle reading speed */
  charsPerSec: number;
  minHold: number;
  maxHold: number;
  /** extra breath at a paragraph break */
  paragraphGap: number;
  dissolve: number;
  fade: number;
};
export const DEFAULTS: Config = { charsPerSec: 16, minHold: 1.4, maxHold: 9, paragraphGap: 0.45, dissolve: 0.7, fade: 1.1 };

export type Beat = {
  sentence: number;
  t0: number;
  t1: number;
  scene: number;
  speaker: string; // "" for narration, or a dialogue speaker (possibly "" when unknown: see kind)
  kind: "narration" | "dialogue" | "thought";
};
export type DirShot = Shot & { scene: number; to: number; t0: number; t1: number };
export type Transition = { t: number; kind: "dissolve" | "fade"; d: number; sceneChange: boolean };
export type Cue = { t: number; sentence: number };
export type Timeline = {
  duration: number;
  beats: Beat[];
  scenes: { index: number; from: number; to: number; t0: number; t1: number }[];
  shots: DirShot[];
  transitions: Transition[];
  acting: (Cue & Act)[];
  spots: (Cue & { sound: string })[];
};

const OPEN_QUOTE = /^\s*[“"‘']/;
const TIME_ORDER = ["night", "dawn", "morning", "noon", "afternoon", "dusk"];

export function sentenceSeconds(text: string, c: Config = DEFAULTS): number {
  return Math.min(c.maxHold, Math.max(c.minHold, 0.5 + text.trim().length / c.charsPerSec));
}

/** Shots for a scene that has none: establish wide, then alternate medium and close on the subject, close on dialogue. */
export function autoShots(scene: Scene, sentences: Sentence[]): Shot[] {
  const subject = scene.subjects[0]?.ref ?? "scene";
  const opening: Shot["move"] = scene.camera.motion === "static" ? "push" : (scene.camera.motion as Shot["move"]);
  const shots: Shot[] = [{ from: scene.from, framing: "wide", angle: "eye", focus: "scene", move: opening, into: "cut" }];
  const cycle: Shot["framing"][] = ["medium", "close", "medium", "wide"];
  const moves: Shot["move"][] = ["static", "push", "drift", "static"];
  const angles: Shot["angle"][] = ["eye", "low", "eye", "over_shoulder"];
  let last = scene.from;
  let k = 0;
  for (const s of sentences) {
    if (s.id <= scene.from || s.id > scene.to || s.id - last < 3 || shots.length >= 24) continue;
    const quoted = OPEN_QUOTE.test(s.text);
    const speaker = scene.lines?.find((l) => l.at === s.id)?.speaker;
    const focus = speaker || subject;
    const prev = shots[shots.length - 1];
    let framing: Shot["framing"] = quoted ? "close" : cycle[k % cycle.length];
    let angle = angles[k % angles.length];
    // never cut to the same picture: change the size, or failing that the angle
    if (prev.framing === framing && prev.focus === focus) {
      framing = framing === "close" ? "medium" : framing === "medium" ? "close" : "medium";
      if (prev.angle === angle) angle = angle === "eye" ? "low" : "eye";
    }
    shots.push({ from: s.id, framing, angle, focus, move: moves[k % moves.length], into: "cut" });
    last = s.id;
    k++;
  }
  return shots;
}

/** What kind of change between two scenes: a different place or a jump in time reads as a fade, else a dissolve. */
function sceneTransition(prev: Scene | undefined, next: Scene): "cut" | "dissolve" | "fade" {
  const explicit = next.shots?.[0]?.into;
  if (explicit) return explicit;
  if (!prev || !prev.visual || !next.visual) return "cut";
  const timeJump = TIME_ORDER.indexOf(prev.time.end) !== TIME_ORDER.indexOf(next.time.start) && prev.time.end !== next.time.start;
  if (prev.location !== next.location || timeJump) return "fade";
  return "dissolve";
}

export function buildTimeline(sentences: Sentence[], scenes: Scene[], cfg: Config = DEFAULTS): Timeline {
  const tl: Timeline = { duration: 0, beats: [], scenes: [], shots: [], transitions: [], acting: [], spots: [] };
  const sceneOf = (id: number) => scenes.findIndex((s) => id >= s.from && id <= s.to);
  let t = 0;
  let curScene = -2;
  let prevPara = -1;
  for (const s of sentences) {
    const si = sceneOf(s.id);
    if (si !== curScene) {
      // a new scene: the change between them takes time
      const sc = scenes[si];
      if (curScene >= 0) tl.scenes[tl.scenes.length - 1].t1 = t;
      if (sc && curScene >= 0) {
        const kind = sceneTransition(scenes[curScene], sc);
        if (kind === "fade") { tl.transitions.push({ t: t + cfg.fade / 2, kind: "fade", d: cfg.fade, sceneChange: true }); t += cfg.fade; }
        else if (kind === "dissolve") { tl.transitions.push({ t, kind: "dissolve", d: cfg.dissolve, sceneChange: true }); t += cfg.dissolve * 0.5; }
      }
      curScene = si;
      if (sc) tl.scenes.push({ index: si, from: sc.from, to: sc.to, t0: t, t1: t });
    } else if (s.para !== prevPara && prevPara !== -1) {
      t += cfg.paragraphGap;
    }
    prevPara = s.para;
    const sc = scenes[si];
    const line = sc?.lines?.find((l) => l.at === s.id);
    const quoted = OPEN_QUOTE.test(s.text);
    const kind: Beat["kind"] = line ? line.kind : quoted ? "dialogue" : "narration";
    const dur = sentenceSeconds(s.text, cfg);
    tl.beats.push({ sentence: s.id, t0: t, t1: t + dur, scene: si, speaker: line?.speaker ?? "", kind });
    t += dur;
  }
  if (tl.scenes.length) tl.scenes[tl.scenes.length - 1].t1 = t;
  tl.duration = t;

  const beatStart = new Map(tl.beats.map((b) => [b.sentence, b.t0]));
  for (const sc of tl.scenes) {
    const scene = scenes[sc.index];
    const inScene = sentences.filter((x) => x.id >= scene.from && x.id <= scene.to);
    const list = scene.visual ? (scene.shots?.length ? scene.shots : autoShots(scene, inScene)) : [];
    list.forEach((sh, i) => {
      const t0 = i === 0 ? sc.t0 : (beatStart.get(sh.from) ?? sc.t0);
      const next = list[i + 1];
      const t1 = next ? (beatStart.get(next.from) ?? sc.t1) : sc.t1;
      tl.shots.push({ ...sh, scene: sc.index, to: next ? next.from - 1 : scene.to, t0, t1 });
      if (i > 0 && sh.into !== "cut") tl.transitions.push({ t: t0, kind: sh.into, d: sh.into === "fade" ? cfg.fade : cfg.dissolve, sceneChange: false });
    });
    for (const a of scene.acting ?? []) tl.acting.push({ t: beatStart.get(a.at) ?? sc.t0, sentence: a.at, ...a });
    for (const sp of scene.audio.spots) tl.spots.push({ t: beatStart.get(sp.at) ?? sc.t0, sentence: sp.at, sound: sp.sound });
  }
  tl.transitions.sort((a, b) => a.t - b.t);
  tl.acting.sort((a, b) => a.t - b.t);
  tl.spots.sort((a, b) => a.t - b.t);
  return tl;
}

/** One scene's shots with their span as fractions (0..1) of the scene's running time: what the world's cameras are built from. */
export function shotsForScene(tl: Timeline, sceneIndex: number): { shot: Shot; p0: number; p1: number }[] {
  const sc = tl.scenes.find((s) => s.index === sceneIndex);
  if (!sc) return [];
  const span = Math.max(0.001, sc.t1 - sc.t0);
  return tl.shots
    .filter((x) => x.scene === sceneIndex)
    .map((x) => ({ shot: { from: x.from, framing: x.framing, angle: x.angle, focus: x.focus, move: x.move, into: x.into }, p0: (x.t0 - sc.t0) / span, p1: (x.t1 - sc.t0) / span }));
}

/** Everything the screen and the world need to know at one moment. */
export type Frame = {
  t: number;
  beat: Beat | null;
  beatIndex: number;
  scene: number; // index into scenes, -1 before the first
  sceneProgress: number; // 0..1 through the scene, by time: the world's "narrative" position
  shot: DirShot | null;
  shotIndex: number;
  shotProgress: number; // 0..1 through the shot
  /** 0..1 how dark the screen is (the middle of a fade to black) */
  fade: number;
  done: boolean;
};

export class Player {
  t = 0;
  playing = false;
  speed = 1;
  tl: Timeline;
  constructor(tl: Timeline) {
    this.tl = tl;
  }

  private beatAt(t: number): number {
    const b = this.tl.beats;
    let lo = 0, hi = b.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (b[m].t0 <= t) lo = m; else hi = m - 1; }
    return b.length ? lo : -1;
  }

  at(t = this.t): Frame {
    const tl = this.tl;
    const bi = this.beatAt(t);
    const beat = bi >= 0 ? tl.beats[bi] : null;
    const scene = tl.scenes.find((s) => t >= s.t0 && t < s.t1) ?? (t >= tl.duration ? tl.scenes[tl.scenes.length - 1] : undefined);
    const si = tl.shots.findIndex((s) => t >= s.t0 && t < s.t1);
    const shot = si >= 0 ? tl.shots[si] : null;
    let fade = 0;
    for (const tr of tl.transitions) {
      if (tr.kind !== "fade") continue;
      const d = Math.abs(t - tr.t);
      if (d < tr.d / 2) fade = Math.max(fade, 1 - d / (tr.d / 2));
    }
    for (const tr of tl.transitions) {
      if (tr.kind !== "dissolve") continue;
      const d = Math.abs(t - tr.t);
      if (d < tr.d / 2) fade = Math.max(fade, 0.5 * (1 - d / (tr.d / 2))); // a dissolve reads as a half dip
    }
    return {
      t,
      beat,
      beatIndex: bi,
      scene: scene ? scene.index : -1,
      sceneProgress: scene ? Math.min(1, Math.max(0, (t - scene.t0) / Math.max(0.001, scene.t1 - scene.t0))) : 0,
      shot,
      shotIndex: si,
      shotProgress: shot ? Math.min(1, Math.max(0, (t - shot.t0) / Math.max(0.001, shot.t1 - shot.t0))) : 0,
      fade,
      done: t >= tl.duration,
    };
  }

  play() { if (this.t >= this.tl.duration) this.t = 0; this.playing = true; }
  pause() { this.playing = false; }
  toggle() { this.playing ? this.pause() : this.play(); }
  setSpeed(x: number) { this.speed = Math.min(3, Math.max(0.25, x)); }
  seek(t: number) { this.t = Math.min(this.tl.duration, Math.max(0, t)); }
  seekSentence(id: number) { const b = this.tl.beats.find((x) => x.sentence === id); if (b) this.t = b.t0; }

  /** Skip to the start of the next line. */
  next() {
    const i = this.beatAt(this.t);
    const b = this.tl.beats[Math.min(this.tl.beats.length - 1, i + 1)];
    if (b) this.t = b.t0;
  }
  /** Back: restart the current line, or go to the previous one if it has just begun. */
  prev() {
    const i = this.beatAt(this.t);
    if (i < 0) return;
    const b = this.tl.beats[i];
    this.t = this.t - b.t0 > 1 || i === 0 ? b.t0 : this.tl.beats[i - 1].t0;
  }

  /** Advance by dt real seconds if playing. Returns the new frame. */
  tick(dt: number): Frame {
    if (this.playing) {
      this.t = Math.min(this.tl.duration, this.t + dt * this.speed);
      if (this.t >= this.tl.duration) this.playing = false;
    }
    return this.at();
  }
}
