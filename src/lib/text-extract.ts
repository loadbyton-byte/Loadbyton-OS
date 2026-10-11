import zlib from "node:zlib";

/**
 * Plain-text recovery for deterministic extraction. Text, CSV, JSON and HTML are decoded directly. For PDFs only the text layer of
 * ordinary single-byte-encoded text is read (literal and hex strings in BT…ET blocks, Flate-compressed or not). A scanned page, an image,
 * or a font that maps glyph numbers through a custom encoding has no readable text here: the result says so and a person enters the data.
 */
export interface TextResult { text: string; readable: boolean; method: "plain" | "html" | "pdf" | "none"; note?: string }

const MAX_STREAMS = 400, MAX_INFLATED = 4 * 1024 * 1024;

function unescapePdfString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") { out += ch; continue; }
    const n = s[++i];
    if (n === "n") out += "\n"; else if (n === "r") out += "\r"; else if (n === "t") out += "\t"; else if (n === "b") out += "\b"; else if (n === "f") out += "\f";
    else if (n === "(" || n === ")" || n === "\\") out += n;
    else if (n >= "0" && n <= "7") {
      let oct = n;
      while (oct.length < 3 && s[i + 1] >= "0" && s[i + 1] <= "7") oct += s[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 255);
    } else if (n === "\n") { /* line continuation */ } else out += n ?? "";
  }
  return out;
}

/** Pull strings out of one content stream's text-showing operators. */
function contentText(content: string): string {
  const lines: string[] = [];
  let cur = "";
  const flush = () => { if (cur.trim()) lines.push(cur); cur = ""; };
  for (const bt of content.matchAll(/BT([\s\S]*?)ET/g)) {
    const block = bt[1];
    const tokens = block.matchAll(/(\((?:\\.|[^\\()])*\))\s*(?:Tj|'|")|\[((?:\s*(?:\((?:\\.|[^\\()])*\)|<[0-9A-Fa-f\s]*>|-?\d+(?:\.\d+)?))*)\s*\]\s*TJ|<([0-9A-Fa-f\s]+)>\s*Tj|(T\*|Td|TD|Tm)/g);
    for (const t of tokens) {
      if (t[1]) cur += unescapePdfString(t[1].slice(1, -1));
      else if (t[2] !== undefined) {
        for (const part of t[2].matchAll(/\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]*)>|(-?\d+(?:\.\d+)?)/g)) {
          if (part[1] !== undefined) cur += unescapePdfString(part[1]);
          else if (part[2] !== undefined) cur += Buffer.from(part[2].replace(/\s+/g, "").padEnd(Math.ceil(part[2].replace(/\s+/g, "").length / 2) * 2, "0"), "hex").toString("latin1");
          else if (Number(part[3]) < -250) cur += " ";            // a large kerning gap reads as a space
        }
      } else if (t[3]) cur += Buffer.from(t[3].replace(/\s+/g, ""), "hex").toString("latin1");
      else if (t[4]) flush();
    }
    flush();
  }
  return lines.join("\n");
}

function pdfText(buf: Buffer): TextResult {
  const raw = buf.toString("latin1");
  const parts: string[] = [];
  let count = 0;
  for (const m of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    if (++count > MAX_STREAMS) break;
    const dictStart = raw.lastIndexOf("<<", m.index), dict = raw.slice(dictStart, m.index);
    let data = Buffer.from(m[1], "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data, { maxOutputLength: MAX_INFLATED }); } catch { continue; }
    } else if (/\/(?:LZWDecode|ASCII85Decode|DCTDecode|JPXDecode|CCITTFaxDecode|RunLengthDecode)/.test(dict)) continue;
    const content = data.toString("latin1");
    if (!/BT[\s\S]*ET/.test(content)) continue;
    const t = contentText(content);
    if (t) parts.push(t);
  }
  const text = parts.join("\n").replace(/[^\S\n]+/g, " ").trim();
  // glyph-id text from custom encodings decodes to control characters or noise: require mostly printable letters/digits
  const printable = (text.match(/[A-Za-z0-9 .,:;\/\-#@%&()]/g) ?? []).length;
  if (text.length < 8 || printable / text.length < 0.85) return { text: "", readable: false, method: "pdf", note: "No readable text layer (scanned page, image, or custom font encoding). Enter the details manually." };
  return { text, readable: true, method: "pdf" };
}

export function extractText(buf: Buffer, mime: string, filename = ""): TextResult {
  const m = mime.toLowerCase();
  if (m === "application/pdf" || buf.subarray(0, 5).toString("latin1") === "%PDF-") return pdfText(buf);
  if (m === "text/html" || /\.html?$/i.test(filename)) {
    const text = buf.toString("utf8").replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[^\S\n]+/g, " ").trim();
    return { text, readable: text.length > 0, method: "html" };
  }
  if (m.startsWith("text/") || m === "application/json" || m === "application/csv" || /\.(txt|csv|json)$/i.test(filename)) {
    const text = buf.toString("utf8").replace(/^﻿/, "").trim();
    return { text, readable: text.length > 0, method: "plain" };
  }
  return { text: "", readable: false, method: "none", note: `Text cannot be read from ${mime || "this file type"}. Enter the details manually.` };
}
