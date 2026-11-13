// Shared: turn an HTML/XHTML document into plain paragraphs. We only ever read text (formulas as $LaTeX$); nothing is rendered or run.

const BLOCKS = "p,h1,h2,h3,h4,h5,h6,li,pre,dd,dt,blockquote,table";

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
  return leafBlocks(root).map((el) => norm(plain(el))).filter(Boolean);
}

// ---- text with the math kept: a formula becomes $LaTeX$ (from the book's own TeX annotation when it has one, else read from MathML), a
// superscript ^{..}, a subscript _{..}, a table its rows with | between cells, an image its alt text. So a math book reaches the model as math.
const BS = String.fromCharCode(92); // a backslash
const cmd = (s: string) => BS + s;
const SYM: Record<string, string> = {
  "×": cmd("times"), "÷": cmd("div"), "−": "-", "≤": cmd("le"), "≥": cmd("ge"), "≠": cmd("ne"), "≈": cmd("approx"), "∈": cmd("in"), "∉": cmd("notin"),
  "∑": cmd("sum"), "∏": cmd("prod"), "∫": cmd("int"), "∞": cmd("infty"), "→": cmd("to"), "←": cmd("leftarrow"), "⇒": cmd("Rightarrow"), "⇔": cmd("Leftrightarrow"),
  "∂": cmd("partial"), "∇": cmd("nabla"), "·": cmd("cdot"), "∘": cmd("circ"), "±": cmd("pm"), "∀": cmd("forall"), "∃": cmd("exists"), "∅": cmd("emptyset"),
  "⊂": cmd("subset"), "⊆": cmd("subseteq"), "∪": cmd("cup"), "∩": cmd("cap"), "π": cmd("pi"), "α": cmd("alpha"), "β": cmd("beta"), "γ": cmd("gamma"),
  "δ": cmd("delta"), "ε": cmd("varepsilon"), "θ": cmd("theta"), "λ": cmd("lambda"), "μ": cmd("mu"), "σ": cmd("sigma"), "φ": cmd("varphi"), "ω": cmd("omega"),
  "Δ": cmd("Delta"), "Σ": cmd("Sigma"), "Ω": cmd("Omega"), "ℝ": cmd("mathbb{R}"), "ℕ": cmd("mathbb{N}"), "ℤ": cmd("mathbb{Z}"), "ℚ": cmd("mathbb{Q}"),
  "ℂ": cmd("mathbb{C}"), "′": "'", "⟨": cmd("langle"), "⟩": cmd("rangle"), "…": cmd("ldots"), "≡": cmd("equiv"), "∝": cmd("propto"), "⊕": cmd("oplus"), "⊗": cmd("otimes"),
  "√": cmd("surd") + " ",
};
const sym = (t: string) => Array.from(t).map((c) => SYM[c] ?? c).join("");
const kids = (n: Element) => Array.from(n.childNodes).filter((c) => c.nodeType === 1 || (c.nodeType === 3 && (c.textContent ?? "").trim())) as (Element | Text)[];

/** MathML to TeX: the common elements (fractions, scripts, roots, limits, fences, matrices). */
function mml(n: Node): string {
  if (n.nodeType === 3) return sym((n.textContent ?? "").trim());
  if (n.nodeType !== 1) return "";
  const e = n as Element;
  const k = kids(e);
  const c = (i: number) => (k[i] ? mml(k[i]) : "");
  const all = () => k.map(mml).join(" ");
  const braced = (s: string) => (s.length === 1 ? s : "{" + s + "}");
  switch (e.localName) {
    case "mi": case "mn": case "mo": return sym(norm(e.textContent ?? ""));
    case "mtext": return cmd("text") + "{" + norm(e.textContent ?? "") + "}";
    case "mfrac": return cmd("frac") + "{" + c(0) + "}{" + c(1) + "}";
    case "msup": return braced(c(0)) + "^{" + c(1) + "}";
    case "msub": return braced(c(0)) + "_{" + c(1) + "}";
    case "msubsup": return braced(c(0)) + "_{" + c(1) + "}^{" + c(2) + "}";
    case "munder": return braced(c(0)) + "_{" + c(1) + "}";
    case "mover": return braced(c(0)) + "^{" + c(1) + "}";
    case "munderover": return braced(c(0)) + "_{" + c(1) + "}^{" + c(2) + "}";
    case "msqrt": return cmd("sqrt") + "{" + all() + "}";
    case "mroot": return cmd("sqrt") + "[" + c(1) + "]{" + c(0) + "}";
    case "mfenced": return (e.getAttribute("open") ?? "(") + k.map(mml).join(e.getAttribute("separators") ?? ",") + (e.getAttribute("close") ?? ")");
    case "mtable": return cmd("begin") + "{matrix}" + k.map(mml).join(" " + BS + BS + " ") + cmd("end") + "{matrix}";
    case "mtr": return k.map(mml).join(" & ");
    case "annotation": case "annotation-xml": return "";
    case "semantics": return c(0);
    default: return all();
  }
}

/** The text of an element, with math kept (see above). */
export function plain(el: Node): string {
  if (el.nodeType === 3) return el.textContent ?? "";
  if (el.nodeType !== 1) return "";
  const e = el as Element;
  switch (e.localName) {
    case "math": {
      const ann = Array.from(e.getElementsByTagNameNS("*", "annotation")).find((a) => /tex/i.test(a.getAttribute("encoding") ?? ""));
      const t = ann ? norm(ann.textContent ?? "") : norm(mml(e)) || norm(e.getAttribute("alttext") ?? "") || norm(e.textContent ?? "");
      return t ? " $" + t + "$ " : "";
    }
    case "sup": return "^{" + norm(e.textContent ?? "") + "}";
    case "sub": return "_{" + norm(e.textContent ?? "") + "}";
    case "img": return " " + (e.getAttribute("alt") ?? "") + " ";
    case "br": return " ";
    case "tr": return Array.from(e.children).map((c) => norm(plain(c))).join(" | ") + " ";
    case "script": case "style": return "";
    default: return Array.from(e.childNodes).map(plain).join("");
  }
}
