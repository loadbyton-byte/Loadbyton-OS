import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/** True for addresses a customer-supplied URL must never make us call: loopback, private, link-local, CGNAT, documentation, multicast, metadata. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 0 && c === 2) || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    const hex = l.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) { const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16); return isPrivateAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")); }
    return l === "::" || l === "::1" || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || l.startsWith("2001:db8") || l.startsWith("64:ff9b") || l.startsWith("100::") || l.startsWith("2002:");
  }
  return true;       // not an IP at all: refuse
}

/** Registration-time check of a webhook address. (The send-time connection check below is the one that cannot be raced.) */
export function validateWebhookUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error("Enter a full https:// address."); }
  if (u.protocol !== "https:") throw new Error("Webhook addresses must use https.");
  if (u.username || u.password) throw new Error("Do not put credentials in the address; use the signature.");
  if (u.port && !["443", "8443"].includes(u.port)) throw new Error("Use port 443 or 8443.");
  const h = u.hostname.toLowerCase();
  if (net.isIP(h.replace(/^\[|\]$/g, "")) || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".")) throw new Error("Use a public host name (not an IP address or an internal name).");
  if (raw.length > 500) throw new Error("That address is too long.");
  return u;
}

export interface PostResult { status: number; body: string; headers?: Record<string, string | string[] | undefined> }
export interface PostOptions {
  timeoutMs?: number; maxBodyBytes?: number;
  /** test seams — never reachable from configuration */
  lookup?: typeof dns.lookup; allowPrivate?: boolean; allowHttp?: boolean;
  /** request body media type for postJson (default application/json); the OAuth token call is form-encoded */
  contentType?: string;
  /** include the response headers (needed for Link-header paging); off by default so results stay {status, body} */
  returnHeaders?: boolean;
}

/**
 * POST JSON to a customer-supplied address without letting it reach our network. The address is validated, and **every address the name resolves to is checked
 * inside the connection's own lookup**, so DNS changing between a check and the connect (rebinding) cannot redirect us. Redirects are never followed.
 */
export function postJson(url: string, body: string, headers: Record<string, string>, o: PostOptions = {}): Promise<PostResult> {
  return safeRequest("POST", url, body, headers, o);
}
/** GET with the same address protections as postJson (used for customer-configured statement feeds). */
export function getJson(url: string, headers: Record<string, string>, o: PostOptions = {}): Promise<PostResult> {
  return safeRequest("GET", url, null, headers, { maxBodyBytes: 2_000_000, timeoutMs: 20_000, ...o });
}
function safeRequest(method: "GET" | "POST", url: string, body: string | null, headers: Record<string, string>, o: PostOptions): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try { u = o.allowHttp ? new URL(url) : validateWebhookUrl(url); } catch (e) { return reject(Object.assign(new Error((e as Error).message), { permanent: true })); }
    const base = o.lookup ?? dns.lookup;
    const lookup = ((host: string, opts: any, cb: any) => {
      base(host, { ...opts, all: true, verbatim: true }, (err: any, addrs: any) => {
        if (err) return cb(err);
        const list: { address: string; family: number }[] = Array.isArray(addrs) ? addrs : [{ address: addrs, family: 4 }];
        if (!o.allowPrivate && list.some((a) => isPrivateAddress(a.address))) return cb(Object.assign(new Error("that address resolves to a private network"), { permanent: true }));
        if (opts?.all) cb(null, list); else cb(null, list[0].address, list[0].family);
      });
    }) as any;
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.request(u, { method, lookup, timeout: o.timeoutMs ?? 10_000, headers: body === null ? { accept: "application/json, text/csv;q=0.9", ...headers } : { ...headers, "content-type": o.contentType ?? "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = []; let n = 0; const max = o.maxBodyBytes ?? 4096;
      res.on("data", (d: Buffer) => { n += d.length; if (n <= max) chunks.push(d); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), ...(o.returnHeaders ? { headers: res.headers as any } : {}) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("the endpoint did not answer in time")));
    req.on("error", reject);
    req.end(body ?? undefined);
  });
}
