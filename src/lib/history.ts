// Version history for documents: snapshots of a document's text, kept in the app's own database (IndexedDB), so a document can be taken back to how it
// was. A snapshot is taken when a document is opened, now and then as it is saved, before anything that replaces text wholesale (accepting a rewrite,
// loading the file from disk, restoring a version) and whenever the writer asks (with a name). Identical text is never stored twice in a row.

export type Version = { key?: number; doc: string; t: number; text: string; words: number; reason: string; label?: string };

const DB = "lanthorn-history";
const STORE = "versions";
const KEEP = 80; // per document: past this the oldest unnamed ones go

let dbp: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  if (!dbp) dbp = new Promise((res, rej) => {
    const rq = indexedDB.open(DB, 1);
    rq.onupgradeneeded = () => { const s = rq.result.createObjectStore(STORE, { keyPath: "key", autoIncrement: true }); s.createIndex("doc", "doc"); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
const done = <T>(rq: IDBRequest<T>) => new Promise<T>((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

/** A document's versions, newest first. */
export async function versions(doc: string): Promise<Version[]> {
  try {
    const db = await open();
    const all = await done(db.transaction(STORE).objectStore(STORE).index("doc").getAll(doc)) as Version[];
    return all.sort((a, b) => b.t - a.t || (b.key ?? 0) - (a.key ?? 0));
  } catch { return []; }
}

/** Keep this text as a version (unless it is the same as the newest one, or empty). Returns it, or null when nothing was stored. */
export async function snapshot(doc: string, text: string, reason: string, label?: string): Promise<Version | null> {
  if (!text.trim()) return null;
  try {
    const have = await versions(doc);
    if (have[0] && have[0].text === text && !label) return null;
    if (have[0] && have[0].text === text && label && !have[0].label) { // the newest is this very text: it is named instead of stored again
      const db = await open();
      const v = { ...have[0], label, reason };
      await done(db.transaction(STORE, "readwrite").objectStore(STORE).put(v));
      return v;
    }
    const v: Version = { doc, t: Date.now(), text, words: wordCount(text), reason, ...(label ? { label } : {}) };
    const db = await open();
    v.key = (await done(db.transaction(STORE, "readwrite").objectStore(STORE).add(v))) as number;
    const extra = have.length + 1 - KEEP;
    if (extra > 0) {
      const old = have.filter((x) => !x.label).slice(-extra); // the oldest unnamed ones
      const tx = db.transaction(STORE, "readwrite");
      for (const o of old) tx.objectStore(STORE).delete(o.key!);
    }
    return v;
  } catch { return null; }
}

export async function removeVersion(key: number): Promise<void> {
  try { const db = await open(); await done(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key)); } catch { /* optional */ }
}

/** "3 min ago", "yesterday 14:05", "12 Nov": how long ago, for a list. */
export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  const d = new Date(t), n = new Date(now);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === n.toDateString()) return `today ${hm}`;
  const y = new Date(now - 86400000);
  if (d.toDateString() === y.toDateString()) return `yesterday ${hm}`;
  return `${d.toLocaleDateString([], { day: "numeric", month: "short" })} ${hm}`;
}
