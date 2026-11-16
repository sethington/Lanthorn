// Asking the model for several things at once. Every call carries a large fixed overhead (the instructions and the examples), so a scene's
// creatures, outfits or props are written in ONE call and each kept separately in the cache: a scene costs three calls, not a dozen.
import { api } from "./api";

export function jsonOf(text: string): any | null {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}

/** One call for all of `items`; the entries that came back, by lower-cased name. */
export async function askMany(system: string, items: { name: string; ask: string }[], job: "author" | "design" = "author"): Promise<Record<string, any>> {
  const user = items.map((it, i) => `${i + 1}. ${it.name}: ${it.ask}`).join("\n") +
    '\n\nReply with ONE JSON object only: {"items":[{"name":"<the name before the colon, exactly>", ...the fields described above...}, ...]} with one entry per numbered item, in order. Each entry is a complete design on its own.';
  const c = await api.llmComplete(job, system, user);
  const j = jsonOf(c.text);
  const out: Record<string, any> = {};
  for (const it of Array.isArray(j?.items) ? j.items : j && typeof j.name === "string" ? [j] : []) if (typeof it?.name === "string") out[it.name.toLowerCase()] = it;
  return out;
}
