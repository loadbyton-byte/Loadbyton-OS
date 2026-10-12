import type { Child } from "hono/jsx";
import { config } from "../config.js";

/**
 * The wordmark as set in the logo: LOAD, a stacked B over Y between two red bars, then TON.
 * Plain text elsewhere (page titles, emails, documents) keeps the literal string "LOAD|BY|TON".
 */
export const Lbt = ({ tag }: { tag?: string }) => (
  <span class="lbt" data-notranslate role="img" aria-label={tag ? `LOAD BY TON ${tag}` : "LOAD BY TON"}>
    LOAD<span class="by" aria-hidden="true"><i></i><b><span>B</span><span>Y</span></b><i></i></span>TON{tag ? <span class="tag" aria-hidden="true">{tag}</span> : null}
  </span>
);

const WORD = "LOAD|BY|TON";
/** Render text, replacing every literal LOAD|BY|TON with the drawn wordmark. Everything else is passed through unchanged. */
export function Brandy({ text }: { text: string }) {
  if (!text.includes(WORD)) return <>{text}</>;
  const parts = text.split(WORD);
  return <>{parts.map((p, i) => <>{p}{i < parts.length - 1 ? <Lbt /> : null}</>)}</>;
}
export const B = (text: string): Child => <Brandy text={text} />;

const digits = (s: string) => s.replace(/[^\d]/g, "");
export const CONTACT = {
  phone: config.contact.phone,
  phoneDisplay: (() => { const d = digits(config.contact.phone); return d.length === 12 && d.startsWith("91") ? `+91 ${d.slice(2, 7)} ${d.slice(7)}` : config.contact.phone; })(),
  tel: `tel:${config.contact.phone.replace(/[^\d+]/g, "")}`,
  emails: config.contact.emails,
};
export const waLink = (text = "Hi LOAD|BY|TON, I would like to know more about the platform.") =>
  `https://wa.me/${digits(config.contact.phone)}?text=${encodeURIComponent(text)}`;

/** True while the live chat is staffed (hours are configured per deployment). */
export function chatStaffed(now = new Date()): boolean {
  try {
    const h = Number(new Intl.DateTimeFormat("en-GB", { timeZone: config.contact.chatTz, hour: "2-digit", hour12: false }).format(now)) % 24;
    return h >= config.contact.chatFromHour && h < config.contact.chatToHour;
  } catch { return false; }
}

/**
 * The offer on show. A deployment can set OFFER_* variables; otherwise a standing monthly onboarding offer runs to the last day of the
 * current month (so the date shown is always a real, fixed deadline, never a countdown that resets per visitor). OFFER_ENDS_ON=off hides it.
 */
export function activeOffer(now = new Date()) {
  const o = config.offer;
  if (o.endsOn.toLowerCase() === "off") return null;
  let end: Date;
  if (o.endsOn && /^\d{4}-\d{2}-\d{2}$/.test(o.endsOn)) end = new Date(`${o.endsOn}T23:59:59+05:30`);
  else { const ist = new Date(now.getTime() + 5.5 * 3600e3); end = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 1) - 5.5 * 3600e3 - 1000); }
  if (end.getTime() <= now.getTime()) return null;
  return {
    code: o.code || "ONBOARD",
    title: o.title || "Free onboarding call and customer import",
    detail: o.detail || "Start a workspace this month and we will set it up with you on a call and import your customer list from a spreadsheet — no extra charge.",
    endsAt: end.toISOString(),
    endsLabel: end.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Kolkata" }),
  };
}
