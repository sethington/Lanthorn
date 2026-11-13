// The plain furniture of an old room, built from boards and posts in dark wood: a trestle table, a bench, a stool, a chair, a round table.
// (The library's models of these come painted in modern colours and at odd sizes; these are right for a period inn, load at once, and are stained alike.)
import type { Part } from "./props";

const WOODS = ["#4a3220", "#523826", "#46301f", "#4e3624", "#3f2a1b"];
const w = (i: number) => WOODS[i % WOODS.length];
const box = (p: [number, number, number], d: [number, number, number], c: string): Part => ({ s: "box", p, d, c });

export type FurnKind = "table" | "bench" | "stool" | "chair" | "round";
export function furniture(kind: FurnKind, len = 1.9, wid = 0.85, h = 0.76): Part[] {
  const out: Part[] = [];
  if (kind === "table") {
    const n = 4;
    for (let i = 0; i < n; i++) out.push(box([0, h - 0.0225, (i - (n - 1) / 2) * (wid / n)], [len, 0.045, wid / n - 0.004], w(i)));
    for (const sx of [-1, 1]) {
      const x = sx * (len / 2 - 0.25);
      for (const sz of [-1, 1]) out.push(box([x, (h - 0.045) / 2, sz * (wid / 2 - 0.1)], [0.07, h - 0.045, 0.07], w(4)));
      out.push(box([x, 0.2, 0], [0.05, 0.05, wid - 0.2], w(2)));
    }
    out.push(box([0, 0.26, 0], [len - 0.5, 0.05, 0.06], w(1)));
  } else if (kind === "bench") {
    const d = 0.28;
    out.push(box([0, h - 0.0275, 0], [len, 0.055, d], w(0)));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box([sx * (len / 2 - 0.12), (h - 0.055) / 2, sz * (d / 2 - 0.05)], [0.06, h - 0.055, 0.06], w(4)));
    out.push(box([0, 0.18, 0], [len - 0.3, 0.04, 0.05], w(2)));
  } else if (kind === "stool") {
    out.push({ s: "cyl", p: [0, h - 0.025, 0], d: [0.19, 0.05], c: w(1) });
    for (let i = 0; i < 4; i++) { const a = (i / 4) * Math.PI * 2 + Math.PI / 4; out.push(box([Math.cos(a) * 0.12, (h - 0.05) / 2, Math.sin(a) * 0.12], [0.045, h - 0.05, 0.045], w(4))); }
    out.push({ s: "cyl", p: [0, 0.17, 0], d: [0.15, 0.03], c: w(2) });
  } else if (kind === "chair") {
    // the front is +z; the back stands at -z
    out.push(box([0, 0.45, 0], [0.44, 0.04, 0.42], w(1)));
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(box([sx * 0.19, 0.215, sz * 0.18], [0.045, 0.43, 0.045], w(4)));
    for (const sx of [-1, 1]) out.push(box([sx * 0.19, 0.69, -0.18], [0.04, 0.5, 0.04], w(4)));
    for (const [y, hh] of [[0.72, 0.09], [0.87, 0.07]]) out.push(box([0, y, -0.18], [0.36, hh, 0.025], w(2)));
    out.push(box([0, 0.2, 0.18], [0.36, 0.03, 0.03], w(2)));
  } else {
    // a round table: a top on a turned post and three feet
    const r = wid / 2;
    out.push({ s: "cyl", p: [0, h - 0.025, 0], d: [r, 0.05], c: w(0) });
    out.push({ s: "cyl", p: [0, (h - 0.05) / 2, 0], d: [0.07, h - 0.05], c: w(4) });
    for (let i = 0; i < 3; i++) { const a = (i / 3) * Math.PI * 2; out.push(box([Math.cos(a) * 0.16, 0.04, Math.sin(a) * 0.16], [0.3, 0.07, 0.07], w(3))); }
    // (the feet are boxes turned out from the post)
    out.forEach((q, i) => { if (i >= out.length - 3) q.r = [0, -((i - (out.length - 3)) / 3) * Math.PI * 2, 0]; });
  }
  return out;
}
