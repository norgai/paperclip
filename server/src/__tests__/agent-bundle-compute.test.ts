import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assembleBundle } from "../services/agent-bundle.js";

type TestAgent = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: Record<string, unknown>;
};

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function makeAgent(adapterConfig: Record<string, unknown>): TestAgent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent 1",
    adapterConfig,
  };
}

function canonicalText(files: Array<[string, string]>): string {
  return files
    .slice()
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, content]) => `<<<FILE:${name}>>>\n${content}\n`)
    .join("");
}

describe("agent bundle compute (NOR-4835)", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  it("produces a deterministic SHA-256 revisionId for a given file set", async () => {
    const root = await makeTempDir("bundle-deterministic-");
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Hello\n", "utf8");
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "TOOLS.md"), "## Tools\n", "utf8");

    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: root,
      instructionsEntryFile: "AGENTS.md",
    });

    const first = await assembleBundle(agent);
    const second = await assembleBundle(agent);

    expect(first.revisionId).toBe(second.revisionId);
    expect(first.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(first.manifest).toEqual(["AGENTS.md", "docs/TOOLS.md"]);

    const expected = createHash("sha256")
      .update(canonicalText([["AGENTS.md", "# Hello\n"], ["docs/TOOLS.md", "## Tools\n"]]), "utf8")
      .digest("hex");
    expect(first.revisionId).toBe(expected);
  });

  it("produces a different revisionId when a file's content changes", async () => {
    const root = await makeTempDir("bundle-content-change-");
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "# A\n", "utf8");
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: root,
      instructionsEntryFile: "AGENTS.md",
    });
    const before = await assembleBundle(agent);

    await fs.writeFile(path.join(root, "AGENTS.md"), "# B\n", "utf8");
    const after = await assembleBundle(agent);

    expect(after.revisionId).not.toBe(before.revisionId);
  });

  it("produces a different revisionId when a file is added", async () => {
    const root = await makeTempDir("bundle-file-added-");
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "# A\n", "utf8");
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: root,
      instructionsEntryFile: "AGENTS.md",
    });
    const before = await assembleBundle(agent);

    await fs.writeFile(path.join(root, "EXTRA.md"), "# extra\n", "utf8");
    const after = await assembleBundle(agent);

    expect(after.revisionId).not.toBe(before.revisionId);
    expect(after.manifest).toEqual(["AGENTS.md", "EXTRA.md"]);
  });

  it("manifest is sorted regardless of underlying enumeration order", async () => {
    const root = await makeTempDir("bundle-sort-");
    cleanupDirs.add(root);
    await fs.writeFile(path.join(root, "zzz.md"), "z\n", "utf8");
    await fs.writeFile(path.join(root, "aaa.md"), "a\n", "utf8");
    await fs.writeFile(path.join(root, "mmm.md"), "m\n", "utf8");
    const agent = makeAgent({
      instructionsBundleMode: "external",
      instructionsRootPath: root,
      instructionsEntryFile: "AGENTS.md",
    });

    const assembled = await assembleBundle(agent);
    expect(assembled.manifest).toEqual(["aaa.md", "mmm.md", "zzz.md"]);
    expect(assembled.text.indexOf("<<<FILE:aaa.md>>>")).toBeLessThan(assembled.text.indexOf("<<<FILE:mmm.md>>>"));
    expect(assembled.text.indexOf("<<<FILE:mmm.md>>>")).toBeLessThan(assembled.text.indexOf("<<<FILE:zzz.md>>>"));
  });
});
