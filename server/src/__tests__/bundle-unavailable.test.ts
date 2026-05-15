import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agentRuntimeState,
  agents,
  companies,
  createDb,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { recordBundleUnavailable } from "../services/bundle-unavailable.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres bundle-unavailable tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("recordBundleUnavailable (NOR-4837 Part 3, AC10–14)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-bundle-unavail-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedAgentWithRuntime(): Promise<{ agentId: string; companyId: string }> {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Bundle Agent",
      role: "engineer",
      status: "active",
      adapterType: "openclaw_gateway",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(agentRuntimeState).values({
      agentId,
      companyId,
      adapterType: "openclaw_gateway",
      stateJson: {},
    });
    return { agentId, companyId };
  }

  it("writes an activity_log row with action=bundle_unavailable + structured details (AC11+AC12)", async () => {
    const { agentId, companyId } = await seedAgentWithRuntime();
    const event = {
      agentId,
      attemptedRevisionId: "a".repeat(64),
      jobId: "job-1",
      ts: "2026-05-15T06:00:00.000Z",
      lastRetryError: "ENOENT: file missing",
    };

    const result = await recordBundleUnavailable(db, event);
    expect(result).not.toBeNull();
    expect(result!.duplicate).toBe(false);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, result!.activityLogId));
    expect(row.companyId).toBe(companyId);
    expect(row.actorType).toBe("system");
    expect(row.actorId).toBe("openclaw-gateway");
    expect(row.action).toBe("bundle_unavailable");
    expect(row.entityType).toBe("agent");
    expect(row.entityId).toBe(agentId);
    expect(row.agentId).toBe(agentId);
    expect(row.details).toMatchObject({
      agentId,
      attemptedRevisionId: event.attemptedRevisionId,
      jobId: event.jobId,
      ts: event.ts,
      lastRetryError: event.lastRetryError,
      duplicate: false,
    });
  });

  it("updates agent_runtime_state.state_json.lastBundleError (AC11)", async () => {
    const { agentId } = await seedAgentWithRuntime();
    const fixedNow = new Date("2026-05-15T06:30:00.000Z");
    const event = {
      agentId,
      attemptedRevisionId: "b".repeat(64),
      jobId: "job-2",
      ts: "2026-05-15T06:29:00.000Z",
      lastRetryError: "timeout",
    };

    await recordBundleUnavailable(db, event, { now: () => fixedNow });

    const [row] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    const state = row.stateJson as Record<string, unknown>;
    expect(state.lastBundleError).toMatchObject({
      attemptedRevisionId: event.attemptedRevisionId,
      jobId: event.jobId,
      ts: event.ts,
      lastRetryError: event.lastRetryError,
      recordedAt: fixedNow.toISOString(),
    });
  });

  it("preserves other state_json keys via jsonb_set (no clobber)", async () => {
    const { agentId } = await seedAgentWithRuntime();
    await db
      .update(agentRuntimeState)
      .set({ stateJson: { sessionId: "abc", customCounter: 7 } })
      .where(eq(agentRuntimeState.agentId, agentId));

    await recordBundleUnavailable(db, {
      agentId,
      attemptedRevisionId: "c".repeat(64),
      jobId: "job-3",
      ts: "2026-05-15T06:31:00.000Z",
      lastRetryError: null,
    });

    const [row] = await db
      .select()
      .from(agentRuntimeState)
      .where(eq(agentRuntimeState.agentId, agentId));
    const state = row.stateJson as Record<string, unknown>;
    expect(state.sessionId).toBe("abc");
    expect(state.customCounter).toBe(7);
    expect(state.lastBundleError).toBeDefined();
  });

  it("tags the second row as duplicate when {agentId, jobId, attemptedRevisionId} matches a prior row (AC14)", async () => {
    const { agentId } = await seedAgentWithRuntime();
    const event = {
      agentId,
      attemptedRevisionId: "d".repeat(64),
      jobId: "job-4",
      ts: "2026-05-15T06:40:00.000Z",
      lastRetryError: "remote fail",
    };

    const first = await recordBundleUnavailable(db, event);
    const second = await recordBundleUnavailable(db, event);

    expect(first!.duplicate).toBe(false);
    expect(second!.duplicate).toBe(true);

    const rows = await db
      .select()
      .from(activityLog)
      .where(
        and(
          eq(activityLog.agentId, agentId),
          eq(activityLog.action, "bundle_unavailable"),
        ),
      );
    expect(rows).toHaveLength(2);
    const duplicates = rows.filter((r) => (r.details as Record<string, unknown>).duplicate === true);
    expect(duplicates).toHaveLength(1);
  });

  it("returns null and writes nothing when the agent does not exist", async () => {
    const result = await recordBundleUnavailable(db, {
      agentId: randomUUID(),
      attemptedRevisionId: "e".repeat(64),
      jobId: "job-5",
      ts: "2026-05-15T06:50:00.000Z",
      lastRetryError: null,
    });
    expect(result).toBeNull();

    const all = await db.select().from(activityLog);
    expect(all).toHaveLength(0);
  });

  it("treats null lastRetryError as a first-class value (AC13)", async () => {
    const { agentId } = await seedAgentWithRuntime();
    const result = await recordBundleUnavailable(db, {
      agentId,
      attemptedRevisionId: "f".repeat(64),
      jobId: "job-6",
      ts: "2026-05-15T07:00:00.000Z",
      lastRetryError: null,
    });
    expect(result!.duplicate).toBe(false);

    const [row] = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.id, result!.activityLogId));
    expect((row.details as Record<string, unknown>).lastRetryError).toBeNull();
  });
});
