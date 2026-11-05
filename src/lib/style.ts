// Looks: the whole picture's style. Picked per book from its text (the book-scan model when one is set up, a keyword heuristic
// otherwise) and always overridable by the reader. The runtime (runtime/scene.tsx) draws each one.
import { ref } from "vue";
import type { Book } from "./book";

export const STYLES = [
  { id: "cinematic", label: "Cinematic", blurb: "filmic realism: epics, adventure, drama, war, the sea" },
  { id: "storybook", label: "Storybook", blurb: "soft painted illustration: fairy tales, children's books, pastoral" },
  { id: "cartoon", label: "Cartoon", blurb: "bold ink lines and flat colour: comedy, nonsense, lively adventure" },
  { id: "dream", label: "Dream", blurb: "misty pastel paint with glow: fantasy, romance, reverie, the uncanny" },
  { id: "noir", label: "Noir", blurb: "ink and paper engraving: mystery, crime, horror, gothic" },
  { id: "pixel", label: "Pixel", blurb: "world-fixed pixel art: fables, quests, games, retro science fiction" },
] as const;
export type StyleId = (typeof STYLES)[number]["id"];
export const DEFAULT_STYLE: StyleId = "cinematic";
export const isStyle = (x: unknown): x is StyleId => STYLES.some((s) => s.id === x);
export const styleLabel = (id: string) => STYLES.find((s) => s.id === id)?.label ?? id;

/** Words that point at a look, counted per thousand words of the sample. */
const WORDS: Record<StyleId, string[]> = {
  noir: ["murder", "detective", "ghost", "grave", "blood", "corpse", "horror", "crime", "inspector", "dread", "sinister", "haunted", "shadow", "dagger", "secret", "gloom", "coffin", "dead", "terror", "fog"],
  storybook: ["once upon", "fairy", "princess", "little", "garden", "rabbit", "mother", "cottage", "meadow", "kitten", "wee", "dear", "story", "pretty", "merry", "grandmother", "village", "forest"],
  cartoon: ["laughed", "silly", "funny", "nonsense", "ridiculous", "absurd", "grinned", "giggled", "mischief", "prank", "joke", "comical", "tumbled", "hurrah", "bounced"],
  dream: ["dream", "moon", "stars", "magic", "enchanted", "mist", "wonder", "whispered", "twilight", "fairyland", "spell", "slumber", "ethereal", "reverie", "glimmer", "phantom"],
  pixel: ["quest", "kingdom", "dragon", "knight", "robot", "machine", "computer", "level", "sorcerer", "treasure", "dungeon", "wizard", "mechanical", "engine"],
  cinematic: ["battle", "ship", "sea", "war", "empire", "expedition", "voyage", "desert", "army", "captain", "storm", "mountain", "journey", "ocean", "king", "revolution"],
};

/** A sample of the book that is cheap to send and tells its genre: title, author, the opening, and a slice of the middle and the end. */
export function sampleOf(b: Book, max = 3200): string {
  const all = b.chapters.map((c) => c.text).join("\n\n");
  if (all.length <= max) return all;
  const part = Math.floor((max * 0.5));
  const mid = Math.floor(all.length / 2);
  return `${all.slice(0, part)}\n…\n${all.slice(mid, mid + Math.floor(max * 0.3))}\n…\n${all.slice(all.length - Math.floor(max * 0.2))}`;
}

/** No model needed: the look whose words turn up most (default cinematic when nothing stands out). */
export function heuristicStyle(b: Book): { id: StyleId; reason: string } {
  const text = ` ${b.title} ${sampleOf(b, 6000)} `.toLowerCase();
  const n = Math.max(1, text.split(/\s+/).length) / 1000;
  let best: StyleId = DEFAULT_STYLE;
  let bestScore = 0;
  let hits: string[] = [];
  for (const id of Object.keys(WORDS) as StyleId[]) {
    const found = WORDS[id].filter((w) => text.includes(` ${w}`) || text.includes(w + " "));
    const score = (found.reduce((a, w) => a + (text.split(w).length - 1), 0) / n) * (id === "cinematic" ? 0.7 : 1);
    if (score > bestScore) { bestScore = score; best = id; hits = found.slice(0, 3); }
  }
  if (bestScore < 1.2) return { id: DEFAULT_STYLE, reason: "no strong genre signal" };
  return { id: best, reason: `words like ${hits.join(", ")}` };
}

export const STYLE_SYSTEM = `Role: art director for a book reader. Input: a book's title, author and text excerpts. Choose the one visual style that best suits the book's genre, tone and era. Output one JSON object, no prose, no code fence:
{"style":"cinematic|storybook|cartoon|dream|noir|pixel","reason":"<=12 words"}
Styles: ${STYLES.map((s) => `${s.id} = ${s.blurb}`).join("; ")}.
Prefer cinematic only when nothing more characteristic fits.`;

export function styleUser(b: Book): string {
  return `title: ${b.title}\nauthor: ${b.author || "unknown"}\nexcerpts:\n${sampleOf(b)}`;
}

export function parseStyle(text: string): { id: StyleId; reason: string } | null {
  try {
    const t = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
    const o = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1));
    if (isStyle(o?.style)) return { id: o.style, reason: String(o.reason ?? "").slice(0, 120) };
  } catch { /* not JSON */ }
  return null;
}

const overrideKey = (bookId: string) => `lanthorn:style:${bookId}`;
export function getOverride(bookId: string): StyleId | null {
  try { const v = localStorage.getItem(overrideKey(bookId)); return isStyle(v) ? v : null; } catch { return null; }
}
export function setOverride(bookId: string, id: StyleId | null) {
  try { if (id) localStorage.setItem(overrideKey(bookId), id); else localStorage.removeItem(overrideKey(bookId)); } catch { /* optional */ }
}

// ---- the reader's choices, most specific first: chapter, book, default. (Then the package's, then the picked.)
const chapterKey = (bookId: string, chapterId: string) => `lanthorn:style:${bookId}:${chapterId}`;
export function getChapterOverride(bookId: string, chapterId: string): StyleId | null {
  try { const v = localStorage.getItem(chapterKey(bookId, chapterId)); return isStyle(v) ? v : null; } catch { return null; }
}
export function setChapterOverride(bookId: string, chapterId: string, id: StyleId | null) {
  try { if (id) localStorage.setItem(chapterKey(bookId, chapterId), id); else localStorage.removeItem(chapterKey(bookId, chapterId)); } catch { /* optional */ }
}
const DEFAULT_KEY = "lanthorn:style-default";
const readDefault = (): StyleId | null => { try { const v = localStorage.getItem(DEFAULT_KEY); return isStyle(v) ? v : null; } catch { return null; } };
/** The reader's default look for every book (null: each book picks its own). Shared, so Settings and the reader stay in step. */
export const defaultStyle = ref<StyleId | null>(readDefault());
export function setDefaultStyle(id: StyleId | null) {
  defaultStyle.value = id;
  try { if (id) localStorage.setItem(DEFAULT_KEY, id); else localStorage.removeItem(DEFAULT_KEY); } catch { /* optional */ }
}

export type StyleSource = "chapter" | "book" | "default" | "package-chapter" | "package" | "picked";
export function effectiveStyle(o: { chapter: StyleId | null; book: StyleId | null; def: StyleId | null; pkgChapter?: string; pkgBook?: string; picked: StyleId }): { id: StyleId; source: StyleSource } {
  if (o.chapter) return { id: o.chapter, source: "chapter" };
  if (o.book) return { id: o.book, source: "book" };
  if (o.def) return { id: o.def, source: "default" };
  if (isStyle(o.pkgChapter)) return { id: o.pkgChapter, source: "package-chapter" };
  if (isStyle(o.pkgBook)) return { id: o.pkgBook, source: "package" };
  return { id: o.picked, source: "picked" };
}
