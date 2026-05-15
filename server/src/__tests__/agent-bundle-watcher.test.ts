/**
 * Unit tests for the agent-bundle-watcher service (NOR-4837 Part 2).
 *
 * Filesystem and chokidar are stubbed via injectable test seams so these
 * tests stay deterministic and fast. The watcher contract is:
 *
 *   - file change → debounce (500ms) → call persistBundleRevision
 *   - if persist returned `changed: true` → emit bundle_invalidated event
 *     scoped to the agent
 *   - subscribers only receive events for the agent they subscribed to
 *   - close() tears down listeners + watchers + pending timers
 */
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLE_WATCH_DEBOUNCE_MS,
  createAgentBundleWatcher,
} from "../services/agent-bundle-watcher.js";

type FakeWatcher = EventEmitter & {
  close: () => Promise<void>;
};

function makeFakeWatcher(): FakeWatcher {
  const emitter = new EventEmitter() as FakeWatcher;
  emitter.close = vi.fn(async () => undefined);
  return emitter;
}

function makeWatcherDeps(
  persistResult: {
    bundleRevisionId: string;
    bundleAssembledAt: Date;
    changed: boolean;
    assembled: unknown;
  } | null,
) {
  const fake = makeFakeWatcher();
  return {
    fake,
    deps: {
      // Always pretend the rootPath exists so the test stays under the watch
      // path (we never actually touch the filesystem).
      existsSync: () => true,
      watcherFactory: () => fake as unknown as ReturnType<typeof makeFakeWatcher>,
      persistBundleRevision: vi.fn(async () => persistResult),
    },
  };
}

describe("agent-bundle-watcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("emits bundle_invalidated after debounce when revision changes", async () => {
    const { fake, deps } = makeWatcherDeps({
      bundleRevisionId: "sha256-abc",
      bundleAssembledAt: new Date(),
      changed: true,
      assembled: null,
    });
    const watcher = createAgentBundleWatcher({} as never, deps);
    const events: Array<{ agentId: string; bundleRevisionId: string; ts: string }> = [];
    watcher.subscribe("agent-1", (evt) => events.push(evt));
    watcher.watchAgent("agent-1", "/fake/root");

    fake.emit("all");
    await vi.advanceTimersByTimeAsync(BUNDLE_WATCH_DEBOUNCE_MS - 1);
    expect(deps.persistBundleRevision).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    // Flush microtasks that the promise resolution queues.
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.persistBundleRevision).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentId: "agent-1",
      bundleRevisionId: "sha256-abc",
    });
    expect(typeof events[0].ts).toBe("string");
    await watcher.close();
  });

  it("batches rapid changes into a single debounced flush (AC9)", async () => {
    const { fake, deps } = makeWatcherDeps({
      bundleRevisionId: "sha256-abc",
      bundleAssembledAt: new Date(),
      changed: true,
      assembled: null,
    });
    const watcher = createAgentBundleWatcher({} as never, deps);
    const events: Array<unknown> = [];
    watcher.subscribe("agent-1", (evt) => events.push(evt));
    watcher.watchAgent("agent-1", "/fake/root");

    fake.emit("all");
    await vi.advanceTimersByTimeAsync(100);
    fake.emit("all");
    await vi.advanceTimersByTimeAsync(100);
    fake.emit("all");
    await vi.advanceTimersByTimeAsync(BUNDLE_WATCH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.persistBundleRevision).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    await watcher.close();
  });

  it("does NOT emit when persistBundleRevision reports no change", async () => {
    const { fake, deps } = makeWatcherDeps({
      bundleRevisionId: "sha256-existing",
      bundleAssembledAt: new Date(),
      changed: false,
      assembled: null,
    });
    const watcher = createAgentBundleWatcher({} as never, deps);
    const events: Array<unknown> = [];
    watcher.subscribe("agent-1", (evt) => events.push(evt));
    watcher.watchAgent("agent-1", "/fake/root");

    fake.emit("all");
    await vi.advanceTimersByTimeAsync(BUNDLE_WATCH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.persistBundleRevision).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    await watcher.close();
  });

  it("does NOT cross-fire events to subscribers of other agents", async () => {
    const { fake: fake1, deps: deps1 } = makeWatcherDeps({
      bundleRevisionId: "sha256-agent1",
      bundleAssembledAt: new Date(),
      changed: true,
      assembled: null,
    });
    // We need two independent fake watchers; createAgentBundleWatcher's
    // factory is called once per watchAgent. Inject a factory that returns
    // them in order.
    const fake2 = makeFakeWatcher();
    const persist = vi.fn(async (_db: never, agentId: string) => {
      if (agentId === "agent-1") {
        return {
          bundleRevisionId: "sha256-agent1",
          bundleAssembledAt: new Date(),
          changed: true,
          assembled: null as never,
        };
      }
      return {
        bundleRevisionId: "sha256-agent2",
        bundleAssembledAt: new Date(),
        changed: true,
        assembled: null as never,
      };
    });
    const factories: ReturnType<typeof makeFakeWatcher>[] = [fake1, fake2];
    const watcher = createAgentBundleWatcher({} as never, {
      ...deps1,
      persistBundleRevision: persist,
      watcherFactory: () => factories.shift() ?? makeFakeWatcher(),
    });
    const events1: Array<{ agentId: string }> = [];
    const events2: Array<{ agentId: string }> = [];
    watcher.subscribe("agent-1", (evt) => events1.push(evt));
    watcher.subscribe("agent-2", (evt) => events2.push(evt));
    watcher.watchAgent("agent-1", "/fake/root/1");
    watcher.watchAgent("agent-2", "/fake/root/2");

    fake1.emit("all");
    await vi.advanceTimersByTimeAsync(BUNDLE_WATCH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(events1).toHaveLength(1);
    expect(events1[0]?.agentId).toBe("agent-1");
    expect(events2).toHaveLength(0);
    await watcher.close();
  });

  it("unsubscribe stops delivering events to the listener", async () => {
    const { fake, deps } = makeWatcherDeps({
      bundleRevisionId: "sha256-abc",
      bundleAssembledAt: new Date(),
      changed: true,
      assembled: null,
    });
    const watcher = createAgentBundleWatcher({} as never, deps);
    const events: Array<unknown> = [];
    const unsubscribe = watcher.subscribe("agent-1", (evt) => events.push(evt));
    watcher.watchAgent("agent-1", "/fake/root");

    unsubscribe();
    fake.emit("all");
    await vi.advanceTimersByTimeAsync(BUNDLE_WATCH_DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.persistBundleRevision).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    await watcher.close();
  });
});
