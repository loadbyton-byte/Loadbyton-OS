import { forbidden } from "./util.js";

export const ROLES = ["owner", "sales", "pricing", "coordinator", "dispatcher", "warehouse", "finance", "hr", "auditor", "portal", "driver"] as const;
export type Role = (typeof ROLES)[number];

export type Perm =
  | "read" | "party.write" | "enquiry.write" | "quote.write" | "quote.approve" | "rate.write"
  | "job.write" | "job.cost" | "doc.write" | "finance.write" | "finance.void" | "team.manage"
  | "billing.manage" | "settings.manage" | "export" | "audit.read" | "dashboard.owner"
  | "transport.write" | "transport.expense" | "driver.act" | "wh.write" | "wh.approve" | "wh.bill";

const R: Record<Role, Perm[]> = {
  owner: ["read", "party.write", "enquiry.write", "quote.write", "quote.approve", "rate.write", "job.write", "job.cost", "doc.write",
    "finance.write", "finance.void", "team.manage", "billing.manage", "settings.manage", "export", "audit.read", "dashboard.owner", "transport.write", "transport.expense", "wh.write", "wh.approve", "wh.bill"],
  sales: ["read", "party.write", "enquiry.write", "quote.write"],
  pricing: ["read", "rate.write", "quote.write", "quote.approve"],
  coordinator: ["read", "party.write", "enquiry.write", "job.write", "doc.write", "job.cost", "transport.write", "wh.write", "wh.approve"],
  dispatcher: ["read", "job.write", "doc.write", "transport.write"],
  warehouse: ["read", "doc.write", "wh.write"],   // operates stock; cannot approve its own count adjustments
  finance: ["read", "job.cost", "finance.write", "export", "dashboard.owner", "transport.expense", "wh.approve", "wh.bill"],
  hr: ["read", "team.manage"],
  auditor: ["read", "audit.read", "export"],
  portal: [],
  driver: ["driver.act"],   // limited seat: sees only trips assigned to them
};

export function permsFor(roles: string[]): Set<Perm> {
  const s = new Set<Perm>();
  for (const r of roles) for (const p of R[r as Role] ?? []) s.add(p);
  return s;
}

/** Everything an operating-plane action needs to know about who is acting. */
export interface Ctx {
  userId: string;
  tenantId: string;
  roles: string[];
  perms: Set<Perm>;
  partyId: string | null;          // portal users
  driverId: string | null;         // driver users
  readOnly: boolean;               // support-grant sessions are read-only
  supportStaffId: string | null;   // actor identity preserved for audit when a grant is used
}

export function require(ctx: Ctx, perm: Perm) {
  if (!ctx.perms.has(perm)) throw forbidden(`Your role does not allow this action (${perm}).`);
  if (ctx.readOnly && perm !== "read" && perm !== "export" && perm !== "audit.read" && perm !== "dashboard.owner") {
    throw forbidden("This session is read-only (support access).");
  }
}
export const actorOf = (ctx: Ctx) =>
  ctx.supportStaffId
    ? ({ kind: "support_grant", userId: ctx.supportStaffId } as const)
    : ({ kind: "user", userId: ctx.userId } as const);
