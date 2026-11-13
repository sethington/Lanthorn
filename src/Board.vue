<script setup lang="ts">
// The picture for a mathematical, scientific or technical passage: typeset equations, a plot with its chord, tangent and marked
// points, and notes, step by step as the text is read. Drawn in the page (no engine to load), so it is there the moment the text is.
import { computed } from "vue";
import katex from "katex";
import "katex/dist/katex.min.css";
import type { Board, BoardPlot } from "./lib/scene";

const props = defineProps<{ board: Board; sid: number }>();

const stepIdx = computed(() => {
  let k = -1;
  props.board.steps.forEach((s, i) => { if (s.at <= props.sid) k = i; });
  return Math.max(0, k);
});
const step = computed(() => props.board.steps[stepIdx.value]);

/** the equations to show: this step's, and the few before it, dimmer */
const eqs = computed(() => {
  const out: { tex: string; html: string; now: boolean }[] = [];
  for (let i = stepIdx.value; i >= 0 && out.length < 4; i--) {
    const list = props.board.steps[i].items.filter((x) => x.t === "eq") as { t: "eq"; tex: string }[];
    for (const e of [...list].reverse()) if (out.length < 4) out.unshift({ tex: e.tex, html: render(e.tex), now: i === stepIdx.value });
  }
  return out;
});
const notes = computed(() => step.value.items.filter((x) => x.t === "note").map((x: any) => x.s as string));
/** a plot stays until the next one */
const plot = computed<BoardPlot | null>(() => {
  for (let i = stepIdx.value; i >= 0; i--) {
    const p = props.board.steps[i].items.find((x) => x.t === "plot");
    if (p) return p as BoardPlot;
  }
  return null;
});

function render(tex: string): string {
  try { return katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: false }); } catch { return `<span>${tex.replace(/[<&]/g, "")}</span>`; }
}

// ---- a function written in x (JS-like), made safe: only numbers, x, operators and a few named functions
const FNS = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "exp", "log", "ln", "sqrt", "abs", "pow", "floor", "ceil", "min", "max", "sinh", "cosh", "tanh", "pi", "e", "x", "Math"]);
function compile(expr: string): ((x: number) => number) | null {
  const t = expr.replace(/Math\./g, "").replace(/\^/g, "**");
  if (!/^[0-9a-zA-Z_+\-*/().,\s]*$/.test(t)) return null;
  const ids = t.match(/[A-Za-z_]+/g) ?? [];
  if (ids.some((id) => !FNS.has(id))) return null;
  const js = t.replace(/(^|[^0-9A-Za-z_.])(sin|cos|tan|asin|acos|atan|exp|sqrt|abs|pow|floor|ceil|min|max|sinh|cosh|tanh)\b/g, "$1Math.$2").replace(/\bln\b/g, "Math.log").replace(/(^|[^0-9A-Za-z_.])log\b/g, "$1Math.log").replace(/(^|[^0-9A-Za-z_.])pi\b/g, "$1Math.PI").replace(/(^|[^0-9A-Za-z_.])e\b(?![0-9])/g, "$1Math.E");
  try { const f = new Function("x", `"use strict"; return (${js});`) as (x: number) => number; f(0); return f; } catch { return null; }
}

const W = 640, H = 440, M = { l: 44, r: 16, t: 14, b: 32 };
const drawing = computed(() => {
  const p = plot.value;
  if (!p) return null;
  const fs = p.fns.map((f) => ({ f: compile(f.expr), label: f.label })).filter((f) => f.f) as { f: (x: number) => number; label?: string }[];
  if (!fs.length) return null;
  const [x0, x1] = p.x;
  const N = 220;
  const xs = Array.from({ length: N + 1 }, (_, i) => x0 + ((x1 - x0) * i) / N);
  const ys = fs.map((f) => xs.map((x) => f.f(x)));
  let [y0, y1] = p.y ?? [NaN, NaN];
  if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
    const all = ys.flat().filter((v) => Number.isFinite(v));
    y0 = Math.min(...all, 0); y1 = Math.max(...all, 0);
    const pad = (y1 - y0 || 1) * 0.12; y0 -= pad; y1 += pad;
  }
  const sx = (x: number) => M.l + ((x - x0) / (x1 - x0)) * (W - M.l - M.r);
  const sy = (y: number) => H - M.b - ((y - y0) / (y1 - y0)) * (H - M.t - M.b);
  const paths = fs.map((_, k) => {
    let d = "", pen = false;
    xs.forEach((x, i) => {
      const y = ys[k][i];
      if (!Number.isFinite(y) || y < y0 - (y1 - y0) || y > y1 + (y1 - y0)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
      pen = true;
    });
    return d;
  });
  const f0 = fs[0].f;
  const line = (xa: number, ya: number, slope: number) => { const xa0 = x0, xb = x1; return { x1: sx(xa0), y1: sy(ya + slope * (xa0 - xa)), x2: sx(xb), y2: sy(ya + slope * (xb - xa)) }; };
  let chord: ReturnType<typeof line> | null = null;
  let chordPts: { x: number; y: number }[] = [];
  if (p.chord) {
    const [a, b] = p.chord;
    const fa = f0(a), fb = f0(b);
    if (Number.isFinite(fa) && Number.isFinite(fb)) {
      chord = { x1: sx(a), y1: sy(fa), x2: sx(b), y2: sy(fb) };
      chordPts = [{ x: sx(a), y: sy(fa) }, { x: sx(b), y: sy(fb) }];
    }
  }
  let tangent: ReturnType<typeof line> | null = null;
  if (p.tangent !== undefined) {
    const t = p.tangent, h = (x1 - x0) * 1e-4;
    const slope = (f0(t + h) - f0(t - h)) / (2 * h);
    if (Number.isFinite(slope)) tangent = line(t, f0(t), slope);
  }
  const marks = (p.marks ?? []).map((m) => ({ x: sx(m.x), y: sy(f0(m.x)), label: m.label })).filter((m) => Number.isFinite(m.y));
  // axes through zero when it is inside, else along the edge; a few ticks
  const ax = { x: sx(Math.min(Math.max(0, x0), x1)), y: sy(Math.min(Math.max(0, y0), y1)) };
  const tick = (a: number, b: number) => { const r = b - a, step = Math.pow(10, Math.floor(Math.log10(r / 4))), m = [1, 2, 5, 10].find((q) => r / (q * step) <= 6) ?? 10; const s = m * step; const out: number[] = []; for (let v = Math.ceil(a / s) * s; v <= b + 1e-9; v += s) out.push(+v.toFixed(6)); return out; };
  return { paths, labels: fs.map((f) => f.label), chord, chordPts, tangent, marks, ax, xt: tick(x0, x1).map((v) => ({ v, x: sx(v) })), yt: tick(y0, y1).map((v) => ({ v, y: sy(v) })), sx, sy, x0, x1, y0, y1 };
});
</script>

<template>
  <div class="board">
    <div v-if="step.say" :key="'h' + stepIdx" class="say">{{ step.say }}</div>
    <svg v-if="drawing" class="plot" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="xMidYMid meet">
      <g class="grid">
        <line v-for="t in drawing.xt" :key="'gx' + t.v" :x1="t.x" :x2="t.x" :y1="M.t" :y2="H - M.b" />
        <line v-for="t in drawing.yt" :key="'gy' + t.v" :x1="M.l" :x2="W - M.r" :y1="t.y" :y2="t.y" />
      </g>
      <g class="axes">
        <line :x1="M.l" :x2="W - M.r" :y1="drawing.ax.y" :y2="drawing.ax.y" />
        <line :x1="drawing.ax.x" :x2="drawing.ax.x" :y1="M.t" :y2="H - M.b" />
        <text v-for="t in drawing.xt" :key="'tx' + t.v" :x="t.x" :y="H - M.b + 16" text-anchor="middle">{{ t.v }}</text>
        <text v-for="t in drawing.yt" :key="'ty' + t.v" :x="M.l - 6" :y="t.y + 4" text-anchor="end">{{ t.v }}</text>
      </g>
      <path v-for="(d, i) in drawing.paths" :key="'p' + i" :d="d" class="curve" :class="'c' + i" />
      <line v-if="drawing.chord" :x1="drawing.chord.x1" :y1="drawing.chord.y1" :x2="drawing.chord.x2" :y2="drawing.chord.y2" class="chord" />
      <circle v-for="(q, i) in drawing.chordPts" :key="'cp' + i" :cx="q.x" :cy="q.y" r="4.5" class="pt chordpt" />
      <line v-if="drawing.tangent" :x1="drawing.tangent.x1" :y1="drawing.tangent.y1" :x2="drawing.tangent.x2" :y2="drawing.tangent.y2" class="tangent" />
      <g v-for="(m, i) in drawing.marks" :key="'m' + i">
        <circle :cx="m.x" :cy="m.y" r="5.5" class="pt mark" />
        <text v-if="m.label" :x="m.x + 9" :y="m.y - 9" class="mlabel">{{ m.label }}</text>
      </g>
      <text v-for="(l, i) in drawing.labels" :key="'l' + i" v-show="l" :x="W - M.r - 6" :y="M.t + 16 + i * 18" text-anchor="end" class="flabel">{{ l }}(x)</text>
    </svg>
    <div class="eqs" :class="{ tall: !drawing }">
      <div v-for="(e, i) in eqs" :key="stepIdx + ':' + i + e.tex" class="eq" :class="{ now: e.now, old: !e.now }" v-html="e.html" />
    </div>
    <div v-if="notes.length" :key="'n' + stepIdx" class="notes"><p v-for="n in notes" :key="n">{{ n }}</p></div>
  </div>
</template>

<style scoped>
.board { position: absolute; inset: 0; background: radial-gradient(120% 90% at 50% 0%, #1b1f2b 0%, #12141c 70%); color: #ece8dc; display: flex; flex-direction: column; gap: 10px; padding: 18px 20px 16px; overflow: hidden; font-family: system-ui, sans-serif; }
.say { font: 600 11px/1.3 system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; color: #d8b45a; animation: rise 0.4s ease both; }
.plot { width: 100%; flex: 0 1 52%; min-height: 0; animation: rise 0.5s ease both; }
.grid line { stroke: #ffffff12; stroke-width: 1; }
.axes line { stroke: #8a8fa0; stroke-width: 1.2; }
.axes text { fill: #9aa0b2; font: 13px ui-monospace, Menlo, monospace; }
.curve { fill: none; stroke-width: 3.5; stroke-linecap: round; stroke-linejoin: round; }
.curve.c0 { stroke: #d8b45a; }
.curve.c1 { stroke: #8fd0c0; }
.curve.c2 { stroke: #c9a0ff; }
.chord { stroke: #7fb3ff; stroke-width: 2.2; stroke-dasharray: 6 4; }
.tangent { stroke: #ff8f70; stroke-width: 2.4; }
.pt { stroke: #12141c; stroke-width: 2; }
.chordpt { fill: #7fb3ff; }
.mark { fill: #fff7e0; }
.mlabel { fill: #fff7e0; font: italic 600 22px Georgia, serif; }
.flabel { fill: #d8b45a; font: italic 20px Georgia, serif; }
.eqs { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; justify-content: center; gap: 4px; overflow: hidden; }
.eq { text-align: center; animation: rise 0.45s ease both; }
.eq.now { font-size: 1.35em; color: #fff; }
.eq.old { font-size: 1em; opacity: 0.42; }
.tall .eq.now { font-size: 1.7em; }
.eq :deep(.katex-display) { margin: 0.25em 0; }
.eq :deep(.katex) { color: inherit; }
.notes { color: #b9b4a4; font: 15px/1.4 Georgia, serif; text-align: center; animation: rise 0.5s ease both; }
.notes p { margin: 0.2em 0; }
@keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
</style>
