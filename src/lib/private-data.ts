/**
 * We never want a client's private identifiers in a message, a request or a brand note: tax registration numbers, bank accounts, card
 * numbers and passwords go into the client's own admin panel, which we teach them to use. This is a safety net for the obvious cases,
 * not a data-loss-prevention product: it catches shapes (a 15-digit TRN, an IBAN, a card number) and spoken secrets ("password: ...").
 */
export type PrivateHit = "trn" | "iban" | "card" | "secret";

const digits = (s: string) => s.replace(/[\s-]/g, "");

function luhn(n: string) {
  let sum = 0, alt = false;
  for (let i = n.length - 1; i >= 0; i--) {
    let d = n.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d; alt = !alt;
  }
  return sum % 10 === 0;
}

/** First kind of private detail found in `text`, or null. */
export function findPrivateData(text: string): PrivateHit | null {
  const t = String(text ?? "");
  // A secret said out loud: "password: hunter2", "my otp is 123456", "api key sk_..."
  if (/\b(pass(word|code)?|pwd|otp|pin|secret|api[\s_-]?key|token)\b\s*(is|=|:)\s*\S{4,}/i.test(t)) return "secret";
  // IBAN: two letters, two check digits, then up to 30 alphanumerics (spaces allowed); UAE is AE + 21 digits
  for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{3,4}){3,8}\b/g)) {
    const c = m[0].replace(/ /g, "");
    if (c.length >= 15 && c.length <= 34 && /[0-9]{6}/.test(c)) return "iban";
  }
  // numbers: a UAE tax registration number is 15 digits; a card is 13-19 digits that pass the Luhn check
  for (const m of t.matchAll(/(?<![\d])(?:\d[ -]?){13,19}(?![\d])/g)) {
    const d = digits(m[0]);
    if (d.length === 15 && d.startsWith("100")) return "trn";
    if (luhn(d)) return "card";
    if (d.length === 15) return "trn";
  }
  return null;
}

const WHY: Record<PrivateHit, string> = {
  trn: "That looks like a tax registration number (TRN).",
  iban: "That looks like a bank account number (IBAN).",
  card: "That looks like a payment card number.",
  secret: "That looks like a password, code or key.",
};

/** The sentence shown to the client when we refuse a message. It points to the guide rather than just saying no. */
export const privateDataMessage = (hit: PrivateHit) =>
  `${WHY[hit]} Please don't send it to us. You enter it yourself in your own admin panel, and we will show you exactly where (see "Add your private details" in your dashboard). Remove it and send again.`;

export function assertNoPrivateData(text: string, fail: (m: string) => Error) {
  const hit = findPrivateData(text);
  if (hit) throw fail(privateDataMessage(hit));
}
