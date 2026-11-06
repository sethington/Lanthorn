// The picture judge. While you read, it looks at what the world is showing, asks a small vision model whether the picture matches the
// text, and corrects what it can: a shot that is too tight is widened (at once, and every time it is shown again), a cue that keeps failing
// is dropped the next time that place loads. It works on any book because it only uses the text and the picture, and it stops at a budget.
import { reactive } from "vue";
import { usage } from "./usage";

export type JudgeSettings = { on: boolean; cap: number }; // cap: dollars per book (tokens at a rough price when the model reports no cost); 0 = no limit
const SKEY = "lanthorn:judge-settings";
function loadSettings(): JudgeSettings {
  try { const j = JSON.parse(localStorage.getItem(SKEY) ?? "null"); if (j) return { on: j.on !== false, cap: Number(j.cap) >= 0 ? Number(j.cap) : 2 }; } catch { /* default */ }
  return { on: true, cap: 2 };
}
export const judgeSettings = reactive<JudgeSettings>(loadSettings());
export function saveJudgeSettings() { try { localStorage.setItem(SKEY, JSON.stringify(judgeSettings)); } catch { /* optional */ } }

/** Has this book's judge budget run out? */
export function budgetLeft(): boolean {
  if (judgeSettings.cap === 0) return true;
  const t = usage.data.byJob["judge"];
  if (!t) return true;
  const spent = t.cost > 0 ? t.cost : (t.input + t.output + t.cacheWrite + t.cacheRead * 0.1) * 4e-6;
  return spent < judgeSettings.cap;
}
export function judgeSpent(): number {
  const t = usage.data.byJob["judge"];
  return !t ? 0 : t.cost > 0 ? t.cost : (t.input + t.output + t.cacheWrite + t.cacheRead * 0.1) * 4e-6;
}

export type Verdict = { ok: boolean; issues: string[]; note: string; place?: "interior" | "exterior" };
export const ISSUES = ["too_close", "element_missing", "wrong_subject", "too_dark", "empty", "clipped"] as const;

export const RUBRIC =
  'You judge one frame of a 3D illustration that follows a book as it is read. Say if the picture suits the text. A still cannot show motion or change over time: accept any moment of a change. ' +
  'Reply with one JSON object only: {"ok":bool,"issues":[...],"note":"<=12 words","place":"interior|exterior"}. place only when wrong_subject is because the text is indoors but the picture is outdoors, or the reverse: say what the TEXT needs. ' +
  'issues, only from: too_close (subject cut off or a blur of one object), element_missing (the directed element is not visible), wrong_subject (something unrelated dominates), too_dark, empty (just sky or ground), clipped (camera inside or against an object). ' +
  'ok=true when no issue is clear. Do not nitpick details of the text.';

export function parseVerdict(raw: string): Verdict | null {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const issues = Array.isArray(j.issues) ? j.issues.filter((x: unknown) => (ISSUES as readonly string[]).includes(String(x))).map(String) : [];
    return { ok: j.ok !== false && issues.length === 0, issues, note: String(j.note ?? "").slice(0, 120), place: j.place === "interior" || j.place === "exterior" ? j.place : undefined };
  } catch { return null; }
}

/** What a stage cue is meant to look like, in plain words for the judge. */
export function describeCue(c: { k: string; what?: string; how?: string }): string {
  const w = c.what ?? "";
  switch (c.k) {
    case "moon": return `the moon changing phase (${c.how ?? "new to full"})`;
    case "sun": return /red|halt|huge|giant|set|dying|low/.test(c.how ?? "") ? "a huge dull-red sun low on the horizon" : "the sun racing across the sky as a streak of light with a trail";
    case "creature": return `a ${w || "creature"} ${c.how === "circle" ? "circling" : "walking or flying across the view"}`;
    case "grow": return `${w || "things"} springing up around the scene`;
    case "streak": return "white speed lines rushing past the camera";
    case "flash": return `the light flickering (${c.how ?? "strobe"})`;
    case "dim": return c.how === "eclipse" ? "an eclipse: a black disc with a bright ring in a darkened sky" : "the light failing, the scene growing dark";
    case "cam": return `a camera move (${c.how ?? ""})`;
    case "quake": return "the ground shaking";
    default: return c.k;
  }
}

// ---- what the judge has learned about this book: per place and shot, saved
type Memory = { place?: Record<string, "interior" | "exterior">; bright?: Record<string, number>; widen: Record<string, number>; fails: Record<string, number>; done: Record<string, 1>; drop: string[]; stats: Record<string, { ok: number; bad: number }> };
const MKEY = (book: string) => `lanthorn:judge:${book}`;
export const memory = reactive<{ book: string; m: Memory }>({ book: "", m: { widen: {}, fails: {}, done: {}, drop: [], stats: {} } });
export function judgeUseBook(id: string) {
  memory.book = id;
  let m: Memory = { widen: {}, fails: {}, done: {}, drop: [], stats: {} };
  try { const raw = localStorage.getItem(MKEY(id)); if (raw) m = { ...m, ...JSON.parse(raw) }; } catch { /* none */ }
  memory.m = m;
}
function save() { try { localStorage.setItem(MKEY(memory.book), JSON.stringify(memory.m)); } catch { /* optional */ } }
export const alreadyJudged = (key: string) => !!memory.m.done[key];
export const placeFor = (groupKey: string) => memory.m.place?.[groupKey];
export const brightFor = (key: string) => memory.m.bright?.[key] ?? 0;
export const widenFor = (key: string) => memory.m.widen[key] ?? 0;
export const isDropped = (key: string) => memory.m.drop.includes(key);

/** Take a verdict: remember it, and turn its issues into corrections. kind is the cue kind, or "shot". */
export function applyVerdict(key: string, kind: string, v: Verdict, groupKey?: string): boolean {
  const m = memory.m;
  let flipped = false;
  if (!v.ok && v.place && groupKey && kind === "shot" && m.place?.[groupKey] !== v.place) { (m.place ??= {})[groupKey] = v.place; flipped = true; } // the whole place is the wrong kind: make it again
  m.done[key] = 1;
  const s = (m.stats[kind] ??= { ok: 0, bad: 0 });
  if (v.ok) s.ok++; else s.bad++;
  if (!v.ok) {
    if (v.issues.includes("too_dark")) { (m.bright ??= {})[key] = Math.min(1, (m.bright[key] ?? 0) + 0.5); } // a murky frame is lifted, not just widened
    if (v.issues.some((i) => i === "too_close" || i === "clipped" || i === "empty")) m.widen[key] = Math.min(1.5, (m.widen[key] ?? 0) + 0.55);
    if (v.issues.includes("element_missing") || v.issues.includes("wrong_subject")) {
      m.fails[key] = (m.fails[key] ?? 0) + 1;
      if (kind !== "shot") m.widen[key] = Math.min(1.5, (m.widen[key] ?? 0) + 0.4); // maybe the camera just isn't on it: give it more room first
      if (m.fails[key] >= 2 && kind !== "shot" && !m.drop.includes(key)) m.drop.push(key); // twice and still not there: stop showing a broken effect
    }
    delete m.done[key]; // a corrected view is judged again, once more
    if ((m.fails[key] ?? 0) >= 2 || (m.widen[key] ?? 0) >= 1.5) m.done[key] = 1;
  }
  save();
  return flipped;
}
