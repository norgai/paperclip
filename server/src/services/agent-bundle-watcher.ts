/**
 * AgentBundleWatcher — watches managed-bundle root directories on disk and
 * fires bundle_invalidated events whenever the persisted bundle revision
 * changes (NOR-4837 Part 2, AC5–9).
 *
 * Each agent with a managed instructions bundle gets its own debounced
 * chokidar watcher rooted at the bundle directory. On a debounced change
 * (500ms per AC9), the watcher re-runs `persistBundleRevision()` and, if the
 * stored revisionId changed, emits a `bundle_invalidated` event for that
 * agent.
 *
 * Subscribers (e.g. an active openclaw-gateway WebSocket session in
 * `packages/adapters/openclaw-gateway`) receive only events for their own
 * agentId. The watcher therefore acts as a per-agent fan-out bus: AC7
 * ("only push if agent has an active gateway WebSocket connection") is
 * satisfied implicitly by the subscription lifetime, not by the watcher
 * tracking sessions itself.
 */
import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { persistBundleRevision as defaultPersistBundleRevision } from "./agent-bundle.js";

const log = logger.child({ service: "agent-bundle-watcher" });

/** Debounce window for rapid bundle-file changes (AC9). */
export const BUNDLE_WATCH_DEBOUNCE_MS = 500;

export interface BundleInvalidatedEvent {
  agentId: string;
  bundleRevisionId: string;
  ts: string;
}

export interface AgentBundleWatcher {
  /** Begin watching a managed bundle root for an agent. Idempotent. */
  watchAgent(agentId: string, rootPath: string): void;
  /** Stop watching a specific agent. Idempotent. */
  unwatchAgent(agentId: string): void;
  /**
   * Subscribe to bundle_invalidated events for a specific agent. Returns an
   * unsubscribe function. Subscribers run on the EventEmitter's `emit` tick.
   */
  subscribe(
    agentId: string,
    handler: (evt: BundleInvalidatedEvent) => void,
  ): () => void;
  /** Close all watchers and remove all subscribers. */
  close(): Promise<void>;
}

export interface AgentBundleWatcherDeps {
  /** Test seam: replace the persister so unit tests can stub revision changes. */
  persistBundleRevision?: typeof defaultPersistBundleRevision;
  /** Test seam: replace the chokidar factory so unit tests can drive a mock. */
  watcherFactory?: (paths: string) => FSWatcher;
  /** Test seam: replace existsSync (used for filesystem checks). */
  existsSync?: typeof existsSync;
}

function bundleEventName(agentId: string): string {
  return `bundle_invalidated:${agentId}`;
}

export function createAgentBundleWatcher(
  db: Db,
  deps: AgentBundleWatcherDeps = {},
): AgentBundleWatcher {
  const persist = deps.persistBundleRevision ?? defaultPersistBundleRevision;
  const fileExists = deps.existsSync ?? existsSync;
  const factory =
    deps.watcherFactory ??
    ((p) =>
      chokidar.watch(p, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      }));

  const emitter = new EventEmitter();
  // Unbounded — one listener per active gateway session per agent.
  emitter.setMaxListeners(0);

  const watchers = new Map<string, FSWatcher>();
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function scheduleFlush(agentId: string): void {
    const existing = debounceTimers.get(agentId);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      agentId,
      setTimeout(() => {
        debounceTimers.delete(agentId);
        void flushAgent(agentId);
      }, BUNDLE_WATCH_DEBOUNCE_MS),
    );
  }

  async function flushAgent(agentId: string): Promise<void> {
    try {
      const result = await persist(db, agentId);
      if (!result) return;
      if (!result.changed) return;
      const evt: BundleInvalidatedEvent = {
        agentId,
        bundleRevisionId: result.bundleRevisionId,
        ts: new Date().toISOString(),
      };
      emitter.emit(bundleEventName(agentId), evt);
    } catch (err) {
      log.warn(
        {
          agentId,
          err: err instanceof Error ? err.message : String(err),
        },
        "agent-bundle-watcher: persistBundleRevision failed",
      );
    }
  }

  function watchAgent(agentId: string, rootPath: string): void {
    if (watchers.has(agentId)) return;
    const abs = path.resolve(rootPath);
    if (!fileExists(abs)) {
      log.warn(
        { agentId, rootPath: abs },
        "agent-bundle-watcher: root path does not exist, skipping",
      );
      return;
    }
    try {
      const watcher = factory(abs);
      watcher.on("all", () => scheduleFlush(agentId));
      watcher.on("error", (err) => {
        log.warn(
          {
            agentId,
            err: err instanceof Error ? err.message : String(err),
          },
          "agent-bundle-watcher: watcher error, stopping watch for this agent",
        );
        unwatchAgent(agentId);
      });
      watchers.set(agentId, watcher);
    } catch (err) {
      log.warn(
        {
          agentId,
          rootPath: abs,
          err: err instanceof Error ? err.message : String(err),
        },
        "agent-bundle-watcher: failed to start watcher",
      );
    }
  }

  function unwatchAgent(agentId: string): void {
    const w = watchers.get(agentId);
    if (w) {
      void w.close();
      watchers.delete(agentId);
    }
    const timer = debounceTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(agentId);
    }
  }

  function subscribe(
    agentId: string,
    handler: (evt: BundleInvalidatedEvent) => void,
  ): () => void {
    const eventName = bundleEventName(agentId);
    emitter.on(eventName, handler);
    return () => {
      emitter.off(eventName, handler);
    };
  }

  async function close(): Promise<void> {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    const closing = [...watchers.values()].map((w) => w.close().catch(() => undefined));
    watchers.clear();
    emitter.removeAllListeners();
    await Promise.all(closing);
  }

  return { watchAgent, unwatchAgent, subscribe, close };
}

// ---------------------------------------------------------------------------
// Module-scoped singleton accessors
// ---------------------------------------------------------------------------

// The watcher is created once at server boot (see `app.ts`) and consumed by
// `heartbeat.ts` when threading `subscribeBundleInvalidated` into adapter
// execution contexts. A singleton accessor avoids ripple-editing the ~15
// callers of `heartbeatService(db)` to add a new required argument.

let currentWatcher: AgentBundleWatcher | null = null;

export function setAgentBundleWatcher(watcher: AgentBundleWatcher | null): void {
  currentWatcher = watcher;
}

export function getAgentBundleWatcher(): AgentBundleWatcher | null {
  return currentWatcher;
}
