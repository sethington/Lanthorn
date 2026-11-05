// .lanthorn packages. The Rust side validates and unpacks the archive (paths, sizes, file types, manifest); here we turn
// what it returns into a Book. Packages carry data only: text, scenes (JSON) and bundled models. No author code runs.

import { api } from "../api";
import { type Book, type Chapter, type PackageAsset, makeChapter } from "../book";

export async function importLanthorn(bytes: Uint8Array, filename: string): Promise<Book> {
  const inst = await api.packageInstall(bytes);
  const m = inst.manifest;
  const chapters: Chapter[] = m.chapters.map((def, i) => {
    const loaded = inst.chapters.find((c) => c.id === def.id);
    const ch = makeChapter(i, def.title, loaded?.text ?? "", def.num);
    ch.id = def.id;
    if (def.style) ch.style = def.style;
    if (loaded?.scenes) {
      try { ch.scenes = JSON.parse(loaded.scenes); } catch { /* bad scenes file: fall back to analysing the text */ }
    }
    return ch;
  });
  const assets: PackageAsset[] = m.assets.map((a) => ({
    id: a.id, kind: a.kind, file: `pkg/${m.id}/${a.path}`, tags: a.tags ?? [], height: a.height, license: a.license, author: a.author, source: a.source,
  }));
  return {
    id: `pkg-${m.id}`, // stable: loading the same package again replaces it
    title: m.title,
    author: m.author ?? "",
    source: { kind: "lanthorn", ref: filename },
    chapters,
    package: { id: m.id, license: m.license, creator: m.creator, description: m.description, style: m.style, assets },
    imported: Date.now(),
  };
}
