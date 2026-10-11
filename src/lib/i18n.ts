import { AR } from "./i18n-ar.js";

/**
 * Arabic interface layer. Pages are written in English; for an Arabic session the rendered HTML is passed through this translator, which
 * replaces whole text nodes (and a few user-facing attributes) that exactly match a dictionary entry. Anything without an entry stays in
 * English — the fallback is always readable — and `coverage()` reports honestly how much of a page is translated. Customer data (names,
 * references, free text) never matches a dictionary key, so it is never altered. Document content (invoices, customer-facing PDFs) has its own
 * bilingual rendering and is not touched here.
 */
export type Locale = "en" | "ar";
export const LOCALES: Locale[] = ["en", "ar"];
export const isLocale = (v: unknown): v is Locale => v === "en" || v === "ar";
export const dirOf = (l: Locale) => (l === "ar" ? "rtl" : "ltr");

const SKIP = new Set(["script", "style", "pre", "code", "textarea", "svg", "kbd", "samp"]);
const ATTRS = ["placeholder", "aria-label", "title", "alt"];
const NUMERIC_ONLY = /^[\s\d.,:;/%+\-–—()·•|@#$€£¥]*$/;

const BRAND_SUFFIX = " · LOAD|BY|TON.store";
const lookup = (text: string): string | undefined => {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t || NUMERIC_ONLY.test(t)) return undefined;
  const hit = AR[t] ?? AR[t.replace(/[.:]$/, "")];
  if (hit) return hit;
  if (t.endsWith(BRAND_SUFFIX)) { const head = AR[t.slice(0, -BRAND_SUFFIX.length)]; if (head) return head + BRAND_SUFFIX; }
  return undefined;
};

export interface Tally { total: number; translated: number; missing: Map<string, number> }
const newTally = (): Tally => ({ total: 0, translated: 0, missing: new Map() });

/** Translate one HTML document or fragment. When `tally` is given it is filled with what was and was not translated. */
export function translateHtml(html: string, tally?: Tally): string {
  let out = "", i = 0, skipUntil: string | null = null, subtree: { tag: string; depth: number } | null = null;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|<!--[\s\S]*?-->/g;
  let m: RegExpExecArray | null;
  const text = (raw: string) => {
    if (!raw) return raw;
    const s = decodeEntities(raw);
    const hit = lookup(s);
    const trimmed = s.replace(/\s+/g, " ").trim();
    if (tally && trimmed && !NUMERIC_ONLY.test(trimmed) && /[A-Za-z]/.test(trimmed)) {
      tally.total++;
      if (hit) tally.translated++; else tally.missing.set(trimmed, (tally.missing.get(trimmed) ?? 0) + 1);
    }
    if (!hit) return raw;
    const lead = /^\s*/.exec(raw)![0], trail = /\s*$/.exec(raw)![0];
    return lead + encodeText(hit) + trail;
  };
  const attrs = (tag: string, raw: string) => {
    let a = raw;
    for (const name of ATTRS) a = a.replace(new RegExp(`(\\s${name}=)(")([^"]*)(")`, "g"), (_x, p1, q, v, q2) => { const h = lookup(decodeEntities(v)); if (tally && /[A-Za-z]/.test(v)) { tally.total++; if (h) tally.translated++; else tally.missing.set(`[${name}] ${v}`, (tally.missing.get(`[${name}] ${v}`) ?? 0) + 1); } return h ? `${p1}${q}${encodeAttr(h)}${q2}` : _x; });
    if (tag === "input") a = a.replace(/(\stype="(?:submit|button)"[^>]*?\svalue=")([^"]*)(")/, (_x, p1, v, p3) => { const h = lookup(decodeEntities(v)); return h ? `${p1}${encodeAttr(h)}${p3}` : _x; });
    return a;
  };
  while ((m = re.exec(html))) {
    const seg = html.slice(i, m.index);
    out += skipUntil || subtree ? seg : text(seg);
    i = m.index + m[0].length;
    if (m[0].startsWith("<!--")) { out += m[0]; continue; }
    const closing = m[1] === "/", tag = m[2].toLowerCase();
    if (subtree) {                                            // customer-facing documents keep their own language
      if (tag === subtree.tag) { subtree.depth += closing ? -1 : m[0].endsWith("/>") ? 0 : 1; if (subtree.depth === 0) subtree = null; }
      out += m[0]; continue;
    }
    if (!closing && (/\sdata-notranslate\b/.test(m[3]) || /\sclass="[^"]*\bprint-doc\b/.test(m[3])) && !m[0].endsWith("/>")) { subtree = { tag, depth: 1 }; out += m[0]; continue; }
    if (skipUntil) { if (closing && tag === skipUntil) skipUntil = null; out += m[0]; continue; }
    if (!closing && SKIP.has(tag) && !m[0].endsWith("/>")) skipUntil = tag;
    out += closing ? m[0] : `<${m[2]}${attrs(tag, m[3])}>`;
  }
  out += skipUntil || subtree ? html.slice(i) : text(html.slice(i));
  return out;
}
const decodeEntities = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const encodeText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const encodeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Full page: translate, flip language and direction, and load the right-to-left stylesheet. */
export function localisePage(html: string): string {
  let out = translateHtml(html);
  out = out.replace(/<html([^>]*)\slang="en"([^>]*)>/, '<html$1 lang="ar" dir="rtl"$2>');
  if (!out.includes("/assets/rtl.css")) out = out.replace("</head>", '<link rel="stylesheet" href="/assets/rtl.css" /></head>');
  return out;
}

export function coverage(html: string): { total: number; translated: number; percent: number; missing: [string, number][] } {
  const t = newTally();
  translateHtml(html, t);
  return { total: t.total, translated: t.translated, percent: t.total ? Math.round((t.translated / t.total) * 1000) / 10 : 100, missing: [...t.missing.entries()].sort((a, b) => b[1] - a[1]) };
}
