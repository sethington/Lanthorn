// A document as a Word file (.docx): a zip of small XML parts, written here from the same blocks the PDF is made from (headings, paragraphs with
// bold / italic / code / links, lists, quotes, code blocks, tables, rules, pictures with captions). Opens in Word, Pages, LibreOffice and Google Docs.

import { strToU8, zipSync } from "fflate";
import { type Block, type PdfImage, type Run, blocksOf } from "./pdf/render";

const esc = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const EMU = 9525; // per pixel at 96 dpi
const MAX_W = 5943600; // 6.5 inches: the text width between one-inch margins
const MAX_H = 7315200; // 8 inches

export type DocxOptions = { title: string; author: string; loadImage?: (src: string) => Promise<PdfImage | null> };

export async function renderDocx(src: string, opt: DocxOptions): Promise<Uint8Array> {
  const blocks = blocksOf(src);
  const rels: string[] = [];
  const media: Record<string, Uint8Array> = {};
  const nums: { ordered: boolean; start: number }[] = [];
  let rid = 10, imgN = 0, docPr = 1;
  const link = (href: string) => {
    if (!/^(https?:\/\/|mailto:)/i.test(href)) return "";
    const id = `rId${rid++}`;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${esc(href)}" TargetMode="External"/>`);
    return id;
  };

  const run = (r: Run, extra = ""): string => {
    const props = `${r.href ? '<w:rStyle w:val="Hyperlink"/>' : ""}${r.code ? '<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:shd w:val="clear" w:color="auto" w:fill="F0EEE8"/>' : ""}${r.b ? "<w:b/>" : ""}${r.i ? "<w:i/>" : ""}${r.s ? "<w:strike/>" : ""}${extra}`;
    const parts = r.t.split("\n");
    const body = parts.map((p, i) => `${i ? "<w:br/>" : ""}${p ? `<w:t xml:space="preserve">${esc(p)}</w:t>` : ""}`).join("");
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
  };
  const runs = (rs: Run[], extra = ""): string => {
    let out = "";
    for (let i = 0; i < rs.length; i++) {
      const r = rs[i];
      const id = r.href ? link(r.href) : "";
      if (id) { // consecutive runs of one link share one hyperlink element
        let j = i, inner = "";
        while (j < rs.length && rs[j].href === r.href) { inner += run(rs[j], extra); j++; }
        out += `<w:hyperlink r:id="${id}">${inner}</w:hyperlink>`;
        i = j - 1;
      } else out += run({ ...r, href: undefined }, extra);
    }
    return out;
  };
  const para = (inner: string, style = "", ppr = "") => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${ppr}</w:pPr>${inner}</w:p>`;

  async function image(b: Extract<Block, { k: "img" }>, indent: number): Promise<string> {
    const img = opt.loadImage ? await opt.loadImage(b.src).catch(() => null) : null;
    const cap = (b.title || b.alt).trim();
    if (!img) return para(run({ t: `[${b.alt || "image"}]`, i: true }), "", indent ? `<w:ind w:left="${indent}"/>` : "");
    const name = `image${++imgN}.${img.kind === "png" ? "png" : "jpeg"}`;
    media[`word/media/${name}`] = img.bytes;
    const id = `rId${rid++}`;
    rels.push(`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${name}"/>`);
    let w = img.w * EMU, h = img.h * EMU;
    const k = Math.min(1, (MAX_W - indent * 635) / w, MAX_H / h);
    w = Math.max(EMU, Math.round(w * k)); h = Math.max(EMU, Math.round(h * k));
    const d = `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${w}" cy="${h}"/><wp:docPr id="${docPr++}" name="Picture ${imgN}" descr="${esc(b.alt)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="${name}" descr="${esc(b.alt)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
    const ind = indent ? `<w:ind w:left="${indent}"/>` : "";
    return para(`<w:r>${d}</w:r>`, "", `<w:keepNext/><w:jc w:val="center"/>${ind}`) + (cap ? para(run({ t: cap, i: true }), "Caption", `<w:jc w:val="center"/>${ind}`) : "");
  }

  async function out(bs: Block[], indent = 0, listLevel = -1, numId = 0): Promise<string> {
    let x = "";
    for (const b of bs) {
      if (b.k === "h") x += para(runs(b.runs), `Heading${Math.min(6, Math.max(1, b.level))}`, indent ? `<w:ind w:left="${indent}"/>` : "");
      else if (b.k === "p") {
        if (listLevel >= 0 && numId) x += para(runs(b.runs), "ListParagraph", `<w:numPr><w:ilvl w:val="${Math.min(listLevel, 3)}"/><w:numId w:val="${numId}"/></w:numPr>`);
        else x += para(runs(b.runs), "", indent ? `<w:ind w:left="${indent}"/>` : "");
        numId = 0; // (only the first paragraph of an item carries the marker; the rest continue under it)
      } else if (b.k === "list") {
        nums.push({ ordered: b.ordered, start: b.start });
        const id = nums.length;
        for (const item of b.items) { x += await out(item, indent, listLevel + 1, id); }
      } else if (b.k === "quote") x += await out(b.blocks.map((q) => q), indent + 560).then((s) => s.replace(/<w:p><w:pPr>(<w:pStyle w:val="(?!Heading)[^"]*"\/>)?/g, (m, st) => (st ? m : `<w:p><w:pPr><w:pStyle w:val="Quote"/>`)));
      else if (b.k === "code") x += para(b.text.split("\n").map((l, i) => `<w:r>${i ? "<w:br/>" : ""}${l ? `<w:t xml:space="preserve">${esc(l.replace(/\t/g, "    "))}</w:t>` : ""}</w:r>`).join(""), "CodeBlock", indent ? `<w:ind w:left="${indent}"/>` : "");
      else if (b.k === "hr") x += para("", "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="B5B2A8"/></w:pBdr>');
      else if (b.k === "img") x += await image(b, indent);
      else if (b.k === "table") {
        const cols = Math.max(b.head[0]?.length ?? 0, ...b.rows.map((r) => r.length), 1);
        const cell = (rs: Run[], head: boolean) => `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9360 / cols)}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEBE4"/>' : ""}</w:tcPr>${para(runs(rs, head ? "<w:b/>" : ""), "TableText")}</w:tc>`;
        const row = (cells: Run[][], head: boolean) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from({ length: cols }, (_, i) => cell(cells[i] ?? [], head)).join("")}</w:tr>`;
        x += `<w:tbl><w:tblPr><w:tblW w:w="9360" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="C8C5BA"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${Math.floor(9360 / cols)}"/>`).join("")}</w:tblGrid>${b.head.map((h) => row([h as any] as any, true)).length ? row(b.head, true) : ""}${b.rows.map((r) => row(r, false)).join("")}</w:tbl>${para("")}`;
      }
    }
    return x;
  }

  const body = await out(blocks);
  // the first heading is the document's title
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body.replace('<w:pStyle w:val="Heading1"/>', '<w:pStyle w:val="Title"/>')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;

  const font = (f: string) => `<w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:cs="${f}"/>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font("Georgia")}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="312" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="240"/></w:pPr><w:rPr>${font("Helvetica Neue")}<w:b/><w:sz w:val="52"/><w:szCs w:val="52"/></w:rPr></w:style>
${[1, 2, 3, 4, 5, 6].map((n) => `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 280}" w:after="100"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr>${font("Helvetica Neue")}<w:b/><w:sz w:val="${[40, 32, 27, 24, 22, 20][n - 1]}"/><w:szCs w:val="${[40, 32, 27, 24, 22, 20][n - 1]}"/></w:rPr></w:style>`).join("")}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="10" w:color="2B4A7A"/></w:pBdr><w:ind w:left="560"/></w:pPr><w:rPr><w:i/><w:color w:val="55585F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F0EEE8"/><w:spacing w:after="160" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr>${font("Courier New")}<w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="40" w:after="200"/></w:pPr><w:rPr><w:i/><w:color w:val="666666"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="TableText"><w:name w:val="Table Text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="40" w:after="40" w:line="260" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="2B4A7A"/><w:u w:val="single"/></w:rPr></w:style></w:styles>`;

  const lvl = (i: number, fmt: string, text: string, start: number) => `<w:lvl w:ilvl="${i}"><w:start w:val="${start}"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="360"/></w:pPr>${fmt === "bullet" ? `<w:rPr>${font("Symbol")}</w:rPr>` : ""}</w:lvl>`;
  const bulletChars = ["", "o", "", ""];
  const olist = (n: number, start: number) => `<w:abstractNum w:abstractNumId="${100 + n}"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3].map((i) => lvl(i, i % 2 ? "lowerLetter" : "decimal", `%${i + 1}.`, i === 0 ? start : 1)).join("")}</w:abstractNum>`;
  const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${[0, 1, 2, 3].map((i) => lvl(i, "bullet", bulletChars[i], 1)).join("")}</w:abstractNum>${nums.map((n, i) => (n.ordered ? olist(i, n.start) : "")).join("")}${nums.map((n, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${n.ordered ? 100 + i : 1}"/></w:num>`).join("")}</w:numbering>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>${rels.join("")}</Relationships>`;
  const types = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const pkgRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(opt.title)}</dc:title><dc:creator>${esc(opt.author)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

  return zipSync({
    "[Content_Types].xml": strToU8(types),
    "_rels/.rels": strToU8(pkgRels),
    "word/document.xml": strToU8(doc),
    "word/styles.xml": strToU8(styles),
    "word/numbering.xml": strToU8(numbering),
    "word/_rels/document.xml.rels": strToU8(docRels),
    "docProps/core.xml": strToU8(core),
    ...Object.fromEntries(Object.entries(media)),
  });
}
