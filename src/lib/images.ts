// Images in Markdown documents: a reference (a web address, a data URI, a path next to the document, a path in the app's own image folder) to bytes,
// for the editor's preview and for the PDF. Reading is done in Rust (see images.rs), which checks that the bytes are really an image.

import { api } from "./api";

export type Img = { bytes: Uint8Array; mime: string };
export type ImgCtx = { /** the folder of the file this document lives in (relative references start here) */ dir?: string };

/** An image folder reference for a document that lives only in the library. */
export const STORE_PREFIX = "lanthorn-img/";

const cache = new Map<string, Promise<Img | null>>();
const toImg = (r: { bytes: number[]; mime: string }): Img => ({ bytes: Uint8Array.from(r.bytes), mime: r.mime });
const join = (dir: string, rel: string) => `${dir.replace(/\/+$/, "")}/${rel.replace(/^\.\//, "")}`;
const safeDecode = (s: string) => { try { return decodeURI(s); } catch { return s; } };

async function fetchIt(src: string, ctx: ImgCtx): Promise<Img | null> {
  try {
    if (src.startsWith("data:")) {
      const m = /^data:(image\/[a-z+.-]+);base64,(.+)$/i.exec(src);
      if (!m) return null;
      const bin = atob(m[2]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, mime: m[1].toLowerCase() };
    }
    if (/^https?:\/\//i.test(src)) return toImg(await api.imageFetch(src));
    if (src.startsWith(STORE_PREFIX)) return toImg(await api.imageStored(src.slice(STORE_PREFIX.length)));
    if (src.startsWith("/") || src.startsWith("~/") || src.startsWith("file://")) return toImg(await api.imageRead(safeDecode(src)));
    if (ctx.dir) return toImg(await api.imageRead(join(ctx.dir, safeDecode(src))));
  } catch { /* not there, not an image, or no route: shown as its alt text */ }
  return null;
}

export function loadImage(src: string, ctx: ImgCtx = {}): Promise<Img | null> {
  const key = `${ctx.dir ?? ""}|${src}`;
  let p = cache.get(key);
  if (!p) { p = fetchIt(src, ctx); cache.set(key, p); p.then((v) => { if (!v) cache.delete(key); }); } // (a failure is tried again next time)
  return p;
}
export const forgetImages = () => cache.clear();

export const blobUrl = (img: Img) => URL.createObjectURL(new Blob([img.bytes.slice().buffer], { type: img.mime }));

/** An image as the PDF can use it: PNG or JPEG bytes and the picture's size in pixels (other formats are converted through a canvas). */
export async function forPdf(img: Img): Promise<{ bytes: Uint8Array; kind: "png" | "jpg"; w: number; h: number } | null> {
  try {
    const blob = new Blob([img.bytes.slice().buffer], { type: img.mime });
    const bmp = await createImageBitmap(blob);
    const w = bmp.width, h = bmp.height;
    if (img.mime === "image/png") return { bytes: img.bytes, kind: "png", w, h };
    if (img.mime === "image/jpeg") return { bytes: img.bytes, kind: "jpg", w, h };
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, w, h); // (a transparent GIF or WebP gets a white ground)
    g.drawImage(bmp, 0, 0);
    const out = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!out) return null;
    return { bytes: new Uint8Array(await out.arrayBuffer()), kind: "png", w, h };
  } catch { return null; }
}

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];
