// dev only: the board on its own, on a page, stepping through a sample (board-test.html?sid=N)
import { createApp } from "vue";
import Board from "./Board.vue";
const board = { steps: [
  { at: 0, say: "State the Mean Value Theorem's hypotheses", items: [{ t: "note", s: "f continuous on [a,b], differentiable on (a,b)" }] },
  { at: 3, say: "Tangent slope equals secant slope somewhere", items: [{ t: "eq", tex: "f'(c) = \\frac{f(b)-f(a)}{b-a}" }, { t: "plot", fns: [{ expr: "0.3*x*x + Math.sin(x)", label: "f" }], x: [-2, 4], y: [-2, 4], marks: [{ x: 1.3, label: "c" }], chord: [-1, 3] }] },
  { at: 5, say: "Construct the auxiliary function g", items: [{ t: "eq", tex: "g(x) = f(x) - f(a) - \\frac{f(b)-f(a)}{b-a}(x-a)" }] },
  { at: 8, say: "Differentiate g and solve for f'(c)", items: [{ t: "eq", tex: "g'(x) = f'(x) - \\frac{f(b)-f(a)}{b-a}" }, { t: "eq", tex: "f'(c) = \\frac{f(b)-f(a)}{b-a}" }] },
  { at: 9, say: "Tangent at c is parallel to the chord", items: [{ t: "plot", fns: [{ expr: "0.3*x*x + Math.sin(x)", label: "f" }], x: [-2, 4], y: [-2, 4], marks: [{ x: 1.3, label: "c" }], chord: [-1, 3], tangent: 1.3 }, { t: "note", s: "tangent line at c runs parallel to the chord" }] },
] };
const sid = Number(new URLSearchParams(location.search).get("sid") ?? 9);
createApp(Board, { board, sid }).mount("#app");
