import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { REDACTED_EVENT_VALUE } from "../redaction.js";

// NOR-4845 — `GET /companies/:companyId/agents` and `GET /agents/:id` must redact
// raw adapter/runtime config for any actor who is NOT an instance-admin-like
// board actor (i.e. isInstanceAdmin or local_implicit) AND not the agent
// inspecting its own row. Board users with `agents:create` permission do NOT
// receive raw secrets via these endpoints — they must use
// `/agents/:id/configuration` (which is gated separately and applies structural
// redaction via `redactEventPayload`).

const companyId = "22222222-2222-4222-8222-222222222222";
const agentAId = "11111111-1111-4111-8111-111111111111";
const agentBId = "33333333-3333-4333-8333-333333333333";

const sensitiveAdapterConfig = {
  url: "wss://eagle-2.norg.ai/",
  headers: {
    "x-openclaw-token": "wss-bearer-abc",
    "CF-Access-Client-Id": "cf-client-id-value",
    "CF-Access-Client-Secret": "cf-client-secret-value",
    "content-type": "application/json",
  },
  devicePrivateKeyPem: "-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n",
  scopes: ["operator.admin"],
};

const sensitiveRuntimeConfig = {
  heartbeat: { enabled: true, intervalSec: 60 },
  apiKey: "secret-api-key",
};

function makeAgent(id: string) {
  return {
    id,
    companyId,
    name: `Agent ${id.slice(0, 4)}`,
    urlKey: `agent-${id.slice(0, 4)}`,
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "openclaw_gateway",
    adapterConfig: sensitiveAdapterConfig,
    runtimeConfig: sensitiveRuntimeConfig,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-19T00:00:00.000Z"),
  };
}

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  list: vi.fn(),
  getChainOfCommand: vi.fn(),
  resolveByReference: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

function registerServiceMocks() {
  vi.doMock("@paperclipai/shared/telemetry", () => ({
    trackAgentCreated: vi.fn(),
    trackErrorHandlerCrash: vi.fn(),
  }));
  vi.doMock("../telemetry.js", () => ({
    getTelemetryClient: mockGetTelemetryClient,
  }));
  vi.doMock("../services/index.js", () => ({
    agentService: () => mockAgentService,
    agentInstructionsService: () => ({ materializeManagedBundle: vi.fn() }),
    accessService: () => mockAccessService,
    approvalService: () => ({ create: vi.fn(), getById: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => ({ upsertPolicy: vi.fn() }),
    heartbeatService: () => ({ listTaskSessions: vi.fn(), resetRuntimeSession: vi.fn() }),
    issueApprovalService: () => ({ linkManyForApproval: vi.fn() }),
    issueService: () => ({ list: vi.fn() }),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));
}

function createDbStub() {
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          then: vi.fn().mockResolvedValue([
            { id: companyId, name: "Paperclip", requireBoardApprovalForNewAgents: false },
          ]),
        }),
      }),
    }),
  };
}

async function createApp(actor: Record<string, unknown>) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/agents.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = actor;
    next();
  });
  app.use("/api", agentRoutes(createDbStub() as any));
  app.use(errorHandler);
  return app;
}

describe("NOR-4845 — adapter/runtime config redaction on agent listing + detail", () => {
  beforeEach(() => {
    vi.resetModules();
    registerServiceMocks();
    vi.resetAllMocks();
    mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
    mockAgentService.getById.mockImplementation(async (id: string) => {
      if (id === agentAId) return makeAgent(agentAId);
      if (id === agentBId) return makeAgent(agentBId);
      return null;
    });
    mockAgentService.list.mockResolvedValue([makeAgent(agentAId), makeAgent(agentBId)]);
    mockAgentService.getChainOfCommand.mockResolvedValue([]);
    mockAccessService.getMembership.mockResolvedValue(null);
    mockAccessService.listPrincipalGrants.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockSecretService.resolveAdapterConfigForRuntime.mockImplementation(
      async (_companyId, config) => ({ config }),
    );
    mockLogActivity.mockResolvedValue(undefined);
  });

  describe("GET /companies/:companyId/agents (listing)", () => {
    it("instance-admin board actor receives raw adapter/runtime config", async () => {
      const app = await createApp({
        type: "board",
        userId: "admin-user",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/companies/${companyId}/agents`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0].adapterConfig.headers["x-openclaw-token"]).toBe("wss-bearer-abc");
      expect(res.body[0].adapterConfig.devicePrivateKeyPem).toContain("BEGIN PRIVATE KEY");
      expect(res.body[0].runtimeConfig.apiKey).toBe("secret-api-key");
    });

    it("local_implicit board actor receives raw adapter/runtime config", async () => {
      const app = await createApp({
        type: "board",
        userId: "local-user",
        source: "local_implicit",
        isInstanceAdmin: false,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/companies/${companyId}/agents`);

      expect(res.status).toBe(200);
      expect(res.body[0].adapterConfig.headers["x-openclaw-token"]).toBe("wss-bearer-abc");
    });

    it("board actor WITHOUT instance-admin (even with agents:create) receives redacted config", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      const app = await createApp({
        type: "board",
        userId: "regular-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/companies/${companyId}/agents`);

      expect(res.status).toBe(200);
      // Keys preserved, secret values redacted
      expect(res.body[0].adapterConfig.headers["x-openclaw-token"]).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].adapterConfig.headers["CF-Access-Client-Id"]).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].adapterConfig.headers["CF-Access-Client-Secret"]).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].adapterConfig.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
      expect(res.body[0].runtimeConfig.apiKey).toBe(REDACTED_EVENT_VALUE);
      // Non-sensitive fields still visible
      expect(res.body[0].adapterConfig.url).toBe("wss://eagle-2.norg.ai/");
      expect(res.body[0].adapterConfig.headers["content-type"]).toBe("application/json");
    });

    it("agent actor receives raw config for its own row and redacted config for others", async () => {
      const app = await createApp({
        type: "agent",
        agentId: agentAId,
        companyId,
      });

      const res = await request(app).get(`/api/companies/${companyId}/agents`);

      expect(res.status).toBe(200);
      const selfRow = res.body.find((row: any) => row.id === agentAId);
      const otherRow = res.body.find((row: any) => row.id === agentBId);
      expect(selfRow.adapterConfig.headers["x-openclaw-token"]).toBe("wss-bearer-abc");
      expect(otherRow.adapterConfig.headers["x-openclaw-token"]).toBe(REDACTED_EVENT_VALUE);
      expect(otherRow.adapterConfig.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
    });
  });

  describe("GET /agents/:id", () => {
    it("instance-admin board actor receives raw config", async () => {
      const app = await createApp({
        type: "board",
        userId: "admin-user",
        source: "session",
        isInstanceAdmin: true,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/agents/${agentAId}`);

      expect(res.status).toBe(200);
      expect(res.body.adapterConfig.headers["x-openclaw-token"]).toBe("wss-bearer-abc");
      expect(res.body.adapterConfig.devicePrivateKeyPem).toContain("BEGIN PRIVATE KEY");
    });

    it("board actor WITHOUT instance-admin receives redacted config", async () => {
      mockAccessService.canUser.mockResolvedValue(true);
      const app = await createApp({
        type: "board",
        userId: "regular-user",
        source: "session",
        isInstanceAdmin: false,
        companyIds: [companyId],
      });

      const res = await request(app).get(`/api/agents/${agentAId}`);

      expect(res.status).toBe(200);
      expect(res.body.adapterConfig.headers["x-openclaw-token"]).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.adapterConfig.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.runtimeConfig.apiKey).toBe(REDACTED_EVENT_VALUE);
    });

    it("agent actor receives raw config when inspecting its own record", async () => {
      const app = await createApp({
        type: "agent",
        agentId: agentAId,
        companyId,
      });

      const res = await request(app).get(`/api/agents/${agentAId}`);

      expect(res.status).toBe(200);
      expect(res.body.adapterConfig.headers["x-openclaw-token"]).toBe("wss-bearer-abc");
    });

    it("agent actor receives redacted config when inspecting another agent", async () => {
      mockAccessService.hasPermission.mockResolvedValue(true);
      const app = await createApp({
        type: "agent",
        agentId: agentAId,
        companyId,
      });

      const res = await request(app).get(`/api/agents/${agentBId}`);

      expect(res.status).toBe(200);
      expect(res.body.adapterConfig.headers["x-openclaw-token"]).toBe(REDACTED_EVENT_VALUE);
      expect(res.body.adapterConfig.devicePrivateKeyPem).toBe(REDACTED_EVENT_VALUE);
    });
  });
});
