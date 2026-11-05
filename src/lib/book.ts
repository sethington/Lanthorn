// The one shape every importer produces. Text only: imported content is untrusted, so no HTML is ever kept or rendered.

import { hashStr, paragraphsOf } from "./text";

export type Chapter = {
  id: string;
  num?: string; // "IV", "Chapter 3", or empty
  title: string;
  /** The chapter body exactly as imported. Its hash identifies the chapter in the analysis and render caches. */
  text: string;
  paragraphs: string[];
  /** Pre-made scenes shipped in a package ({ scenes, bible }, the same shape the LLM pass produces): skips analysis. */
  scenes?: unknown;
  /** the look a package recommends for this chapter (the reader's choice wins) */
  style?: string;
};

export type PackageAsset = { id: string; kind: string; file: string; tags: string[]; height?: number; license: string; author?: string; source?: string };
export type PackageInfo = { id: string; license?: string; creator?: string; description?: string; style?: string; assets: PackageAsset[] };

export type Book = {
  id: string;
  title: string;
  author: string;
  source: { kind: "epub" | "text" | "markdown" | "html" | "url" | "lanthorn"; ref: string };
  package?: PackageInfo;
  chapters: Chapter[];
  imported: number;
};

export type BookMeta = { id: string; title: string; author: string; chapters: number; updated: number; kind?: string };

export const MAX_IMPORT_BYTES = 60 * 1024 * 1024;

export function makeChapter(index: number, title: string, text: string, num?: string): Chapter {
  return { id: `c${index + 1}`, num, title: title.trim(), text, paragraphs: paragraphsOf(text) };
}

export function makeBook(partial: { title: string; author?: string; source: Book["source"]; chapters: Chapter[] }): Book {
  const id = `${slug(partial.title)}-${hashStr(partial.chapters.map((c) => c.text.slice(0, 400)).join("|") + partial.chapters.length)}`;
  return { id, title: partial.title.trim() || "Untitled", author: (partial.author ?? "").trim(), source: partial.source, chapters: partial.chapters, imported: Date.now() };
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "book";
}

export function wordCount(b: Book): number {
  return b.chapters.reduce((n, c) => n + c.text.split(/\s+/).length, 0);
}
