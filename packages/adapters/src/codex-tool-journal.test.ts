import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexToolJournal } from "./codex-tool-journal.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const tool: ConnectorTool = { name: "shell", description: "test", inputSchema: { type: "object" } };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-journal-"));
  directories.push(root);
  const request = {
    runId: "run",
    tools: [tool],
    executeTool: vi.fn(async () => ({ stdout: "one append", stderr: "", code: 0 })),
    reconcileTool: vi.fn(async () => ({ status: "unknown" as const })),
  } as unknown as AgentRunRequest;
  const signal = new AbortController().signal;
  const journal = () => new CodexToolJournal(root, request, signal);
  await journal().initialize();
  const recordFile = async () => {
    const dir = join(root, (await readdir(root))[0]!);
    return join(
      dir,
      (await readdir(dir)).find((path) => path.endsWith(".json") && path !== "manifest.json")!,
    );
  };
  return { root, request, journal, recordFile };
}

describe("durable Codex operation admission", () => {
  it("returns a committed result without executing the same operation again", async () => {
    const f = await fixture();
    await f.journal().execute(tool, { command: "append" }, "operation");
    await expect(f.journal().execute(tool, { command: "append" }, "operation")).resolves.toEqual({
      stdout: "one append",
      stderr: "",
      code: 0,
    });
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
    await expect(f.journal().execute(tool, { command: "different" }, "operation")).rejects.toThrow(
      "identity changed",
    );
  });

  it("never retries an operation whose response was lost", async () => {
    const f = await fixture();
    f.request.executeTool = vi.fn(async () => {
      throw new Error("transport closed after append");
    });
    await expect(f.journal().execute(tool, {}, "operation")).rejects.toThrow("needs review");
    await expect(f.journal().execute(tool, {}, "operation")).rejects.toThrow("needs review");
    await expect(f.journal().reconcile([tool])).rejects.toThrow("needs review");
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
  });

  it("reconciles a lost reply from a read-only execution receipt", async () => {
    const f = await fixture();
    f.request.executeTool = vi.fn(async () => {
      throw new Error("lost reply");
    });
    await expect(f.journal().execute(tool, {}, "operation")).rejects.toThrow();
    f.request.reconcileTool = vi.fn(async () => ({
      status: "completed" as const,
      result: { stdout: "already appended", stderr: "", code: 0 },
    }));
    const records = await f.journal().reconcile([tool]);
    expect(records[0]?.status).toBe("completed");
    expect(records[0]?.result).toEqual({ stdout: "already appended", stderr: "", code: 0 });
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
    await f.journal().reconcile([tool]);
    expect(f.request.reconcileTool).toHaveBeenCalledTimes(1);
  });

  it("does not turn a pending execution into permission to dispatch", async () => {
    const f = await fixture();
    f.request.executeTool = vi.fn(async () => {
      throw new Error("lost reply");
    });
    await expect(f.journal().execute(tool, {}, "operation")).rejects.toThrow();
    f.request.reconcileTool = vi
      .fn()
      .mockResolvedValueOnce({ status: "pending" })
      .mockResolvedValue({ status: "completed", result: 1 });
    await f.journal().reconcile([tool]);
    expect(f.request.reconcileTool).toHaveBeenCalledTimes(2);
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
  });

  it("dispatches a prepared but never admitted operation once", async () => {
    const f = await fixture();
    await f.journal().execute(tool, {}, "operation");
    const path = await f.recordFile();
    const record = JSON.parse(await readFile(path, "utf8"));
    record.status = "prepared";
    delete record.result;
    await writeFile(path, JSON.stringify(record));
    vi.mocked(f.request.executeTool!).mockClear();
    await f.journal().reconcile([tool]);
    await f.journal().reconcile([tool]);
    expect(f.request.executeTool).toHaveBeenCalledTimes(1);
  });

  it("rejects altered ownership or arguments instead of trusting a receipt", async () => {
    const f = await fixture();
    await f.journal().execute(tool, {}, "operation");
    const path = await f.recordFile();
    const record = JSON.parse(await readFile(path, "utf8"));
    record.args = { command: "different" };
    await writeFile(path, JSON.stringify(record));
    await expect(f.journal().reconcile([tool])).rejects.toThrow("Invalid");
  });

  it("refuses recovery when the tool grant has been removed", async () => {
    const f = await fixture();
    f.request.executeTool = vi.fn(async () => {
      throw new Error("lost reply");
    });
    await expect(f.journal().execute(tool, {}, "operation")).rejects.toThrow();
    await expect(f.journal().reconcile([])).rejects.toThrow("needs review");
    expect(f.request.reconcileTool).not.toHaveBeenCalled();
  });
});
