/**
 * Everywhere the literal wordmark text "LOAD|BY|TON" appears in the visible text of a page, show it as the logo draws it:
 * LOAD, a stacked B over Y between two red bars, TON. Runs on rendered HTML, so it covers every page (including ones written as plain text),
 * works without JavaScript, and leaves titles, attributes, scripts, code and form values untouched.
 */
const WORD = "LOAD|BY|TON";
export const WORDMARK_HTML = '<span class="lbt" data-notranslate role="img" aria-label="LOAD BY TON">LOAD<span class="by" aria-hidden="true"><i></i><b><span>B</span><span>Y</span></b><i></i></span>TON</span>';
const SKIP = new Set(["script", "style", "title", "textarea", "option", "pre", "code", "kbd", "samp", "svg", "template", "noscript", "select"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

export function brandHtml(html: string): string {
  if (!html.includes(WORD)) return html;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|<!--[\s\S]*?-->/g;
  let out = "", i = 0, skip = 0, inLbt = 0;
  const skipStack: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const text = html.slice(i, m.index);
    out += skip || inLbt ? text : text.split(WORD).join(WORDMARK_HTML);
    i = m.index + m[0].length;
    out += m[0];
    if (m[0].startsWith("<!--")) continue;
    const close = m[1] === "/", tag = m[2].toLowerCase();
    if (VOID.has(tag) || m[3].trimEnd().endsWith("/")) continue;
    if (SKIP.has(tag)) { if (close) { skip = Math.max(0, skip - 1); } else skip++; }
    // content already drawn as a wordmark, or opted out
    if (!close && /\sdata-nobrand\b/.test(m[3])) { skipStack.push(tag); inLbt++; }
    else if (close && skipStack.length && skipStack[skipStack.length - 1] === tag) { skipStack.pop(); inLbt = Math.max(0, inLbt - 1); }
  }
  const rest = html.slice(i);
  return out + (skip || inLbt ? rest : rest.split(WORD).join(WORDMARK_HTML));
}
