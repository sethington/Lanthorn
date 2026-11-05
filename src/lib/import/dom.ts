// Shared: turn an HTML/XHTML document into plain paragraphs. We only ever read textContent; nothing is rendered or run.

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,pre,dd,dt,blockquote";

export const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function parseDoc(markup: string): Document {
  const p = new DOMParser();
  const x = p.parseFromString(markup, "application/xhtml+xml");
  if (!x.querySelector("parsererror")) return x;
  return p.parseFromString(markup, "text/html");
}

/** Leaf blocks in reading order: a block that contains another block is skipped, its children are taken instead. */
export function leafBlocks(root: Element): Element[] {
  for (const bad of Array.from(root.querySelectorAll("script,style,nav,svg,noscript,iframe,template"))) bad.remove();
  return Array.from(root.querySelectorAll(BLOCKS)).filter((el) => !el.querySelector(BLOCKS));
}

export function paragraphsFrom(root: Element): string[] {
  return leafBlocks(root).map((el) => norm(el.textContent ?? "")).filter(Boolean);
}
