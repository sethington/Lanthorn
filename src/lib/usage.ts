// Tokens the model has used, counted from what each call reports. Kept per book (and per chapter) in localStorage; cached replies cost nothing and are not counted.
import { reactive } from "vue";

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
export type Tally = Usage & { calls: number };
const zero = (): Tally => ({ calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
type Store = { total: Tally; byJob: Record<string, Tally>; byChapter: Record<string, Tally> };

const KEY = (book: string) => `lanthorn:usage:${book}`;
export const usage = reactive<{ book: string; data: Store }>({ book: "", data: { total: zero(), byJob: {}, byChapter: {} } });

function load(book: string): Store {
  try { const raw = localStorage.getItem(KEY(book)); if (raw) return { total: zero(), byJob: {}, byChapter: {}, ...JSON.parse(raw) }; } catch { /* none */ }
  return { total: zero(), byJob: {}, byChapter: {} };
}
function save() { try { localStorage.setItem(KEY(usage.book), JSON.stringify(usage.data)); } catch { /* optional */ } }
function add(t: Tally, u: Usage) { t.calls++; t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite; t.cost += u.cost; }

/** Which book new usage counts toward. */
export function useBook(id: string) { usage.book = id; usage.data = load(id); }
/** Count one model call (every call goes through here via the api wrapper). */
export function recordUsage(job: string, u: Usage | undefined) {
  if (!u || !usage.book) return;
  add(usage.data.total, u);
  add((usage.data.byJob[job] ??= zero()), u);
  save();
}
/** ...and say which chapter it was for (the chapter's text hash). */
export function recordChapterUsage(chapterKey: string, u: Usage | undefined) {
  if (!u || !usage.book) return;
  add((usage.data.byChapter[chapterKey] ??= zero()), u);
  save();
}
export const tokensOf = (t?: Usage) => (t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0);
export function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
}
