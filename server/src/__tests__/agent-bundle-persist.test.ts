import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { persistBundleRevision } from "../services/agent-bundle.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent-bundle persister tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("persistBundleRevision (NOR-4835)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-bundle-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(agents);
    await db.delete(companies);

    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function makeTempDir(prefix: string) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    cleanupDirs.add(dir);
    return dir;
  }

  async function seedAgent(opts: { instructionsRoot: string }) {
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
      name: "Agent 1",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {
        instructionsBundleMode: "external",
        instructionsRootPath: opts.instructionsRoot,
        instructionsEntryFile: "AGENTS.md",
      },
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("populates bundle_revision_id and bundle_assembled_at on first call (AC2/AC8)", async () => {
    const root = await makeTempDir("persist-first-call-");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Hello\n", "utf8");
    const { agentId } = await seedAgent({ instructionsRoot: root });

    const [before] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(before.bundleRevisionId).toBeNull();
    expect(before.bundleAssembledAt).toBeNull();

    const result = await persistBundleRevision(db, agentId);
    expect(result).not.toBeNull();
    expect(result!.changed).toBe(true);
    expect(result!.bundleRevisionId).toMatch(/^[a-f0-9]{64}$/);

    const [after] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(after.bundleRevisionId).toBe(result!.bundleRevisionId);
    expect(after.bundleAssembledAt).toBeInstanceOf(Date);
  });

  it("is idempotent — same revisionId + preserved assembledAt on unchanged bundle (AC3 immutable-per-revision)", async () => {
    const root = await makeTempDir("persist-idempotent-");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Same\n", "utf8");
    const { agentId } = await seedAgent({ instructionsRoot: root });

    const first = await persistBundleRevision(db, agentId);
    expect(first!.changed).toBe(true);
    const firstAssembledAt = first!.bundleAssembledAt;

    // Brief delay so any wrongly-rewritten timestamp would differ
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await persistBundleRevision(db, agentId);
    expect(second!.changed).toBe(false);
    expect(second!.bundleRevisionId).toBe(first!.bundleRevisionId);
    expect(second!.bundleAssembledAt.getTime()).toBe(firstAssembledAt.getTime());

    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row.bundleAssembledAt!.getTime()).toBe(firstAssembledAt.getTime());
  });

  it("advances revisionId and timestamp when bundle content changes", async () => {
    const root = await makeTempDir("persist-content-change-");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Original\n", "utf8");
    const { agentId } = await seedAgent({ instructionsRoot: root });

    const first = await persistBundleRevision(db, agentId);
    const firstRev = first!.bundleRevisionId;
    const firstTs = first!.bundleAssembledAt.getTime();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Updated\n", "utf8");

    const second = await persistBundleRevision(db, agentId);
    expect(second!.changed).toBe(true);
    expect(second!.bundleRevisionId).not.toBe(firstRev);
    expect(second!.bundleAssembledAt.getTime()).toBeGreaterThan(firstTs);
  });

  it("returns null when the agent does not exist (AC8 graceful null handling)", async () => {
    const result = await persistBundleRevision(db, randomUUID());
    expect(result).toBeNull();
  });

  it("survives a simulated process restart — stored values are reusable (AC7 restart persistence)", async () => {
    const root = await makeTempDir("persist-restart-");
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Stable\n", "utf8");
    const { agentId } = await seedAgent({ instructionsRoot: root });

    const before = await persistBundleRevision(db, agentId);
    expect(before!.changed).toBe(true);
    const stableRev = before!.bundleRevisionId;
    const stableTs = before!.bundleAssembledAt.getTime();

    // Simulate restart: drop the in-process reference; re-query via DB only.
    const [rowAfterRestart] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(rowAfterRestart.bundleRevisionId).toBe(stableRev);
    expect(rowAfterRestart.bundleAssembledAt!.getTime()).toBe(stableTs);

    // Recompute through the persister; values must be preserved (idempotent
    // across a "restart", per AC7).
    const after = await persistBundleRevision(db, agentId);
    expect(after!.changed).toBe(false);
    expect(after!.bundleRevisionId).toBe(stableRev);
    expect(after!.bundleAssembledAt.getTime()).toBe(stableTs);
  });
});
