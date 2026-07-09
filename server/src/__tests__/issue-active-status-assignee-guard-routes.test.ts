import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getRelationSummaries: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  addComment: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
  listWakeableBlockedDependents: vi.fn(async () => []),
  getWakeableParentAfterChildCompletion: vi.fn(async () => null),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(async () => true),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  wakeup: vi.fn(async () => undefined),
  reportRunActivity: vi.fn(async () => undefined),
  getRun: vi.fn(async () => null),
  getActiveRunForAgent: vi.fn(async () => null),
  cancelRun: vi.fn(async () => null),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));
const mockTx = vi.hoisted(() => ({
  insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
}));
const mockDb = vi.hoisted(() => ({
  transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
}));

function registerServiceMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentTaskCompleted: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: vi.fn(() => ({ track: vi.fn() })),
  }));
  vi.doMock("../services/index.js", () => ({
    accessService: () => mockAccessService,
    agentService: () => ({ getById: vi.fn() }),
    documentService: () => ({ getIssueDocumentPayload: vi.fn(async () => ({})) }),
    executionWorkspaceService: () => ({ getById: vi.fn(async () => null) }),
    feedbackService: () => ({}),
    goalService: () => ({ getById: vi.fn(), getDefaultCompanyGoal: vi.fn() }),
    heartbeatService: () => mockHeartbeatService,
    instanceSettingsService: () => ({
      get: vi.fn(async () => ({
        id: "instance-settings-1",
        general: { censorUsernameInLogs: false, feedbackDataSharingPreference: "prompt" },
      })),
      listCompanyIds: vi.fn(async () => ["company-1"]),
    }),
    issueApprovalService: () => ({}),
    issueService: () => mockIssueService,
    logActivity: mockLogActivity,
    projectService: () => ({ getById: vi.fn(), listByIds: vi.fn(async () => []) }),
    routineService: () => ({ syncRunStatusForIssue: vi.fn(async () => undefined) }),
    workProductService: () => ({ listForIssue: vi.fn(async () => []) }),
  }));
  vi.doMock("../services/issue-assignment-wakeup.js", () => ({
    queueIssueAssignmentWakeup: vi.fn(async () => undefined),
  }));
}

function createApp() {
  const app = express();
  app.use(express.json());
  return app;
}

async function installActor(app: express.Express) {
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/issues.js"),
    import("../middleware/index.js"),
  ]);
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: true,
    };
    next();
  });
  app.use("/api", issueRoutes(mockDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

const COMPANY_ID = "company-1";
const ISSUE_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const USER_ID = "user-1";
const AGENT_ID = "aaaaaaaa-1111-0000-0000-000000000001";

function makeExistingIssue(status: string, assigneeAgentId: string | null = null, assigneeUserId: string | null = null) {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    title: "Test issue",
    status,
    assigneeAgentId,
    assigneeUserId,
    executionState: null,
    executionPolicy: null,
    createdByUserId: null,
    createdByAgentId: null,
    projectId: null,
    goalId: null,
    parentId: null,
    priority: "medium",
    identifier: "NOR-999",
  };
}

describe("active-status assignee guard — POST /api/companies/:companyId/issues", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    registerServiceMocks();
  });

  it("1. rejects create with status:todo and no assignee → 400", async () => {
    const app = await installActor(createApp());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "My issue", status: "todo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignee/i);
  });

  it("2. allows create with status:backlog and no assignee → 201", async () => {
    const createdIssue = { id: ISSUE_ID, companyId: COMPANY_ID, title: "My issue", status: "backlog", assigneeAgentId: null, assigneeUserId: null };
    mockIssueService.create.mockResolvedValue(createdIssue);
    const app = await installActor(createApp());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "My issue", status: "backlog" });
    expect(res.status).toBe(201);
  });

  it("3. allows create with status:todo + assigneeUserId → 201", async () => {
    const createdIssue = { id: ISSUE_ID, companyId: COMPANY_ID, title: "My issue", status: "todo", assigneeAgentId: null, assigneeUserId: USER_ID };
    mockIssueService.create.mockResolvedValue(createdIssue);
    mockAccessService.hasPermission.mockResolvedValue(true);
    const app = await installActor(createApp());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "My issue", status: "todo", assigneeUserId: USER_ID });
    expect(res.status).toBe(201);
  });

  it("also rejects in_progress, in_review, blocked with no assignee", async () => {
    const app = await installActor(createApp());
    for (const status of ["in_progress", "in_review", "blocked"]) {
      const res = await request(app)
        .post(`/api/companies/${COMPANY_ID}/issues`)
        .send({ title: "My issue", status });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/assignee/i);
    }
  });

  it("allows create with default status (no status field) and no assignee → 201 (backlog default)", async () => {
    const createdIssue = { id: ISSUE_ID, companyId: COMPANY_ID, title: "My issue", status: "backlog", assigneeAgentId: null, assigneeUserId: null };
    mockIssueService.create.mockResolvedValue(createdIssue);
    const app = await installActor(createApp());
    const res = await request(app)
      .post(`/api/companies/${COMPANY_ID}/issues`)
      .send({ title: "My issue" });
    expect(res.status).toBe(201);
  });
});

describe("active-status assignee guard — PATCH /api/issues/:id", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    registerServiceMocks();
  });

  it("4. rejects PATCH backlog→todo with no assignee → 400", async () => {
    mockIssueService.getById.mockResolvedValue(makeExistingIssue("backlog"));
    const app = await installActor(createApp());
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "todo" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignee/i);
  });

  it("5. rejects PATCH assigneeAgentId:null on a todo issue → 400", async () => {
    mockIssueService.getById.mockResolvedValue(makeExistingIssue("todo", AGENT_ID));
    const app = await installActor(createApp());
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/assignee/i);
  });

  it("6. allows PATCH assigneeAgentId:null on a backlog issue → 200", async () => {
    mockIssueService.getById.mockResolvedValue(makeExistingIssue("backlog", AGENT_ID));
    const updatedIssue = makeExistingIssue("backlog", null);
    mockIssueService.update.mockResolvedValue(updatedIssue);
    const app = await installActor(createApp());
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ assigneeAgentId: null });
    expect(res.status).toBe(200);
  });

  it("7. allows PATCH status:done with no assignee → 200", async () => {
    mockIssueService.getById.mockResolvedValue(makeExistingIssue("todo", AGENT_ID));
    const updatedIssue = makeExistingIssue("done");
    mockIssueService.update.mockResolvedValue(updatedIssue);
    const app = await installActor(createApp());
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "done", assigneeAgentId: null });
    expect(res.status).toBe(200);
  });

  it("8. allows PATCH blocked→backlog with no assignee (reconciliation path) → 200", async () => {
    mockIssueService.getById.mockResolvedValue(makeExistingIssue("blocked"));
    const updatedIssue = makeExistingIssue("backlog");
    mockIssueService.update.mockResolvedValue(updatedIssue);
    const app = await installActor(createApp());
    const res = await request(app)
      .patch(`/api/issues/${ISSUE_ID}`)
      .send({ status: "backlog" });
    expect(res.status).toBe(200);
  });
});
