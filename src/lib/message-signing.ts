import crypto from "node:crypto";

/**
 * Message signing for bank-grade APIs: a detached JWS over the request body (RFC 7515 / RFC 7797 "b64": false), the Cavage HTTP Signature with a body Digest
 * (the NextGenPSD2 / Berlin Group profile), and the private_key_jwt client assertion (RFC 7523) for token endpoints. Keys are PEM; the algorithm is the caller's
 * choice among PS256, RS256 and ES256. Nothing here talks to a bank: it produces the headers and assertions a profile asks for.
 */
export type SignAlg = "PS256" | "RS256" | "ES256";
export const SIGN_ALGS: SignAlg[] = ["PS256", "RS256", "ES256"];
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signBytes(alg: SignAlg, keyPem: string, data: Buffer | string): Buffer {
  const key = crypto.createPrivateKey(keyPem);
  if (alg === "PS256") return crypto.sign("sha256", Buffer.from(data), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  if (alg === "RS256") return crypto.sign("sha256", Buffer.from(data), key);
  return crypto.sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" });
}
export function verifyBytes(alg: SignAlg, certOrPublicPem: string, data: Buffer | string, sig: Buffer): boolean {
  const key = crypto.createPublicKey(certOrPublicPem);
  if (alg === "PS256") return crypto.verify("sha256", Buffer.from(data), { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig);
  if (alg === "RS256") return crypto.verify("sha256", Buffer.from(data), key, sig);
  return crypto.verify("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" }, sig);
}
/** Checks a PEM private key is usable for the algorithm (an RSA key for PS256/RS256, an EC P-256 key for ES256). */
export function checkKeyForAlg(alg: SignAlg, keyPem: string) {
  let k: crypto.KeyObject;
  try { k = crypto.createPrivateKey(keyPem); } catch { throw new Error("The signing key is not a valid PEM private key (unencrypted PKCS#8 or PKCS#1)."); }
  if (alg === "ES256" ? !(k.asymmetricKeyType === "ec" && k.asymmetricKeyDetails?.namedCurve === "prime256v1") : k.asymmetricKeyType !== "rsa") throw new Error(`The key does not suit ${alg}: ${alg === "ES256" ? "ES256 needs an EC P-256 key" : `${alg} needs an RSA key`}.`);
  if (k.asymmetricKeyType === "rsa" && (k.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("RSA keys must be at least 2048 bits.");
}

/** Detached JWS (header..signature) over the payload bytes, unencoded payload per RFC 7797. `extra` adds header parameters such as iat or banking-specific claims. */
export function detachedJws(payload: Buffer | string, o: { alg: SignAlg; kid: string; key: string; extra?: Record<string, unknown>; crit?: string[] }): string {
  const header = { alg: o.alg, kid: o.kid, b64: false, crit: ["b64", ...(o.crit ?? [])], ...(o.extra ?? {}) };
  const h = b64u(JSON.stringify(header));
  const input = Buffer.concat([Buffer.from(`${h}.`), Buffer.from(payload)]);
  return `${h}..${b64u(signBytes(o.alg, o.key, input))}`;
}
export function verifyDetachedJws(jws: string, payload: Buffer | string, certPem: string): boolean {
  const [h, empty, s] = jws.split(".");
  if (!h || empty !== "" || !s) return false;
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  if (header.b64 !== false || !SIGN_ALGS.includes(header.alg)) return false;
  return verifyBytes(header.alg, certPem, Buffer.concat([Buffer.from(`${h}.`), Buffer.from(payload)]), Buffer.from(s, "base64url"));
}

/** Cavage HTTP Signature with a SHA-256 Digest of the body: headers Digest, Date and Signature. */
export function httpSignature(o: { method: string; url: string; body?: string; keyId: string; key: string; alg: SignAlg; now?: Date; extraHeaders?: Record<string, string> }): Record<string, string> {
  const u = new URL(o.url), date = (o.now ?? new Date()).toUTCString();
  const digest = `SHA-256=${crypto.createHash("sha256").update(o.body ?? "").digest("base64")}`;
  const signed: Record<string, string> = { "(request-target)": `${o.method.toLowerCase()} ${u.pathname}${u.search}`, host: u.host, date, digest, ...Object.fromEntries(Object.entries(o.extraHeaders ?? {}).map(([k, v]) => [k.toLowerCase(), v])) };
  const names = Object.keys(signed);
  const base = names.map((n) => `${n}: ${signed[n]}`).join("\n");
  const algName = o.alg === "ES256" ? "ecdsa-sha256" : o.alg === "RS256" ? "rsa-sha256" : "rsa-pss-sha256";
  const sig = signBytes(o.alg, o.key, base).toString("base64");
  return { digest, date, ...(o.extraHeaders ?? {}), signature: `keyId="${o.keyId}",algorithm="${algName}",headers="${names.join(" ")}",signature="${sig}"` };
}

/** private_key_jwt: the client proves itself to the token endpoint with a short-lived signed assertion instead of a shared secret. */
export function clientAssertion(o: { clientId: string; audience: string; alg: SignAlg; kid: string; key: string; now?: number; ttlSeconds?: number }): string {
  const iat = Math.floor((o.now ?? Date.now()) / 1000);
  const h = b64u(JSON.stringify({ alg: o.alg, typ: "JWT", kid: o.kid })), p = b64u(JSON.stringify({ iss: o.clientId, sub: o.clientId, aud: o.audience, jti: crypto.randomUUID(), iat, exp: iat + (o.ttlSeconds ?? 120) }));
  return `${h}.${p}.${b64u(signBytes(o.alg, o.key, `${h}.${p}`))}`;
}
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
