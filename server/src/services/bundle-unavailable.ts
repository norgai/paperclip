/**
 * BundleUnavailable persister — write side for the inbound
 * `bundle_unavailable` agent_control frame (NOR-4837 Part 3, AC10–14).
 *
 * The openclaw-gateway adapter receives the frame, validates required
 * fields, and calls `recordBundleUnavailable()` to persist. Two writes
 * happen per call: one `activity_log` row (AC11+AC12), and one update
 * to `agent_runtime_state.state_json.lastBundleError` (AC11) so operators
 * can read the latest failure without scanning logs.
 *
 * NOR-4835 added bundle revision tracking to the `agents` table but did
 * NOT add a dedicated `last_bundle_error` column to `agent_runtime_state`.
 * To avoid a migration mid-story we satisfy AC11 by storing the failure
 * inside the existing `state_json` JSONB column under the key
 * `lastBundleError`. The spec explicitly allows this:
 * "update the runtime-state column added in NOR-4835 (`lastBundleError`
 *  / equivalent)" — `state_json.lastBundleError` is the equivalent.
 *
 * Idempotency (AC14): the same `{agentId, jobId, attemptedRevisionId}`
 * triple may arrive twice if the gateway retries its own ack. Both rows
 * are recorded; the second is tagged `duplicate: true` in `details`.
 */
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agentRuntimeState, agents } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const log = logger.child({ service: "bundle-unavailable" });

export interface BundleUnavailableEvent {
  agentId: string;
  attemptedRevisionId: string;
  jobId: string;
  ts: string;
  lastRetryError: string | null;
}

export interface RecordBundleUnavailableResult {
  duplicate: boolean;
  activityLogId: string;
}

export interface BundleUnavailableDeps {
  /** Override for unit tests so we can assert without spinning up Postgres. */
  now?: () => Date;
}

export async function recordBundleUnavailable(
  db: Db,
  event: BundleUnavailableEvent,
  deps: BundleUnavailableDeps = {},
): Promise<RecordBundleUnavailableResult | null> {
  const now = deps.now ?? (() => new Date());

  // Resolve companyId from the agents row. If the agent has been deleted
  // between dispatch and the upstream failure callback, we have no FK
  // target for activity_log — log WARN and bail. This is rare but real.
  const agentRow = await db
    .select({ id: agents.id, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, event.agentId))
    .then((rows) => rows[0] ?? null);
  if (!agentRow) {
    log.warn(
      { agentId: event.agentId, jobId: event.jobId },
      "bundle_unavailable received for unknown agent; dropping",
    );
    return null;
  }

  // AC14: check for an earlier `bundle_unavailable` row with the same
  // {agentId, jobId, attemptedRevisionId} triple. If found, mark this one
  // as a duplicate. We do not block or merge — both rows are persisted.
  const priorRow = await db
    .select({ id: activityLog.id })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, agentRow.companyId),
        eq(activityLog.agentId, event.agentId),
        eq(activityLog.action, "bundle_unavailable"),
        sql`${activityLog.details} ->> 'jobId' = ${event.jobId}`,
        sql`${activityLog.details} ->> 'attemptedRevisionId' = ${event.attemptedRevisionId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  const duplicate = priorRow !== null;

  const details: Record<string, unknown> = {
    agentId: event.agentId,
    attemptedRevisionId: event.attemptedRevisionId,
    jobId: event.jobId,
    ts: event.ts,
    lastRetryError: event.lastRetryError,
    duplicate,
  };

  const inserted = await db
    .insert(activityLog)
    .values({
      companyId: agentRow.companyId,
      actorType: "system",
      actorId: "openclaw-gateway",
      action: "bundle_unavailable",
      entityType: "agent",
      entityId: event.agentId,
      agentId: event.agentId,
      details,
    })
    .returning({ id: activityLog.id })
    .then((rows) => rows[0]);

  // AC11: update agent_runtime_state.state_json.lastBundleError so the
  // latest failure surfaces in existing read APIs without operators
  // scanning the log. Use jsonb_set on the existing state_json column.
  // Cast Date to text inside SQL via parameter binding — drizzle handles it.
  const lastBundleError = {
    attemptedRevisionId: event.attemptedRevisionId,
    jobId: event.jobId,
    ts: event.ts,
    lastRetryError: event.lastRetryError,
    recordedAt: now().toISOString(),
  };

  await db
    .update(agentRuntimeState)
    .set({
      stateJson: sql`jsonb_set(
        coalesce(${agentRuntimeState.stateJson}, '{}'::jsonb),
        '{lastBundleError}',
        ${JSON.stringify(lastBundleError)}::jsonb,
        true
      )`,
      updatedAt: now(),
    })
    .where(eq(agentRuntimeState.agentId, event.agentId));

  return {
    duplicate,
    activityLogId: inserted.id,
  };
}
