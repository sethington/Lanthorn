// dev only: the importer's math handling on a sample page (import-test.html)
import { parseDoc, paragraphsFrom } from "./lib/import/dom";
const xhtml = `<html xmlns="http://www.w3.org/1999/xhtml"><body>
<p>The roots of <math xmlns="http://www.w3.org/1998/Math/MathML"><mi>a</mi><msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><mi>b</mi><mi>x</mi><mo>+</mo><mi>c</mi><mo>=</mo><mn>0</mn></math> are
<math xmlns="http://www.w3.org/1998/Math/MathML"><mi>x</mi><mo>=</mo><mfrac><mrow><mo>−</mo><mi>b</mi><mo>±</mo><msqrt><msup><mi>b</mi><mn>2</mn></msup><mo>−</mo><mn>4</mn><mi>a</mi><mi>c</mi></msqrt></mrow><mrow><mn>2</mn><mi>a</mi></mrow></mfrac></math>.</p>
<p>The sum <math xmlns="http://www.w3.org/1998/Math/MathML"><munderover><mo>∑</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi></munderover><mi>k</mi></math> equals n(n+1)/2, and E = mc<sup>2</sup> while H<sub>2</sub>O is water.</p>
<p>Known: <math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>e</mi></mrow><annotation encoding="application/x-tex">e^{i\\pi}+1=0</annotation></semantics></math> (Euler).</p>
<table><tr><td>x</td><td>f(x)</td></tr><tr><td>1</td><td>1</td></tr><tr><td>2</td><td>4</td></tr></table>
<p>An image formula <img alt="a^2 + b^2 = c^2" src="x.png"/> follows.</p>
</body></html>`;
const doc = parseDoc(xhtml);
document.getElementById("out")!.textContent = paragraphsFrom(doc.body).join("\n\n");
