import type { Conn } from "../db/client.js";

export interface Actor { kind: "user" | "system" | "platform_staff" | "support_grant"; userId?: string | null }

export async function audit(
  c: Conn, tenantId: string | null, actor: Actor, action: string,
  entityType?: string, entityId?: string, data?: unknown,
) {
  await c.query(
    `INSERT INTO audit_log(tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, data)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, actor.userId ?? null, actor.kind, action, entityType ?? null, entityId ?? null, data ? JSON.stringify(data) : null],
  );
}
