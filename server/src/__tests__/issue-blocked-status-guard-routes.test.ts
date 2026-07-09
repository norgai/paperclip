import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";

const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  getStatusesByIds: vi.fn(),
  update: vi.fn(),
  create: vi.fn(),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
  findMentionedAgents: vi.fn(async () => []),
}));

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

const baseIssue = {
  id: "issue-1",
  companyId: "company-1",
  identifier: "NOR-1",
  title: "Test issue",
  description: null,
  status: "todo",
  priority: "medium",
  parentId: null,
  assigneeAgentId: null,
  assigneeUserId: null,
  createdByAgentId: null,
  createdByUserId: null,
  executionWorkspaceId: null,
  labels: [],
  labelIds: [],
  executionPolicy: null,
  executionState: null,
};

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(err?.status ?? 500).json({ error: err?.message ?? "Internal server error" });
  });
  return app;
}

describe("blocked-status guard on PATCH /api/issues/:id", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getAncestors.mockResolvedValue([]);
  });

  it("rejects status=blocked with no blocker edges (test 1)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "todo" });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no unresolved blockers/);
  });

  it("rejects status=blocked when the only blocker edge is done (test 2)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "todo" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "00000000-0000-0000-0000-000000000002", status: "done", title: "Blocker", identifier: "NOR-2", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      blocks: [],
    });
    mockIssueService.getStatusesByIds.mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000002", status: "done" }]);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolved/);
  });

  it("rejects status=blocked when the only blocker edge is cancelled (test 3)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "todo" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "00000000-0000-0000-0000-000000000002", status: "cancelled", title: "Blocker", identifier: "NOR-2", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      blocks: [],
    });
    mockIssueService.getStatusesByIds.mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000002", status: "cancelled" }]);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolved/);
  });

  it("allows status=blocked when there is one unresolved (todo) blocker edge (test 4)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "todo" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "00000000-0000-0000-0000-000000000002", status: "todo", title: "Blocker", identifier: "NOR-2", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      blocks: [],
    });
    mockIssueService.getStatusesByIds.mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000002", status: "todo" }]);
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked" });

    expect(res.status).toBe(200);
  });

  it("allows status=blocked + blockedByIssueIds with one unresolved in the same request (test 5)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "todo" });
    mockIssueService.getStatusesByIds.mockResolvedValue([{ id: "00000000-0000-0000-0000-000000000002", status: "in_progress" }]);
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "00000000-0000-0000-0000-000000000002", status: "in_progress", title: "Blocker", identifier: "NOR-2", priority: "medium", assigneeAgentId: null, assigneeUserId: null }],
      blocks: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ status: "blocked", blockedByIssueIds: ["00000000-0000-0000-0000-000000000002"] });

    expect(res.status).toBe(200);
  });

  it("does not fire the guard when patching an unrelated field on a blocked issue (test 6)", async () => {
    mockIssueService.getById.mockResolvedValue({ ...baseIssue, status: "blocked" });
    mockIssueService.update.mockResolvedValue({ ...baseIssue, status: "blocked", title: "Updated title" });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);

    const res = await request(createApp())
      .patch("/api/issues/issue-1")
      .send({ title: "Updated title" });

    expect(res.status).toBe(200);
    // Guard must not have been called.
    expect(mockIssueService.getStatusesByIds).not.toHaveBeenCalled();
    expect(mockIssueService.getRelationSummaries).not.toHaveBeenCalled();
  });
});
