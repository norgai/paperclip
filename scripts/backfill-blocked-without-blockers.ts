/**
 * CLI wrapper for the one-shot `blocked` ∧ no-unresolved-blocker sweep (NOR-125).
 * Dry run by default; pass --apply to persist.
 */
import { createDb } from "@paperclipai/db";
import { backfillBlockedWithoutBlockers } from "../server/src/services/issues.js";

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }

  const apply = process.argv.includes("--apply");
  const plan = await backfillBlockedWithoutBlockers(createDb(dbUrl), { apply });

  if (plan.length === 0) {
    console.log("No blocked issues violate the invariant; nothing to reconcile");
    process.exit(0);
  }

  for (const entry of plan) {
    console.log(`${entry.identifier}: blocked -> ${entry.nextStatus}`);
  }

  if (!apply) {
    console.log(`Dry run: ${plan.length} issues would be reconciled`);
    console.log("Re-run with --apply to persist changes");
    process.exit(0);
  }

  console.log(`Reconciled ${plan.length} issues`);
  process.exit(0);
}

void main();
