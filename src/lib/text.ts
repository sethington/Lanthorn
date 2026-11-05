// Pure text helpers: chapter extraction and sentence splitting. No DOM, no Tauri.

export type Sentence = { id: number; para: number; text: string; start: number; end: number };

export function splitSentences(paras: string[]): Sentence[] {
  const out: Sentence[] = [];
  let offset = 0;
  paras.forEach((p, pi) => {
    const parts = p.match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g) ?? [p];
    for (const t of parts) {
      out.push({ id: out.length, para: pi, text: t, start: offset, end: offset + t.length });
      offset += t.length;
    }
  });
  return out;
}

export function paragraphsOf(chapterText: string): string[] {
  return chapterText
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** Small stable string hash (FNV-1a), base36. Used for cache keys, never for security. */
export function hashStr(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}
