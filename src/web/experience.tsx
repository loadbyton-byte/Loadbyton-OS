import type { Child } from "hono/jsx";

const P: Record<string, string> = {
  grid: "M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z",
  arrow: "M5 12h14 M13 6l6 6-6 6",
  arrowUpRight: "M7 17L17 7 M8 7h9v9",
  arrowLeft: "M19 12H5 M11 18l-6-6 6-6",
  chevron: "M9 6l6 6-6 6",
  check: "M5 12l5 5 9-10",
  x: "M6 6l12 12 M18 6L6 18",
  plus: "M12 5v14 M5 12h14",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z M15.5 15.5L21 21",
  bell: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9z M13.7 21a2 2 0 0 1-3.4 0",
  user: "M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M4 21c0-4 3.6-6 8-6s8 2 8 6",
  people: "M8 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M2 20c0-3.6 2.7-5.5 6-5.5s6 1.9 6 5.5 M16.5 5a3.2 3.2 0 0 1 0 6.3 M18 14.8c2.4.5 4 2.2 4 5.2",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z M8.5 12l2.5 2.5L16 9.5",
  truck: "M2 6h12v11H2z M14 10h4l4 4v3h-8 M6.5 17.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z M17.5 17.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z",
  document: "M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6",
  money: "M3 6h18v12H3z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z M6.5 12h.01 M17.5 12h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3.5 2",
  mail: "M3 6h18v12H3z M3.5 7l8.5 6 8.5-6",
  phone: "M6 3h3l2 5-2.2 1.4a11 11 0 0 0 5.8 5.8L16 13l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 4 5a2 2 0 0 1 2-2z",
  whatsapp: "M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z M9 8.5c.3 2.6 2.4 5 5.4 6l1.2-1.6-2.2-1-.9.9a5.4 5.4 0 0 1-2-2l.9-.9-1-2.2z",
  chat: "M4 5h16v11H10l-5 4v-4H4z",
  globe: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M3 12h18 M12 3c3.5 3 3.5 15 0 18 M12 3c-3.5 3-3.5 15 0 18",
  box: "M12 3l9 4.5v9L12 21l-9-4.5v-9z M3 7.5l9 4.5 9-4.5 M12 12v9",
  warehouse: "M3 21V9l9-5 9 5v12 M7 21v-7h10v7 M7 17.5h10",
  ship: "M3 16l2 4h14l2-4z M5 16V10h9l5 3v3 M9 10V5h4v5",
  plane: "M10 13L3 10.5 4 9l8 1 5-6 2 1-3 7 5 3-1 2-7-2-3 5-2-1z",
  lock: "M6 11h12v10H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  chart: "M4 20V4 M4 20h16 M8 16v-5 M12 16V8 M16 16v-3",
  layers: "M12 3l9 5-9 5-9-5z M3 12.5l9 5 9-5 M3 16.5l9 5 9-5",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z",
  sun: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 M17.5 17.5L19 19 M5 19l1.5-1.5 M17.5 6.5L19 5",
  settings: "M4 7h9 M17 7h3 M4 17h3 M11 17h9 M15 5v4 M9 15v4",
  home: "M3 11l9-8 9 8 M5.5 9.5V21h13V9.5",
  calendar: "M4 6h16v14H4z M4 10h16 M8 3v4 M16 3v4",
  pin: "M12 21s7-6 7-11a7 7 0 1 0-14 0c0 5 7 11 7 11z M12 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  gift: "M4 9h16v4H4z M6 13h12v8H6z M12 9v12 M12 9c-2 0-4-1-4-2.5S9.5 4 12 6c2.5-2 4-.5 4 .5S14 9 12 9z",
  star: "M12 3l2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17l-5.6 3.3 1.2-6.3L3 9.6l6.3-.8z",
  route: "M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M8 17h5a4 4 0 0 0 4-4V9",
  parcel: "M3 8l9-5 9 5v8l-9 5-9-5z M3 8l9 5 9-5 M12 13v8 M7.5 5.5l9 5",
  scale: "M12 4v16 M7 20h10 M5 7h14 M5 7l-3 7a3 3 0 0 0 6 0z M19 7l-3 7a3 3 0 0 0 6 0z",
  thermo: "M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z",
  external: "M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6",
  send: "M3.5 11.5L20 4l-6.5 16-2.5-6.5z",
  headset: "M4 14v-2a8 8 0 0 1 16 0v2 M4 13h3v6H4z M17 13h3v6h-3z M17 19c0 1.6-2 2-5 2",
  tag: "M3 12V4h8l10 10-8 8z M7.5 8.5h.01",
  download: "M12 4v12 M7 11l5 5 5-5 M5 20h14",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
  gauge: "M4 17a8 8 0 1 1 16 0 M12 17l4-6",
  alert: "M12 8v5 M12 16.5h.01 M10.3 4.2L2.5 18a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
  info: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 11v5 M12 7.5h.01",
  logout: "M10 4H5v16h5 M15 8l4 4-4 4 M19 12H9",
  anchor: "M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M12 5v16 M5 12H3a9 9 0 0 0 18 0h-2 M8 9h8",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6",
  users: "M8 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z M2 20c0-3.6 2.7-5.5 6-5.5s6 1.9 6 5.5",
};

export function Icon({ name = "grid", size = 20 }: { name?: string; size?: number }) {
  return <svg class="ui-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={P[name] ?? P.grid} /></svg>;
}

/** Icon shown for a workspace section in the rail and the workspaces hub. */
export const SECTION_ICON: Record<string, string> = {
  "": "home", Sell: "people", Operate: "layers", Money: "money", Transport: "truck", Fulfilment: "box", Warehouse: "warehouse", Delivery: "parcel",
  Customs: "shield", "Specialist cases": "star", Admin: "settings",
};
export const SECTION_BLURB: Record<string, string> = {
  Sell: "Customers, enquiries, quotations, supplier rates and tenders.",
  Operate: "Jobs, documents, tasks and exceptions, and the shared inbox.",
  Money: "Invoices, collections, supplier bills and the owner dashboard.",
  Transport: "Plan trips, assign drivers and vehicles, follow live trips and reconcile cost.",
  Fulfilment: "Merchant stock, inbound, pick, pack, ship and returns.",
  Warehouse: "Custody stock, receiving, dispatch, counts and activity billing.",
  Delivery: "Parcels, runs, riders, cash on delivery and merchant remittance.",
  Customs: "Declaration cases, evidence, approvals, deposits and handover packs.",
  "Specialist cases": "Sector-specific case files for your selected specialist workflows.",
  Admin: "Team, plan and billing, settings, connections, data controls and audit.",
};
export const slugOf = (s: string) => (s || "home").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Shared two-panel frame for sign-in, sign-up and recovery. */
export function AuthFrame({ signup = false, children }: { signup?: boolean; children: Child }) {
  return <section class={`auth-layout ${signup ? "auth-signup" : ""}`}>
    <aside class="auth-story">
      <img class="auth-photo" src="/assets/photo/product/auth-operations.webp" alt="" />
      <div class="auth-story-content">
        <span class="eyebrow"><span class="signal-dot"></span>YOUR LOGISTICS · CONNECTED</span>
        <h2>{signup ? "A new chapter.\nOne workspace." : "Back to the\noperating record."}</h2>
        <p>From the first enquiry to the final collection, one place for every team to move the work forward.</p>
        <div class="auth-proofs">
          <div><Icon name="shield" /><span><strong>Your company, your records</strong><small>Tenant isolation and role-based access.</small></span></div>
          <div><Icon name="document" /><span><strong>Evidence stays with the work</strong><small>Documents, approvals and milestones together.</small></span></div>
          <div><Icon name="money" /><span><strong>Keep the margin in view</strong><small>Estimates and reconciled outcomes kept apart.</small></span></div>
        </div>
        <a href="/security" class="auth-trust">Explore our security controls <Icon name="arrow" /></a>
      </div>
    </aside>
    <div class="auth-main"><div class="auth-panel">{children}</div></div>
  </section>;
}
