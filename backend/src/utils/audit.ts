import { PoolClient } from "pg";

export async function createAuditLog(params: {
  client: PoolClient;
  actorUserId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  beforeData?: Record<string, unknown> | null;
  afterData?: Record<string, unknown> | null;
}) {
  const { client, actorUserId, action, entity, entityId, beforeData, afterData } = params;

  await client.query(
    `
      INSERT INTO audit_logs (actor_user_id, action, entity, entity_id, before_data, after_data)
      VALUES ($1, $2, $3, $4, $5, $6)
    `,
    [actorUserId, action, entity, entityId, beforeData ?? null, afterData ?? null],
  );
}
