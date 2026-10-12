import type { Child } from "hono/jsx";
import { Icon } from "./experience.js";
import { CONTACT, waLink } from "./brand.js";

export const PHOTO = {
  fleet: "/assets/freight/fleet.webp", port: "/assets/freight/port.webp", road: "/assets/freight/road.webp", warehouse: "/assets/freight/warehouse.webp",
  chassis: "/assets/freight/chassis.webp", coldchain: "/assets/freight/coldchain.webp", crane: "/assets/freight/crane.webp", crossdock: "/assets/freight/crossdock.webp",
  gate: "/assets/freight/gate.webp", customs: "/assets/freight/customs.webp", corridor: "/assets/freight/corridor.webp", boxtruck: "/assets/freight/boxtruck.webp",
  flatbed: "/assets/freight/flatbed.webp", yard: "/assets/freight/yard.webp",
};

/** Dark photographic hero used by every sub page. */
export function PageHero({ kicker, title, lede, photo = PHOTO.port, children, crumb }: { kicker: string; title: Child; lede?: Child; photo?: string; children?: Child; crumb?: string }) {
  return (
    <section class="page-hero">
      <img src={photo} alt="" fetchpriority="high" />
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
