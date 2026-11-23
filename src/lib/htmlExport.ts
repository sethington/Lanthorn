// A document as one self-contained web page: its Markdown rendered, its pictures embedded (so the file can be sent or moved on its own), with a quiet
// readable style that follows the reader's light or dark setting and prints cleanly.

import { loadImage, type Img } from "./images";
import { md, stripDirectives } from "./markdown";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const dataUrl = (img: Img) => {
  let bin = "";
  for (let i = 0; i < img.bytes.length; i += 0x8000) bin += String.fromCharCode(...img.bytes.subarray(i, i + 0x8000));
  return `data:${img.mime};base64,${btoa(bin)}`;
};

const CSS = `:root{color-scheme:light dark;--bg:#fbfaf7;--ink:#1d1d1f;--mute:#6b6b70;--accent:#2b4a7a;--rule:#dcdad3;--code:#f0eee8}
@media(prefers-color-scheme:dark){:root{--bg:#15171b;--ink:#e6e4de;--mute:#97979d;--accent:#8fb0e6;--rule:#2d3037;--code:#1f2227}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:18px/1.7 Georgia,"Iowan Old Style","Times New Roman",serif}
main{max-width:42rem;margin:0 auto;padding:3.5rem 1.4rem 6rem}
h1,h2,h3,h4{font-family:-apple-system,"Helvetica Neue",Arial,sans-serif;line-height:1.25;margin:2em 0 .5em}h1{font-size:2.1rem;margin-top:0}
a{color:var(--accent)}img{max-width:100%;height:auto;border-radius:4px}
blockquote{margin:1.2em 0;padding:.1em 1.1em;border-left:3px solid var(--accent);color:var(--mute)}
code,pre{font:.85em ui-monospace,Menlo,monospace;background:var(--code);border-radius:4px}code{padding:.1em .3em}pre{padding:1em;overflow:auto}pre code{padding:0;background:none}
table{border-collapse:collapse;width:100%;font-size:.92em}th,td{border-bottom:1px solid var(--rule);padding:.4em .6em;text-align:left}
hr{border:0;border-top:1px solid var(--rule);margin:2.4em 0}
.mdfig{display:block;margin:1.4em 0;text-align:center}.mdcap{display:block;margin-top:.5em;font-size:.85em;font-style:italic;color:var(--mute)}.imgmiss{color:var(--mute);font-style:italic}
@media print{body{background:#fff;color:#000;font-size:11pt}main{padding:0}a{color:#000}}`;

export async function exportHtml(src: string, title: string, dir?: string): Promise<string> {
  const doc = new DOMParser().parseFromString(`<body>${md.render(stripDirectives(src))}</body>`, "text/html");
  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>("img.mdimg"));
  await Promise.all(imgs.map(async (el) => {
    const s = el.getAttribute("data-src") ?? "";
    const img = await loadImage(s, { dir });
    el.removeAttribute("data-src");
    if (img) { el.setAttribute("src", dataUrl(img)); el.classList.remove("mdimg"); }
    else { el.parentElement?.querySelector(".mdcap")?.remove(); const sp = doc.createElement("span"); sp.className = "imgmiss"; sp.textContent = `[${el.getAttribute("alt") || "image"}]`; el.replaceWith(sp); }
  }));
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title || "Document")}</title><style>${CSS}</style></head><body><main>\n${doc.body.innerHTML}\n</main></body></html>\n`;
}
