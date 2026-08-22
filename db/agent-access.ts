import { getD1 } from "./index";

type AgentTokenRow = {
  id: string;
  owner_id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
};

type AgentRequestRow = {
  payload_hash: string;
  status: "pending" | "completed";
  result_json: string | null;
};

export type AgentAccessStatus = {
  active: boolean;
  name: string | null;
  createdAt: string | null;
  lastUsedAt: string | null;
};

export async function getAgentAccessStatus(ownerId: string): Promise<AgentAccessStatus> {
  const row = await getD1().prepare(
    `SELECT name, created_at, last_used_at
     FROM agent_access_tokens
     WHERE owner_id = ? AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  ).bind(ownerId).first<Omit<AgentTokenRow, "id" | "owner_id">>();
  return {
    active: Boolean(row),
    name: row?.name ?? null,
    createdAt: row?.created_at ?? null,
    lastUsedAt: row?.last_used_at ?? null,
  };
}

export async function createAgentAccessToken(ownerId: string): Promise<string> {
  const token = `rosie_${randomHex(32)}`;
  const now = new Date().toISOString();
  await getD1().batch([
    getD1().prepare(
      `UPDATE agent_access_tokens SET revoked_at = ?
       WHERE owner_id = ? AND revoked_at IS NULL`,
    ).bind(now, ownerId),
    getD1().prepare(
      `INSERT INTO agent_access_tokens
       (id, owner_id, name, token_hash, created_at, last_used_at, revoked_at)
       VALUES (?, ?, 'Hermes', ?, ?, NULL, NULL)`,
    ).bind(crypto.randomUUID(), ownerId, await sha256(token), now),
  ]);
  return token;
}

export async function revokeAgentAccess(ownerId: string): Promise<void> {
  await getD1().prepare(
    `UPDATE agent_access_tokens SET revoked_at = ?
     WHERE owner_id = ? AND revoked_at IS NULL`,
  ).bind(new Date().toISOString(), ownerId).run();
}

export async function authenticateAgentToken(rawToken: string): Promise<{ ownerId: string; tokenId: string } | null> {
  if (!rawToken.startsWith("rosie_") || rawToken.length > 128) return null;
  const row = await getD1().prepare(
    `SELECT id, owner_id, name, created_at, last_used_at
     FROM agent_access_tokens
     WHERE token_hash = ? AND revoked_at IS NULL LIMIT 1`,
  ).bind(await sha256(rawToken)).first<AgentTokenRow>();
  if (!row) return null;
  await getD1().prepare(
    "UPDATE agent_access_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(new Date().toISOString(), row.id).run();
  return { ownerId: row.owner_id, tokenId: row.id };
}

export async function claimAgentRequest(
  ownerId: string,
  idempotencyKey: string,
  payload: unknown,
): Promise<{ state: "claimed" } | { state: "completed"; result: unknown } | { state: "pending" }> {
  const payloadHash = await sha256(stableJson(payload));
  try {
    await getD1().prepare(
      `INSERT INTO agent_action_requests
       (owner_id, idempotency_key, payload_hash, status, result_json, created_at, completed_at)
       VALUES (?, ?, ?, 'pending', NULL, ?, NULL)`,
    ).bind(ownerId, idempotencyKey, payloadHash, new Date().toISOString()).run();
    return { state: "claimed" };
  } catch (error) {
    if (!String(error).toLowerCase().includes("unique")) throw error;
  }

  const existing = await getD1().prepare(
    `SELECT payload_hash, status, result_json FROM agent_action_requests
     WHERE owner_id = ? AND idempotency_key = ?`,
  ).bind(ownerId, idempotencyKey).first<AgentRequestRow>();
  if (!existing) throw new Error("Der Wiederholungsschutz konnte nicht geprüft werden.");
  if (existing.payload_hash !== payloadHash) {
    throw new Error("Diese idempotency_key wurde bereits für andere Angaben verwendet.");
  }
  if (existing.status === "completed" && existing.result_json) {
    return { state: "completed", result: JSON.parse(existing.result_json) as unknown };
  }
  return { state: "pending" };
}

export async function completeAgentRequest(
  ownerId: string,
  idempotencyKey: string,
  result: unknown,
): Promise<void> {
  await getD1().prepare(
    `UPDATE agent_action_requests
     SET status = 'completed', result_json = ?, completed_at = ?
     WHERE owner_id = ? AND idempotency_key = ? AND status = 'pending'`,
  ).bind(JSON.stringify(result), new Date().toISOString(), ownerId, idempotencyKey).run();
}

export async function releaseAgentRequest(ownerId: string, idempotencyKey: string): Promise<void> {
  await getD1().prepare(
    `DELETE FROM agent_action_requests
     WHERE owner_id = ? AND idempotency_key = ? AND status = 'pending'`,
  ).bind(ownerId, idempotencyKey).run();
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
