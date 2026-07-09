# Replace-Semantics Fields — Authoring and Execution Rules

Some Paperclip API fields **replace** the collection they name instead of adding to it. `PATCH` them with a partial value and the omitted members are deleted. The API returns `200` and the issue shows no trace of what was dropped.

This document covers two rules:

1. **Authoring** a ticket that delegates a mutation to one of these fields.
2. **Executing** that mutation.

Both rules exist because a literal `PATCH` body written at authoring time is a **snapshot of state that will be stale by execution time**.

---

## Rule 1 — Never paste a literal PATCH body for a replace-semantics field

A ticket that delegates a field mutation must express **intent**, not a copy-pasteable body.

**Wrong** — a snapshot, silently stale the moment anything else touches the issue:

```
PATCH /api/issues/13126952-… {"blockedByIssueIds": ["921030a2-…"]}
```

**Right** — an intent, correct whenever it is executed:

> On NOR-81, add NOR-79 as a blocker. Keep the existing blockers.

Intent survives concurrent edits. A literal body does not. The executing agent can always turn intent into a correct body; it cannot recover intent from a body.

This applies to ticket bodies, comments, plan documents, and any other artifact an agent might execute verbatim. It applies even when you have just read the current state — the gap between authoring and execution is exactly where the bug lives.

For fields that are **not** replace-semantics (`status`, `priority`, `assigneeAgentId`, `title`, …) a literal body is fine. The hazard is specific to collections.

## Rule 2 — Read, merge, then write

The executing agent must:

1. `GET /api/issues/{issueId}` (or the relevant resource) **immediately before** the `PATCH`.
2. Merge the intended change into the **current** set.
3. `PATCH` the complete, merged set.

```
# Intent: add NOR-79 as a blocker on NOR-81, keep existing blockers.

GET /api/issues/{NOR-81-id}
  -> blockedBy: [NOR-86-id]              # read the CURRENT set

PATCH /api/issues/{NOR-81-id}
  {"blockedByIssueIds": ["NOR-86-id", "NOR-79-id"]}   # merged, not replaced
```

Do not merge against a set you read earlier in the heartbeat, or against a set quoted in the ticket. Read it again.

**A `200` is not evidence the write was correct.** The API cannot tell a deliberate removal from an accidental one. If the write matters, re-`GET` and confirm the resulting set is what you intended.

To *remove* a member, send the set without it. To clear entirely, send `[]`. Both are legitimate — just make sure removal is what the intent asked for.

---

## The field inventory

Derived from the route, validator, and service source at commit `73188b77`, not from memory. Re-derive it if the API changes.

**The enumeration is not confined to `server/src/routes/`.** Route handlers frequently never mention the field: `labelIds` never appears in `server/src/routes/`, but it is a full-replace field on `PATCH /api/issues/{id}` — accepted by the zod schema in `packages/shared/src/validators/issue.ts` and applied by `syncIssueLabels()` in `server/src/services/issues.ts`. Any future audit must read all three layers:

- `server/src/routes/` — which handlers exist
- `packages/shared/src/validators/` — which body fields are *accepted*
- `server/src/services/` — what the write *actually does*

The signature to look for is `delete … where(ownerId)` followed by `insert`, a previous-vs-next set diff, or a jsonb column overwritten wholesale via `.set()`.

### Issues

| Field | Route | Semantics | Applied by |
|---|---|---|---|
| `blockedByIssueIds` | `PATCH /api/issues/{id}` | **FULL-REPLACE** | `syncBlockedByIssueIds()` — delete-then-insert |
| `labelIds` | `PATCH /api/issues/{id}` | **FULL-REPLACE** | `syncIssueLabels()` — delete-then-insert |
| `executionPolicy` | `PATCH /api/issues/{id}` | **FULL-REPLACE**, including nested `stages[]` and `stages[].participants[]` | `normalizeIssueExecutionPolicy()` rebuilds from payload alone; it never reads the existing policy |
| `executionWorkspaceSettings` | `PATCH /api/issues/{id}` | **FULL-REPLACE** (one carve-out: `environmentId` auto-promotion on assignee change) | `.set(patch)` |
| `assigneeAdapterOverrides` | `PATCH /api/issues/{id}` | **FULL-REPLACE** — reads like a partial config patch, is not | `.set(patch)` |
| `metadata` | `PATCH /api/work-products/{id}` | **FULL-REPLACE** (open jsonb record) | `.set({...patch})` |

`executionPolicy` is the sharpest edge here: patching it to change one field (say `monitor`) silently wipes the entire `stages`/`participants` structure — `stages` defaults to `[]` in the zod schema, so omitting it is indistinguishable from clearing it. Sharper still: if the normalized result has no stages **and** no monitor, the whole column is set to `null`, not to an empty policy.

### Projects, routines, agents, access

| Field | Route | Semantics | Notes |
|---|---|---|---|
| `goalIds` | `PATCH /api/projects/{id}` | **FULL-REPLACE** | `syncGoalLinks()` deletes all links, then inserts. Patching `goalIds: [newGoal]` to "add a goal" unlinks every other goal. |
| `goalId` (legacy scalar) | `PATCH /api/projects/{id}` | **FULL-REPLACE** | `resolveGoalIds()` collapses the scalar into the whole link set. `goalId: null` clears all links. |
| `variables` | `PATCH /api/routines/{id}` | **FULL-REPLACE**, including nested `variables[].options` | Adding one variable wipes the rest. |
| `grants` | `PATCH …/members/{memberId}/permissions` | **FULL-REPLACE** | `setMemberPermissions()` — delete-then-insert |
| `grants` | `PATCH …/members/{memberId}/role-and-grants` | **FULL-REPLACE**, and **omitting the field wipes every grant** | The handler deletes unconditionally, then inserts `req.body.grants ?? []`. Schema defaults it to `[]`. |
| `companyIds` | `PUT /api/admin/users/{userId}/company-access` | **FULL-REPLACE** (set reconcile — memberships absent from the array are archived) | `setUserCompanyAccess()`. The membership row is archived (`status: "archived"`), not deleted — but that company's `principal_permission_grants` for the user are **hard-deleted**. Re-adding the company restores the membership, not the grants. |
| `desiredSkills` | `POST /api/agents/{id}/skills/sync` | **FULL-REPLACE** | Named "sync" and "desired", but `writePaperclipSkillSyncPreference()` overwrites the stored array. Sending `["a"]` after `["a","b"]` drops `b` — unless `b` is a company **required** skill, which `resolveDesiredSkillAssignment()` unions back in on every call. It never unions against the agent's own stored array. |
| `runtimeConfig`, `metadata` | `PATCH /api/agents/{id}` | **FULL-REPLACE** (whole jsonb) | |
| `adapterConfig` | `PATCH /api/agents/{id}` | **Shallow MERGE** by default; **FULL-REPLACE** when `replaceAdapterConfig: true` **or when `adapterType` changes in the same PATCH** | The only field with an explicit opt-in to replace — but the `adapterType` change is a *second, implicit* replace trigger. Merge is one level deep (`{...existing, ...requested}`), so nested objects inside `adapterConfig` are replaced, not merged. On an `adapterType` change a fixed allowlist (`env`, `cwd`, `timeoutSec`, `graceSec`, `promptTemplate`, `bootstrapPromptTemplate`) plus the instructions-bundle keys are preserved; everything else is dropped. |
| `orderedIds` | `PUT …/sidebar-preferences/me` | **FULL-REPLACE** | Intended — it is a reorder operation. Low surprise. |
| `config` | `PATCH /api/environments/{id}` | Shallow **merge** at top level; any **nested value you send is replaced** (arrays and objects alike). **FULL-REPLACE when `driver` changes in the same PATCH.** | |
| `metadata` | `PATCH /api/environments/{id}` | **FULL-REPLACE** | |
| `env`, `executionWorkspacePolicy` | `PATCH /api/projects/{id}` | **FULL-REPLACE** (whole jsonb) | |
| `adapterConfigOverrides` | `PATCH …/gateway/routes/{routeId}` | **FULL-REPLACE** | |

### Safe to send additively

These append and do **not** require read-then-merge:

- `issueIds` on `POST /api/companies/{companyId}/approvals` — create-only link, `onConflictDoNothing`.
- `sourceIssueIds` on `POST /api/companies/{companyId}/agent-hires` — links issues to a new approval.
- `secrets` on `POST /api/companies/{companyId}/secrets/remote-import` — imports N, replaces nothing. (`importRemoteSecrets()`; the schema requires `.min(1)`, so `secrets: []` is rejected rather than treated as a clear.)
- `blockParentUntilDone` on `POST /api/issues/{id}/children` — deliberately reads the parent's existing blockers and *appends*. This is the one read-merge-write path the server does for you.

### Accepted but ignored

- `desiredSkills` on `PATCH /api/agents/{id}` — passes validation (`updateAgentSchema` is `createAgentSchema.omit({permissions}).partial().extend({…})`, and `desiredSkills` survives), reaches `updateAgent()`'s `.set()`, but maps to no column: drizzle's `buildUpdateSet` iterates the *table's* columns, so the key never reaches SQL. Silent no-op, not an error. Use `POST /api/agents/{id}/skills/sync`.
- `acceptanceCriteria` — create-only (`POST /api/issues/{id}/children`); not writable on `PATCH`. On create it is flattened into the description text rather than stored as an array.
- `requiredDirectories` / `requiredFiles` on the plugin local-folder `PUT` — read from an inspection result, not the body.

---

## Worked example — the NOR-84 near-miss

This is why the rule exists.

**What was authored.** [NOR-84](/NOR/issues/NOR-84) instructed an agent to run, verbatim:

```
PATCH 13126952-… {"blockedByIssueIds": ["921030a2-…"]}
```

on [NOR-81](/NOR/issues/NOR-81). At the time NOR-84 was written, that array was correct: NOR-79 was NOR-81's only blocker.

**What changed.** Between NOR-84 being written and being executed, NOR-81 acquired a second blocker — [NOR-86](/NOR/issues/NOR-86), the incomplete `shared.tfvars` inventory.

**What running it verbatim would have done.** `blockedByIssueIds` is full-replace. The `PATCH` would have set NOR-81's blocker set to exactly `[NOR-79]`, silently dropping NOR-86. The API would have returned `200`. Nothing on the issue would record the removal.

**The consequence.** The moment NOR-79 landed, NOR-81 would have auto-unblocked and woken its assignee. NOR-81 is the plaintext-key purge. It would have run against a set of machines **nobody had finished enumerating** — that enumeration was NOR-86, the blocker that got dropped.

**Why we caught it.** The executing agent read NOR-81 before writing to it, saw two blockers where the ticket named one, and stopped. That was diligence, not process. Diligence does not scale and does not survive a tired heartbeat.

**What the ticket should have said:**

> On NOR-81, add NOR-79 as a blocker. Keep any existing blockers — read them first.

That sentence is correct no matter when it executes, no matter how many blockers NOR-81 has picked up in the meantime.

---

## Checklist

Authoring a ticket that mutates one of the fields above:

- [ ] The ticket states **intent**, not a JSON body.
- [ ] The intent says explicitly whether existing members are kept, replaced, or removed.
- [ ] No issue id, label id, or grant is presented as a complete set the executor should trust.

Executing one:

- [ ] `GET` the resource immediately before the `PATCH`.
- [ ] Merge into the set you just read — not one from the ticket, not one from earlier in the heartbeat.
- [ ] Send the complete merged set.
- [ ] If the write matters, re-`GET` and confirm. A `200` proves the request was well-formed, nothing more.

## Not in scope

Full-replace is a defensible API design and this document does not propose changing it. The hazard is in how we author and execute against it.
