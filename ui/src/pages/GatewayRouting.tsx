import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { GatewayRouteWithHealth, EnvBinding } from "@paperclipai/shared";
import {
  Activity,
  AlertTriangle,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleOff,
  Network,
  Plus,
  RotateCcw,
  Shield,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { gatewayApi } from "../api/gateway";
import { agentsApi } from "../api/agents";
import { secretsApi } from "../api/secrets";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "../lib/utils";
import { EmptyState } from "../components/EmptyState";
import { Button } from "@/components/ui/button";
import { AdapterTypeDropdown, EnvVarEditor } from "../components/AgentConfigForm";
import { Field, DraftInput, DraftNumberInput, help } from "../components/agent-config-primitives";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function CircuitBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
    closed: { label: "Healthy", cls: "text-emerald-400 bg-emerald-400/10 border-emerald-400/20", icon: CheckCircle2 },
    half_open: { label: "Probing", cls: "text-amber-400 bg-amber-400/10 border-amber-400/20", icon: AlertTriangle },
    open: { label: "Open", cls: "text-red-400 bg-red-400/10 border-red-400/20", icon: XCircle },
  };
  const info = map[state] ?? map.closed;
  const Icon = info.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 border px-1.5 py-0.5 text-[11px] font-medium", info.cls)}>
      <Icon className="h-3 w-3" />
      {info.label}
    </span>
  );
}

function UsageBar({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  if (limit == null) return null;
  const pct = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()} / {limit.toLocaleString()} ({pct}%)
        </span>
      </div>
      <div className="h-1 w-full overflow-hidden bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-200",
            pct > 90 ? "bg-red-400" : pct > 60 ? "bg-amber-400" : "bg-emerald-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Route card
// ---------------------------------------------------------------------------

function RouteCard({
  route,
  onToggle,
  onDelete,
  onResetCircuit,
  isExpanded,
  onToggleExpand,
}: {
  route: GatewayRouteWithHealth;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
  onResetCircuit: () => void;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const h = route.health;
  return (
    <div className={cn("border border-border transition-colors", !route.isEnabled && "opacity-50")}>
      {/* Header */}
      <div
        className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isExpanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{route.name}</span>
              <CircuitBadge state={h.circuitState} />
              <span className="text-[11px] text-muted-foreground font-mono">P{route.priority}</span>
              <span className="text-[11px] text-muted-foreground">W{route.weight}</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5 font-mono truncate">
              {route.adapterType} → {route.model}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Quick usage summary */}
          <div className="text-right text-[11px] text-muted-foreground tabular-nums hidden sm:block">
            <div>{h.usage.day.requests} req/day</div>
            <div>{h.usage.day.tokens.toLocaleString()} tok/day</div>
          </div>
          {/* Enable toggle */}
          <button
            onClick={(e) => { e.stopPropagation(); onToggle(!route.isEnabled); }}
            className={cn(
              "relative h-5 w-9 shrink-0 border transition-colors",
              route.isEnabled
                ? "bg-emerald-500/20 border-emerald-500/40"
                : "bg-muted border-border",
            )}
          >
            <span
              className={cn(
                "absolute top-0.5 h-3.5 w-3.5 border transition-transform",
                route.isEnabled
                  ? "translate-x-4 bg-emerald-400 border-emerald-500"
                  : "translate-x-0.5 bg-muted-foreground/40 border-border",
              )}
            />
          </button>
        </div>
      </div>

      {/* Expanded detail */}
      {isExpanded && (
        <div className="border-t border-border px-4 py-3 space-y-3">
          {/* Rate limit bars */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Minute</div>
              <UsageBar label="Tokens" used={h.usage.minute.tokens} limit={route.quotaTokensPerMinute} />
              <UsageBar label="Requests" used={h.usage.minute.requests} limit={route.quotaRequestsPerMinute} />
              {!route.quotaTokensPerMinute && !route.quotaRequestsPerMinute && (
                <div className="text-[10px] text-muted-foreground/50">No limit</div>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Hour</div>
              <UsageBar label="Tokens" used={h.usage.hour.tokens} limit={route.quotaTokensPerHour} />
              <UsageBar label="Requests" used={h.usage.hour.requests} limit={route.quotaRequestsPerHour} />
              {!route.quotaTokensPerHour && !route.quotaRequestsPerHour && (
                <div className="text-[10px] text-muted-foreground/50">No limit</div>
              )}
            </div>
            <div className="space-y-1.5">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Per Day</div>
              <UsageBar label="Tokens" used={h.usage.day.tokens} limit={route.quotaTokensPerDay} />
              <UsageBar label="Requests" used={h.usage.day.requests} limit={route.quotaRequestsPerDay} />
              {!route.quotaTokensPerDay && !route.quotaRequestsPerDay && (
                <div className="text-[10px] text-muted-foreground/50">No limit</div>
              )}
            </div>
          </div>

          {/* Circuit breaker detail */}
          {route.circuitBreakerEnabled && (
            <div className="flex items-center gap-3 border border-border px-3 py-2">
              <Shield className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <div className="text-xs text-muted-foreground">
                Circuit breaker: <span className="text-foreground font-medium">{h.circuitState}</span>
                {" · "}Failures: {h.failureCount}/{route.circuitBreakerFailureThreshold}
                {" · "}Reset: {route.circuitBreakerResetSec}s
                {h.lastFailureAt && (
                  <span> · Last failure: {new Date(h.lastFailureAt).toLocaleString()}</span>
                )}
              </div>
              {h.circuitState !== "closed" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={onResetCircuit}
                >
                  <RotateCcw className="h-3 w-3 mr-1" />
                  Reset
                </Button>
              )}
            </div>
          )}

          {/* Adapter config overrides */}
          {route.adapterConfigOverrides && Object.keys(route.adapterConfigOverrides as object).length > 0 && (
            <div className="border border-border px-3 py-2">
              <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground mb-1">Adapter Config Overrides</div>
              <pre className="text-[11px] text-muted-foreground font-mono whitespace-pre-wrap break-all">
                {JSON.stringify(route.adapterConfigOverrides, null, 2)}
              </pre>
            </div>
          )}

          {/* Meta row */}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {route.timeoutSec != null && (
              <span>Timeout: {route.timeoutSec}s</span>
            )}
            <span>
              Scope: {route.agentId ? "Agent-specific" : "Company-wide"}
            </span>
            <span className="ml-auto opacity-60 text-[10px]">
              {route.id.slice(0, 8)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs text-red-400 hover:text-red-300 hover:bg-red-400/10"
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
            >
              <Trash2 className="h-3 w-3 mr-1" />
              Delete
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create route form
// ---------------------------------------------------------------------------

function CreateRouteForm({
  companyId,
  agentId,
  onCreated,
  onCancel,
}: {
  companyId: string;
  agentId?: string;
  onCreated: () => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const disabledTypes = useDisabledAdaptersSync();
  const [name, setName] = useState("");
  const [adapterType, setAdapterType] = useState("opencode_local");
  const [model, setModel] = useState("");
  const [priority, setPriority] = useState(0);
  const [weight, setWeight] = useState(100);
  const [timeoutSec, setTimeoutSec] = useState("");
  const [cbEnabled, setCbEnabled] = useState(false);
  const [cbThreshold, setCbThreshold] = useState(3);
  const [cbResetSec, setCbResetSec] = useState(300);
  const [tokPerMin, setTokPerMin] = useState("");
  const [tokPerHour, setTokPerHour] = useState("");
  const [tokPerDay, setTokPerDay] = useState("");
  const [reqPerMin, setReqPerMin] = useState("");
  const [reqPerHour, setReqPerHour] = useState("");
  const [reqPerDay, setReqPerDay] = useState("");

  // Adapter config overrides — reusing shared types
  const [maxTurns, setMaxTurns] = useState("");
  const [extraArgs, setExtraArgs] = useState("");
  const [thinkingEffort, setThinkingEffort] = useState("");
  const [envBindings, setEnvBindings] = useState<Record<string, EnvBinding> | undefined>(undefined);
  const [showAdapterConfig, setShowAdapterConfig] = useState(false);

  // Fetch adapter models for the selected adapter type (same query as AgentConfigForm)
  const { data: adapterModels } = useQuery({
    queryKey: queryKeys.agents.adapterModels(companyId, adapterType),
    queryFn: () => agentsApi.adapterModels(companyId, adapterType),
    enabled: Boolean(companyId),
  });

  // Fetch company secrets for EnvVarEditor
  const { data: availableSecrets = [] } = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: Boolean(companyId),
  });

  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) =>
      secretsApi.create(companyId, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
    },
  });

  // Model placeholder based on adapter type
  const modelPlaceholder = useMemo(() => {
    if (adapterModels?.length) {
      return `e.g. ${adapterModels[0].id}`;
    }
    const defaults: Record<string, string> = {
      opencode_local: "e.g. opencode/qwen3.6-plus-free",
      gemini_local: "e.g. auto",
      claude_local: "e.g. sonnet",
      codex_local: "e.g. o4-mini",
      cursor: "e.g. auto",
    };
    return defaults[adapterType] ?? "Model identifier";
  }, [adapterType, adapterModels]);

  const mutation = useMutation({
    mutationFn: () =>
      gatewayApi.createRoute(companyId, {
        agentId: agentId || null,
        name: name || `${adapterType}/${model}`,
        adapterType,
        model,
        priority,
        weight,
        timeoutSec: timeoutSec ? Number(timeoutSec) : null,
        circuitBreakerEnabled: cbEnabled,
        circuitBreakerFailureThreshold: cbThreshold,
        circuitBreakerResetSec: cbResetSec,
        quotaTokensPerMinute: tokPerMin ? Number(tokPerMin) : null,
        quotaTokensPerHour: tokPerHour ? Number(tokPerHour) : null,
        quotaTokensPerDay: tokPerDay ? Number(tokPerDay) : null,
        quotaRequestsPerMinute: reqPerMin ? Number(reqPerMin) : null,
        quotaRequestsPerHour: reqPerHour ? Number(reqPerHour) : null,
        quotaRequestsPerDay: reqPerDay ? Number(reqPerDay) : null,
        adapterConfigOverrides: buildAdapterConfigOverrides(),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) });
      onCreated();
    },
  });

  const inputCls = "w-full bg-transparent border border-border px-2 py-1.5 text-sm outline-none focus:border-foreground/40 transition-colors";
  const labelCls = "text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-1";

  function buildAdapterConfigOverrides(): Record<string, unknown> | null {
    const overrides: Record<string, unknown> = {};
    if (maxTurns) overrides.maxTurns = Number(maxTurns);
    if (extraArgs) overrides.extraArgs = extraArgs.split(",").map((s: string) => s.trim()).filter(Boolean);
    if (thinkingEffort) overrides.thinkingBudgetTokens = thinkingEffort;
    if (envBindings && Object.keys(envBindings).length > 0) overrides.env = envBindings;
    return Object.keys(overrides).length > 0 ? overrides : null;
  }

  return (
    <div className="border border-border p-4 space-y-4">
      <div className="text-sm font-medium flex items-center gap-2">
        <Plus className="h-4 w-4" />
        Add Route
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <div className={labelCls}>Name</div>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Primary GPT" />
        </div>
        <Field label="Adapter Type" hint={help.adapterType}>
          <AdapterTypeDropdown
            value={adapterType}
            onChange={(t) => { setAdapterType(t); setModel(""); }}
            disabledTypes={disabledTypes}
          />
        </Field>
        <Field label="Model" hint={help.model}>
          <DraftInput
            value={model}
            onCommit={setModel}
            immediate
            className={inputCls}
            placeholder={modelPlaceholder}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <div className={labelCls}>Priority</div>
            <input type="number" className={inputCls} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
          </div>
          <div>
            <div className={labelCls}>Weight</div>
            <input type="number" className={inputCls} value={weight} onChange={(e) => setWeight(Number(e.target.value))} />
          </div>
        </div>
      </div>

      {/* Quota configuration */}
      <div>
        <div className={labelCls}>Token Quotas</div>
        <div className="grid grid-cols-3 gap-2">
          <input className={inputCls} value={tokPerMin} onChange={(e) => setTokPerMin(e.target.value)} placeholder="/min" />
          <input className={inputCls} value={tokPerHour} onChange={(e) => setTokPerHour(e.target.value)} placeholder="/hour" />
          <input className={inputCls} value={tokPerDay} onChange={(e) => setTokPerDay(e.target.value)} placeholder="/day" />
        </div>
      </div>
      <div>
        <div className={labelCls}>Request Quotas</div>
        <div className="grid grid-cols-3 gap-2">
          <input className={inputCls} value={reqPerMin} onChange={(e) => setReqPerMin(e.target.value)} placeholder="/min" />
          <input className={inputCls} value={reqPerHour} onChange={(e) => setReqPerHour(e.target.value)} placeholder="/hour" />
          <input className={inputCls} value={reqPerDay} onChange={(e) => setReqPerDay(e.target.value)} placeholder="/day" />
        </div>
      </div>

      {/* Timeout & circuit breaker */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Timeout (sec)" hint={help.timeoutSec}>
          <DraftInput
            value={timeoutSec}
            onCommit={setTimeoutSec}
            immediate
            className={inputCls}
            placeholder="Use agent default"
          />
        </Field>
        <div>
          <div className={labelCls}>Circuit Breaker</div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={cbEnabled} onChange={(e) => setCbEnabled(e.target.checked)} />
              Enabled
            </label>
            {cbEnabled && (
              <>
                <input type="number" className={cn(inputCls, "w-16")} value={cbThreshold} onChange={(e) => setCbThreshold(Number(e.target.value))} title="Failure threshold" />
                <input type="number" className={cn(inputCls, "w-20")} value={cbResetSec} onChange={(e) => setCbResetSec(Number(e.target.value))} title="Reset seconds" />
              </>
            )}
          </div>
        </div>
      </div>

      {/* Adapter config overrides (collapsible) — reuses shared adapter components */}
      <div>
        <button
          type="button"
          onClick={() => setShowAdapterConfig(!showAdapterConfig)}
          className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
        >
          {showAdapterConfig ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          Adapter Config Overrides
        </button>
        {showAdapterConfig && (
          <div className="mt-2 space-y-3 border-l-2 border-border pl-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Max turns per run" hint={help.maxTurnsPerRun}>
                <DraftNumberInput
                  value={maxTurns ? Number(maxTurns) : 0}
                  onCommit={(v) => setMaxTurns(v ? String(v) : "")}
                  immediate
                  className={inputCls}
                  placeholder="e.g. 1000"
                />
              </Field>
              <Field label="Thinking effort" hint={help.thinkingEffort}>
                <DraftInput
                  value={thinkingEffort}
                  onCommit={setThinkingEffort}
                  immediate
                  className={inputCls}
                  placeholder="e.g. high"
                />
              </Field>
              <Field label="Extra args (comma-separated)" hint={help.extraArgs}>
                <DraftInput
                  value={extraArgs}
                  onCommit={setExtraArgs}
                  immediate
                  className={inputCls}
                  placeholder="--verbose, --foo=bar"
                />
              </Field>
            </div>
            <Field label="Environment variables" hint={help.envVars}>
              <EnvVarEditor
                value={envBindings ?? {}}
                secrets={availableSecrets}
                onCreateSecret={async (name, value) => {
                  const created = await createSecret.mutateAsync({ name, value });
                  return created;
                }}
                onChange={(env) => setEnvBindings(env)}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" onClick={() => mutation.mutate()} disabled={!model || mutation.isPending}>
          {mutation.isPending ? "Creating…" : "Create Route"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        {mutation.error && (
          <span className="text-xs text-red-400">{(mutation.error as Error).message}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function GatewayRouting({ agentId }: { agentId?: string }) {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [expandedRoutes, setExpandedRoutes] = useState<Set<string>>(new Set());

  const companyId = selectedCompanyId ?? "";

  useEffect(() => {
    if (!agentId) {
      setBreadcrumbs([{ label: "Gateway Routing" }]);
    }
  }, [setBreadcrumbs, agentId]);

  const { data: routes, isLoading } = useQuery({
    queryKey: queryKeys.gateway.routes(companyId, agentId),
    queryFn: () => gatewayApi.listRoutes(companyId, agentId),
    enabled: !!companyId,
    refetchInterval: 10_000,
    staleTime: 3_000,
  });

  const toggleMut = useMutation({
    mutationFn: ({ routeId, isEnabled }: { routeId: string; isEnabled: boolean }) =>
      gatewayApi.updateRoute(companyId, routeId, { isEnabled }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  const deleteMut = useMutation({
    mutationFn: (routeId: string) => gatewayApi.deleteRoute(companyId, routeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  const resetCircuitMut = useMutation({
    mutationFn: (routeId: string) => gatewayApi.resetCircuit(companyId, routeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.gateway.routes(companyId, agentId) }),
  });

  // Group routes by priority
  const groupedRoutes = useMemo(() => {
    if (!routes) return [];
    const map = new Map<number, GatewayRouteWithHealth[]>();
    for (const route of routes) {
      const group = map.get(route.priority) ?? [];
      group.push(route);
      map.set(route.priority, group);
    }
    return Array.from(map.entries()).sort(([a], [b]) => b - a);
  }, [routes]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Network} message="Select a company to configure gateway routing." />;
  }

  const toggleExpand = (id: string) =>
    setExpandedRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Stats summary
  const totalRoutes = routes?.length ?? 0;
  const enabledRoutes = routes?.filter((r) => r.isEnabled).length ?? 0;
  const openCircuits = routes?.filter((r) => r.health.circuitState === "open").length ?? 0;
  const halfOpenCircuits = routes?.filter((r) => r.health.circuitState === "half_open").length ?? 0;

  return (
    <div className="space-y-5">
      {/* Header */}
      {!agentId && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Gateway Routing</h1>
            <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground">
              Multi-vendor model routing with quota management, rate limiting, and circuit breaking.
            </p>
          </div>
          <Button size="sm" onClick={() => setShowCreateForm(true)} disabled={showCreateForm}>
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            Add Route
          </Button>
        </div>
      )}

      {/* Stats tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Routes</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Network className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-lg font-semibold tabular-nums">{totalRoutes}</span>
            <span className="text-xs text-muted-foreground">({enabledRoutes} active)</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Circuit Open</div>
          <div className="mt-1 flex items-center gap-1.5">
            <CircleOff className={cn("h-3.5 w-3.5", openCircuits > 0 ? "text-red-400" : "text-muted-foreground")} />
            <span className={cn("text-lg font-semibold tabular-nums", openCircuits > 0 && "text-red-400")}>{openCircuits}</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Probing</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Zap className={cn("h-3.5 w-3.5", halfOpenCircuits > 0 ? "text-amber-400" : "text-muted-foreground")} />
            <span className="text-lg font-semibold tabular-nums">{halfOpenCircuits}</span>
          </div>
        </div>
        <div className="border border-border px-3 py-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Healthy</div>
          <div className="mt-1 flex items-center gap-1.5">
            <Activity className="h-3.5 w-3.5 text-emerald-400" />
            <span className="text-lg font-semibold tabular-nums">{enabledRoutes - openCircuits - halfOpenCircuits}</span>
          </div>
        </div>
      </div>

      {/* Inline agent add-route button */}
      {agentId && !showCreateForm && (
        <Button size="sm" variant="outline" onClick={() => setShowCreateForm(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add Route
        </Button>
      )}

      {/* Create form */}
      {showCreateForm && (
        <CreateRouteForm
          companyId={companyId}
          agentId={agentId}
          onCreated={() => setShowCreateForm(false)}
          onCancel={() => setShowCreateForm(false)}
        />
      )}

      {/* Route list grouped by priority */}
      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 border border-border animate-pulse bg-muted/20" />
          ))}
        </div>
      ) : totalRoutes === 0 ? (
        <EmptyState
          icon={ArrowUpDown}
          message="No gateway routes configured. Add routes to enable multi-vendor model routing with automatic failover."
        />
      ) : (
        <div className="space-y-4">
          {groupedRoutes.map(([priority, group]) => (
            <div key={priority}>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  Priority {priority}
                </span>
                <span className="text-[10px] text-muted-foreground">
                  ({group.length} route{group.length !== 1 ? "s" : ""})
                </span>
                {group.length > 1 && (
                  <span className="text-[10px] text-muted-foreground/60">
                    · weighted load balance
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {group.map((route) => (
                  <RouteCard
                    key={route.id}
                    route={route}
                    onToggle={(enabled) => toggleMut.mutate({ routeId: route.id, isEnabled: enabled })}
                    onDelete={() => {
                      if (confirm(`Delete route "${route.name}"?`)) {
                        deleteMut.mutate(route.id);
                      }
                    }}
                    onResetCircuit={() => resetCircuitMut.mutate(route.id)}
                    isExpanded={expandedRoutes.has(route.id)}
                    onToggleExpand={() => toggleExpand(route.id)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
