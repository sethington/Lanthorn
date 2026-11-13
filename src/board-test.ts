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
const which = new URLSearchParams(location.search).get("b");
const maps = { steps: [
  { at: 0, say: "Abram leaves Haran", items: [{ t: "map", title: "The road to Canaan", points: [{ id: "ur", name: "Ur", x: 78, y: 80 }, { id: "haran", name: "Haran", x: 62, y: 14 }, { id: "damascus", name: "Damascus", x: 36, y: 34 }, { id: "shechem", name: "Shechem", x: 24, y: 52 }, { id: "bethel", name: "Bethel", x: 22, y: 62 }, { id: "egypt", name: "Egypt", x: 6, y: 90 }], route: ["haran", "damascus", "shechem", "bethel", "egypt"] }] },
  { at: 1, say: "Into Canaan", items: [{ t: "note", s: "and they went forth to go into the land of Canaan" }] },
  { at: 2, say: "To Bethel", items: [] },
] };
const tree = { steps: [{ at: 0, say: "The line of Abram", items: [{ t: "tree", nodes: [{ id: "terah", label: "Terah" }, { id: "abram", label: "Abram", parent: "terah" }, { id: "nahor", label: "Nahor", parent: "terah" }, { id: "haran", label: "Haran", parent: "terah" }, { id: "lot", label: "Lot", parent: "haran" }, { id: "isaac", label: "Isaac", parent: "abram" }, { id: "ishmael", label: "Ishmael", parent: "abram" }] }] }] };
const line = { steps: [{ at: 0, say: "Seven days", items: [{ t: "timeline", events: [{ label: "Light", at: 5 }, { label: "Sky", at: 20 }, { label: "Land and plants", at: 38 }, { label: "Sun and moon", at: 55 }, { label: "Fish and birds", at: 72 }, { label: "Beasts and people", at: 88 }], from: "Day 1", to: "Day 7" }] }] };
const sid = Number(new URLSearchParams(location.search).get("sid") ?? 9);
createApp(Board, { board: which === 'map' ? (maps as any) : which === 'tree' ? (tree as any) : which === 'time' ? (line as any) : board, sid }).mount("#app");
