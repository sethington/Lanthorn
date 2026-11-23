// The writer's directions (lib/directives.ts), put to use: told to the model that analyses a chapter, applied over what it makes, and handed to the judge.

import { type Directive, type WriterScene, characterId, describeScene, sceneOf } from "./directives";
import type { Bible, Character, Scene } from "./scene";

export type Plan = {
  /** the directions in the order they come, each with the (chapter-local) sentence it comes before */
  events: { sid: number; d: Directive }[];
  characters: { id: string; look: string; kind: "person" | "animal" | "creature" }[];
};

const HUMAN = /\b(man|woman|boy|girl|child|king|queen|prince|princess|sailor|lady|lord|priest|monk|soldier|captain|farmer|doctor|professor|mariner|maid|wife|husband|father|mother|sister|brother)\b/i;
const FEMALE = /\b(she|her|woman|girl|lady|queen|princess|maid|wife|mother|sister|nun|duchess|countess|witch)\b/i;

/** `sidOf(at)`: the local sentence id that paragraph `at` starts with (or the first one after it); the end of the chapter when there is none. */
export function makePlan(dirs: Directive[] | undefined, sidOf: (at: number) => number): Plan | null {
  if (!dirs?.length) return null;
  const events = dirs.map((d) => ({ sid: sidOf(d.at), d }));
  const chars: Plan["characters"] = [];
  for (const { d } of events) {
    if (d.kind !== "character") continue;
    const name = d.attrs.name ?? "";
    const look = (d.attrs.look ?? d.text).trim();
    if (!name || !look) continue;
    const kindAttr = (d.attrs.kind ?? "").toLowerCase();
    const kind: "person" | "animal" | "creature" = kindAttr === "animal" || kindAttr === "creature" || kindAttr === "person" ? kindAttr : HUMAN.test(look) ? "person" : "creature";
    const id = characterId(name);
    const fixed = kind === "person" && !/\b(man|woman|boy|girl)\b/i.test(look) ? `${FEMALE.test(look) ? "woman" : "man"}, ${look}` : look;
    if (!chars.some((c) => c.id === id)) chars.push({ id, look: fixed.slice(0, 160), kind });
  }
  return { events, characters: chars };
}

/** What the writer has fixed at this sentence: the scene directions up to it, each changing what it names and keeping the rest. */
export function activeScene(plan: Plan | null, sid: number): WriterScene | null {
  if (!plan) return null;
  let cur: WriterScene | null = null;
  for (const e of plan.events) {
    if (e.sid > sid) break;
    if (e.d.kind !== "scene") continue;
    cur = e.d.close ? null : { ...(cur ?? {}), ...sceneOf(e.d.attrs) };
  }
  return cur;
}
export const notesIn = (plan: Plan | null, from: number, to: number): string[] => (plan?.events ?? []).filter((e) => e.d.kind === "note" && e.sid >= from && e.sid <= to && e.d.text).map((e) => e.d.text);

/** The author's direction for these sentences, worded for the model; "" when there is none. */
export function promptFor(plan: Plan | null, first: number, last: number): string {
  if (!plan) return "";
  const out: string[] = [];
  const atStart = activeScene(plan, first);
  const here = describeScene(atStart ?? {});
  if (here) out.push(`from [${first}]: ${here}`);
  for (const e of plan.events) {
    if (e.sid <= first || e.sid > last) continue;
    if (e.d.kind === "scene") out.push(e.d.close ? `from [${e.sid}]: (the writer's place ends: read the text freely again)` : `from [${e.sid}]: ${describeScene(activeScene(plan, e.sid) ?? {})}`);
  }
  for (const e of plan.events) if (e.d.kind === "note" && e.sid >= first && e.sid <= last && e.d.text) out.push(`note at [${e.sid}]: ${e.d.text}`);
  return out.join("\n");
}

/** The characters the writer described, as the bible the analysis starts from. */
export function fixedBible(plan: Plan | null): Bible {
  return { characters: (plan?.characters ?? []).map((c) => ({ id: c.id, desc: c.look, kind: c.kind } as Character)), locations: [] };
}

const slugLoc = (s: string) => "writer_" + s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 36);

/** The writer's word laid over what the model made: place, location, time, weather, mood, sky and props are theirs; the scene also carries their words for the judge. */
export function applyWriter(scenes: Scene[], bible: Bible, plan: Plan | null): void {
  if (!plan) return;
  // a character the model gave another id for the same person keeps the writer's description
  for (const c of plan.characters) {
    for (const hit of bible.characters) if (hit.id === c.id || (hit.id.length >= 3 && c.id.length >= 3 && (hit.id.includes(c.id) || c.id.includes(hit.id)))) hit.desc = c.look;
  }
  for (const sc of scenes) {
    const w = activeScene(plan, sc.from);
    const notes = notesIn(plan, sc.from, sc.to);
    if (w) {
      if (w.place) { sc.interior = w.place === "interior"; if (w.place === "exterior" && sc.kind === "interior") sc.kind = "static"; }
      if (w.location) { const id = slugLoc(w.location); if (!bible.locations.some((l) => l.id === id)) bible.locations.push({ id, desc: w.location.slice(0, 120) }); sc.location = id; }
      if (w.start) sc.time = { ...sc.time, start: w.start, end: w.end ?? w.start };
      if (w.weather) sc.weather = w.weather;
      if (w.mood) sc.mood = w.mood;
      if (w.sky || w.light || w.fog) sc.atmosphere = { ...(sc.atmosphere ?? {}), ...(w.sky ? { sky: w.sky } : {}), ...(w.light ? { light: w.light } : {}), ...(w.fog ? { fog: w.fog } : {}) };
      if (w.camera) { sc.camera = { ...sc.camera, framing: w.camera }; if (sc.shots?.length) sc.shots[0] = { ...sc.shots[0], framing: w.camera }; }
      if (w.sound) sc.audio = { ...sc.audio, bed: w.sound };
      if (w.props?.length) sc.props = Array.from(new Set([...w.props, ...sc.props])).slice(0, 8);
    }
    const note = [w ? describeScene(w) : "", ...notes].filter(Boolean).join(" | ");
    if (note || w?.style) sc.writer = { ...(w?.place ? { place: w.place } : {}), ...(w?.style ? { style: w.style } : {}), note: note.slice(0, 500) };
  }
}
