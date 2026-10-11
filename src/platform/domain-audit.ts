import dns from "node:dns/promises";
import { hmac } from "../lib/util.js";

/**
 * DNS evidence for the platform's own domain. It shows what the zone currently says and whether the person holding DNS control can place a
 * challenge record. It cannot show who the registrant is — that is a registrar record, supplied as evidence for the "domain ownership"
 * readiness gate.
 */
export interface Resolver {
  resolveTxt(name: string): Promise<string[][]>; resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>; resolveNs(name: string): Promise<string[]>;
  resolve4(name: string): Promise<string[]>; resolve6(name: string): Promise<string[]>; resolveCname(name: string): Promise<string[]>; resolveCaa(name: string): Promise<{ critical: number; issue?: string; issuewild?: string }[]>;
}
export interface DomainCheck { id: string; level: "pass" | "warn" | "fail"; message: string }
const safe = async <T>(p: Promise<T>, empty: T): Promise<T> => { try { return await p; } catch { return empty; } };
export const challengeFor = (domain: string, secret: string) => `lbt-domain-verification=${hmac(secret, `domain:${domain.toLowerCase()}`).slice(0, 32)}`;

export async function auditDomain(domain: string, opts: { secret: string; resolver?: Resolver; dkimSelector?: string }): Promise<{ domain: string; challenge: string; checks: DomainCheck[]; controlProven: boolean }> {
  const d = domain.toLowerCase().replace(/\.$/, ""), r: Resolver = opts.resolver ?? (dns as unknown as Resolver);
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new Error("Enter a domain name such as example.com.");
  const checks: DomainCheck[] = [], add = (id: string, level: DomainCheck["level"], message: string) => checks.push({ id, level, message });
  const txt = async (name: string) => (await safe(r.resolveTxt(name), [])).map((p) => p.join(""));
  const ns = await safe(r.resolveNs(d), []);
  add("ns", ns.length >= 2 ? "pass" : ns.length === 1 ? "warn" : "fail", ns.length ? `${ns.length} name server(s): ${ns.join(", ")}` : "No name servers answer for this domain.");
  const [a4, a6, cname] = await Promise.all([safe(r.resolve4(d), []), safe(r.resolve6(d), []), safe(r.resolveCname(d), [])]);
  add("apex", a4.length || a6.length || cname.length ? "pass" : "fail", a4.length || a6.length || cname.length ? `Resolves to ${[...a4, ...a6, ...cname].join(", ")}` : "The apex does not resolve to an address.");
  const www = await Promise.all([safe(r.resolve4(`www.${d}`), []), safe(r.resolveCname(`www.${d}`), [])]);
  add("www", www[0].length || www[1].length ? "pass" : "warn", www[0].length || www[1].length ? "www resolves." : "www does not resolve.");
  const mx = await safe(r.resolveMx(d), []);
  add("mx", mx.length ? "pass" : "warn", mx.length ? `Mail exchangers: ${mx.map((m) => m.exchange).join(", ")}` : "No MX records: the domain cannot receive email.");
  const root = await txt(d), spf = root.filter((t) => /^v=spf1\b/i.test(t));
  add("spf", spf.length === 1 ? (/[-~]all\s*$/i.test(spf[0]) ? "pass" : "warn") : spf.length ? "fail" : "warn", spf.length === 1 ? (/[-~]all\s*$/i.test(spf[0]) ? "One SPF record ending in a restrictive all." : "SPF does not end in -all or ~all.") : spf.length ? "More than one SPF record: receivers will ignore them." : "No SPF record.");
  const dmarc = (await txt(`_dmarc.${d}`)).filter((t) => /^v=DMARC1\b/i.test(t));
  const policy = /\bp=(none|quarantine|reject)\b/i.exec(dmarc[0] ?? "")?.[1]?.toLowerCase();
  add("dmarc", dmarc.length === 1 && policy && policy !== "none" ? "pass" : dmarc.length ? "warn" : "warn", !dmarc.length ? "No DMARC record." : policy === "none" ? "DMARC is in monitoring mode (p=none)." : `DMARC policy: ${policy ?? "unreadable"}.`);
  if (opts.dkimSelector) { const dk = (await txt(`${opts.dkimSelector}._domainkey.${d}`)).filter((t) => /v=DKIM1|p=/i.test(t)); add("dkim", dk.length ? "pass" : "fail", dk.length ? `DKIM key published for selector ${opts.dkimSelector}.` : `No DKIM key for selector ${opts.dkimSelector}.`); }
  const caa = await safe(r.resolveCaa(d), []);
  add("caa", caa.length ? "pass" : "warn", caa.length ? `CAA limits certificate issuance to: ${caa.map((c) => c.issue ?? c.issuewild).filter(Boolean).join(", ")}` : "No CAA record; any certificate authority may issue for this domain.");
  const challenge = challengeFor(d, opts.secret), controlProven = (await txt(`_lbt-challenge.${d}`)).includes(challenge) || root.includes(challenge);
  add("challenge", controlProven ? "pass" : "warn", controlProven ? "The challenge record is published: DNS control is shown." : `Publish a TXT record at _lbt-challenge.${d} with the value ${challenge} to show DNS control.`);
  return { domain: d, challenge, checks, controlProven };
}
