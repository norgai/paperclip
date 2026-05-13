import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { agentInstructionsService } from "./agent-instructions.js";

type BundleAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

export type AssembledBundle = {
  text: string;
  revisionId: string;
  manifest: string[];
  entryFile: string;
  warnings: string[];
};

export type PersistedBundleRevision = {
  bundleRevisionId: string;
  bundleAssembledAt: Date;
  changed: boolean;
  assembled: AssembledBundle;
};

/**
 * Canonical bundle assembly. Pure compute: takes an agent's instruction files
 * (via `agentInstructionsService.exportFiles`) and produces a deterministic
 * concatenated text + SHA-256 revisionId.
 *
 * Canonicalization rules:
 *   - File entries are sorted by `relativePath` (lexicographic on the
 *     UTF-16 code-unit order JavaScript `Array.sort` gives, matching the
 *     existing alphabetical order produced by `listFilesRecursive`).
 *   - Each entry is emitted as `<<<FILE:relativePath>>>\n{content}\n`.
 *   - The hash input is the UTF-8 byte sequence of the concatenation.
 *
 * Two identical bundles MUST produce the same `revisionId`. Any change to
 * file names, content, or set membership MUST produce a different
 * `revisionId`.
 */
export async function assembleBundle(agent: BundleAgent): Promise<AssembledBundle> {
  const instructions = agentInstructionsService();
  const exported = await instructions.exportFiles(agent);

  const manifest = Object.keys(exported.files).sort();
  const text = manifest
    .map((relativePath) => `<<<FILE:${relativePath}>>>\n${exported.files[relativePath]}\n`)
    .join("");
  const revisionId = createHash("sha256").update(text, "utf8").digest("hex");

  return {
    text,
    revisionId,
    manifest,
    entryFile: exported.entryFile,
    warnings: exported.warnings,
  };
}

/**
 * Idempotent persister. Computes the current revisionId via `assembleBundle`
 * and upserts `bundleRevisionId` + `bundleAssembledAt` on `agents`.
 *
 * Immutable-per-revision semantic (CTO clarification, NOR-4835 cmt 0b5f5960):
 * `bundleAssembledAt` advances only when `revisionId` changes. Re-computes
 * against an unchanged bundle preserve the existing `bundleAssembledAt`.
 *
 * Returns the persisted state and a `changed` flag indicating whether the
 * stored revision was actually rewritten.
 */
export async function persistBundleRevision(
  db: Db,
  agentId: string,
): Promise<PersistedBundleRevision | null> {
  const [row] = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      adapterConfig: agents.adapterConfig,
      bundleRevisionId: agents.bundleRevisionId,
      bundleAssembledAt: agents.bundleAssembledAt,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!row) return null;

  const assembled = await assembleBundle({
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    adapterConfig: row.adapterConfig,
  });

  if (row.bundleRevisionId === assembled.revisionId && row.bundleAssembledAt) {
    return {
      bundleRevisionId: row.bundleRevisionId,
      bundleAssembledAt: row.bundleAssembledAt,
      changed: false,
      assembled,
    };
  }

  const now = new Date();
  await db
    .update(agents)
    .set({
      bundleRevisionId: assembled.revisionId,
      bundleAssembledAt: now,
    })
    .where(eq(agents.id, agentId));

  return {
    bundleRevisionId: assembled.revisionId,
    bundleAssembledAt: now,
    changed: true,
    assembled,
  };
}
