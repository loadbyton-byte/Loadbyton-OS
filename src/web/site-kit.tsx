import type { Child } from "hono/jsx";
import { Icon } from "./experience.js";
import { CONTACT, waLink } from "./brand.js";

const SECTOR_DIR = "/assets/photo/sectors/";
/** Photograph for one of the eighteen sector packs. `small` is the 800px card crop. */
export const sectorPhoto = (slug: string, small = false) => `${SECTOR_DIR}${slug}${small ? "-800" : ""}.webp`;

/** Every photograph on the site, grouped by role. Hero scenes, sector scenes and product (workspace) scenes are three separate sets. */
export const PHOTO = {
  fleet: "/assets/photo/hero/fleet.webp", port: "/assets/photo/hero/port.webp", road: "/assets/photo/hero/road.webp",
  onboarding: "/assets/photo/product/onboarding.webp", finance: "/assets/photo/product/finance.webp",
  intelligence: "/assets/photo/product/intelligence.webp", enterprise: "/assets/photo/product/enterprise.webp",
  auth: "/assets/photo/product/auth-operations.webp",
  freight: sectorPhoto("freight-forwarding"), transport: sectorPhoto("road-transport"), warehouse: sectorPhoto("contract-warehouse-3pl"),
  customs: sectorPhoto("customs-brokerage"), depot: sectorPhoto("container-depot"), heavy: sectorPhoto("project-heavy-cargo"),
  transit: sectorPhoto("cross-border-transit"), marine: sectorPhoto("marine-agency"), distribution: sectorPhoto("distribution"),
};

/** Dark photographic hero used by every sub page. */
export function PageHero({ kicker, title, lede, photo = PHOTO.port, children, crumb }: { kicker: string; title: Child; lede?: Child; photo?: string; children?: Child; crumb?: string }) {
  return (
    <section class="page-hero">
      <img src={photo} alt="" fetchpriority="high" decoding="async" />
      <div class="wrap">
        <div class="crumbs"><a href="/">Home</a> / {crumb ?? kicker}</div>
        <span class="eyebrow"><span class="signal-dot"></span>{kicker}</span>
        <h1>{title}</h1>
        {lede ? <p class="lead">{lede}</p> : null}
        {children ? <div class="hero-actions">{children}</div> : null}
      </div>
    </section>
  );
}

export function Section({ tone = "", eyebrow, title, intro, children, id }: { tone?: "" | "alt" | "dark" | "tint"; eyebrow?: string; title?: Child; intro?: Child; children: Child; id?: string }) {
  return (
    <section class={`block ${tone}`} id={id}>
      <div class="wrap">
        {title ? (
          <div class="section-heading" data-reveal>
            <div>{eyebrow ? <span class="eyebrow">{eyebrow}</span> : null}<h2>{title}</h2></div>
            {intro ? <p>{intro}</p> : null}
          </div>
        ) : null}
        {children}
      </div>
    </section>
  );
}

export function CtaBand({ title = "Make room for better operations.", body = "Start with a real workspace. Build around your business.", primary = ["Create my free workspace", "/start"] as [string, string] }: { title?: Child; body?: Child; primary?: [string, string] }) {
  return (
    <section class="closing-cta">
      <div class="wrap" data-reveal>
        <span class="eyebrow">YOUR NEXT MOVE</span>
        <h2>{title}</h2>
        <p>{body}</p>
        <div class="actions">
          <a class="btn red" href={primary[1]}>{primary[0]} <Icon name="arrow" size={16} /></a>
          <a class="btn glass" href={waLink()} target="_blank" rel="noopener"><Icon name="whatsapp" size={18} />WhatsApp {CONTACT.phoneDisplay}</a>
          <a class="btn glass" href={`mailto:${CONTACT.emails.contact}`}><Icon name="mail" size={18} />{CONTACT.emails.contact}</a>
        </div>
      </div>
    </section>
  );
}

export function Faq({ items }: { items: [string, Child][] }) {
  return <div class="faq">{items.map(([q, a], i) => <details data-reveal open={i === 0 ? true : undefined}><summary>{q}</summary><div>{a}</div></details>)}</div>;
}

export const Ticks = ({ items }: { items: Child[] }) => <ul class="tick-list">{items.map((t) => <li><Icon name="check" size={18} />{t}</li>)}</ul>;

/** Compact card with an icon, used across feature pages. */
export function Feature({ icon, title, children, tone = "" }: { icon: string; title: string; children: Child; tone?: string }) {
  return <article class={`card spot ${tone}`} data-reveal><span class="ic-tile"><Icon name={icon} size={22} /></span><h3>{title}</h3><p class="mute" style="margin:0">{children}</p></article>;
}
