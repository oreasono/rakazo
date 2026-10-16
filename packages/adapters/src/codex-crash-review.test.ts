import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexConnectionOptions, CodexObject } from "./codex-app-server.js";
import { CodexAgentRuntime } from "./codex-runtime.js";
import { createCodexToolBridge } from "./codex-tool-bridge.js";
import { CodexRecoveryRequired, CodexToolJournal } from "./codex-tool-journal.js";

// These regressions use disk receipts, but never start a bridge, app-server, or model.
vi.mock("./codex-tool-bridge.js", () => ({
  createCodexToolBridge: vi.fn(async () => ({
    socket: "unused-test-socket",
    sealAdmission: () => true,
    close: async () => {},
  })),
}));

const directories: string[] = [];
const tool: ConnectorTool = {
  name: "shell",
  description: "Fake effect",
  inputSchema: { type: "object" },
};
const args = { command: "append-once" };
type NativeNode = Extract<AgentRuntimeEvent, { type: "subagent" }>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("RAKAZO_CODEX_CRASH_GATE", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "codex-crash-review-"));
  directories.push(path);
  return path;
}

function input(): AgentRunRequest {
  return {
    botId: "bot-one",
    threadId: "product-thread",
    runId: "run-one",
    prompt: "Current task",
    instructions: "Use the assigned computer",
    history: [],
    tools: [tool],
    model: {
      provider: "custom",
      id: "test-model",
      apiKey: "test-only-key",
      baseUrl: "https://model.invalid/v1",
    },
  };
}

async function collect(stream: AsyncIterable<AgentRuntimeEvent>, events: AgentRuntimeEvent[] = []) {
  for await (const event of stream) events.push(event);
  return events;
}

function nativeNode(id: string, revision: number): NativeNode {
  return {
    type: "subagent",
    runtime: "codex",
    agentId: id,
    name: id === "native-root" ? "Root" : "Helper",
    threadId: id,
    rootThreadId: "native-root",
    ...(id === "native-root" ? {} : { parentThreadId: "native-root" }),
    task: "Current task",
    status: "running",
    nativeStatus: "running",
    nativeRevision: revision,
    progress: "Progress before crash",
  };
}

async function sessionFixture(options: { child?: boolean; legacy?: boolean } = {}) {
  const root = await directory();
  const executeTool = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>();
  const reconcileTool = vi.fn<NonNullable<AgentRunRequest["reconcileTool"]>>();
  const request = { ...input(), executeTool, reconcileTool };
  const owner = JSON.stringify(["", "", request.threadId, request.botId]);
  const home = join(root, digest(owner));
  await mkdir(home, { recursive: true });
  const stateFile = join(home, "session.json");
  const state = {
    version: 1,
    owner,
    rootThreadId: "native-root",
    revision: 40,
    nodes: {
      "native-root": nativeNode("native-root", 39),
      ...(options.child === false ? {} : { "native-child": nativeNode("native-child", 40) }),
    } as Record<string, NativeNode>,
    runs: {
      [request.runId]: {
        status: options.legacy ? "interrupted" : "running",
        turnId: "old-turn",
        ...(options.legacy ? {} : { journalVersion: 1 }),
      },
    },
  };
  await writeFile(stateFile, JSON.stringify(state));
  const journalRoot = join(home, "operations");
  const journal = () => new CodexToolJournal(journalRoot, request, new AbortController().signal);
  const readState = async () => JSON.parse(await readFile(stateFile, "utf8")) as typeof state;
  return { root, request, journal, journalRoot, executeTool, reconcileTool, readState };
}

function fakeServer(
  options: {
    historyStatus?: string;
    onResume?: (connection: CodexConnectionOptions) => Promise<void>;
  } = {},
) {
  const calls: Array<{ method: string; params: CodexObject }> = [];
  const factory = vi.fn((connection: CodexConnectionOptions) => ({
    notify() {},
    async close() {},
    async request(method: string, params: CodexObject): Promise<CodexObject> {
      calls.push({ method, params });
      if (method === "thread/resume") {
        await options.onResume?.(connection);
        return {
          thread: {
            id: "native-root",
            turns: options.historyStatus
              ? [
                  {
                    id: "old-turn",
                    status: "completed",
                    items: [
                      {
                        type: "collabAgentToolCall",
                        tool: "spawnAgent",
                        senderThreadId: "native-root",
                        receiverThreadIds: ["native-child"],
                        prompt: "Obsolete task from history",
                        agentsStates: {
                          "native-child": {
                            status: options.historyStatus,
                            message: "Obsolete successful result",
                          },
                        },
                      },
                    ],
                  },
                ]
              : [],
          },
        };
      }
      if (method === "turn/start") {
        queueMicrotask(() => {
          connection.onNotification({
            method: "item/completed",
            params: {
              threadId: "native-root",
              item: { type: "agentMessage", text: "Recovery summary", phase: "final" },
            },
          });
          connection.onNotification({
            method: "turn/completed",
            params: { threadId: "native-root", turn: { id: "summary-turn", status: "completed" } },
          });
        });
        return { turn: { id: "summary-turn" } };
      }
      return {};
    },
  }));
  return { calls, factory };
}

describe("crash review regressions", () => {
  it.each([
    { uncertain: true },
    { running: true, code: null },
    { kind: "agent_tool_result", details: { uncertain: true } },
  ])("keeps unconfirmed result %j dispatched and blocks a second execution ID", async (result) => {
    const f = await sessionFixture();
    await f.journal().initialize();
    f.executeTool.mockResolvedValue(result);
    f.reconcileTool.mockResolvedValue({ status: "unknown" });

    await expect(f.journal().execute(tool, args, "first-id")).rejects.toBeInstanceOf(
      CodexRecoveryRequired,
    );
    // Reconstruct the journal to exercise the persisted barrier, not an in-memory latch.
    await expect(f.journal().execute(tool, args, "second-id")).rejects.toBeInstanceOf(
      CodexRecoveryRequired,
    );
    await expect(f.journal().reconcile([tool])).rejects.toThrow("needs review");
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.reconcileTool).toHaveBeenCalledExactlyOnceWith(tool.name, args, "first-id");
    expect(await f.journal().records()).toEqual([
      expect.objectContaining({ executionId: "first-id", status: "dispatched" }),
    ]);
  });

  it("queries a running receipt until confirmed and never dispatches it again", async () => {
    const f = await sessionFixture();
    await f.journal().initialize();
    f.executeTool.mockResolvedValue({ running: true, code: null });
    f.reconcileTool.mockResolvedValueOnce({ status: "pending" }).mockResolvedValue({
      status: "completed",
      result: { code: 0, stdout: "Confirmed append" },
    });
    await expect(f.journal().execute(tool, args, "first-id")).rejects.toThrow("needs review");
    const records = await f.journal().reconcile([tool]);
    expect(records[0]).toMatchObject({
      status: "completed",
      result: { code: 0, stdout: "Confirmed append" },
    });
    await f.journal().reconcile([tool]);
    expect(f.executeTool).toHaveBeenCalledTimes(1);
    expect(f.reconcileTool).toHaveBeenCalledTimes(2);
  });

  it("rejects a completed receipt whose result is still uncertain", async () => {
    const f = await sessionFixture();
    await f.journal().initialize();
    f.executeTool.mockRejectedValue(new Error("Lost reply after dispatch"));
    f.reconcileTool.mockResolvedValue({ status: "completed", result: { uncertain: true } });
    await expect(f.journal().execute(tool, args, "first-id")).rejects.toThrow("needs review");
    await expect(f.journal().reconcile([tool])).rejects.toThrow("needs review");
    expect((await f.journal().records())[0]?.status).toBe("dispatched");
    expect(f.executeTool).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "blocks a new run after legacy interruption (manifest exists: %s)",
    async (manifestExists) => {
      const f = await sessionFixture({ legacy: true });
      if (manifestExists) await f.journal().initialize();
      const fake = fakeServer();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(
          collect(
            new CodexAgentRuntime({
              sessionRoot: f.root,
              connectionFactory: fake.factory,
            }).run({ ...f.request, runId: "new-run" }),
          ),
        ).rejects.toThrow(/review/);
      }
      expect(fake.factory).not.toHaveBeenCalled();
      expect(createCodexToolBridge).not.toHaveBeenCalled();
      expect(f.executeTool).not.toHaveBeenCalled();
      expect(f.reconcileTool).not.toHaveBeenCalled();
      expect((await f.readState()).runs).not.toHaveProperty("new-run");
    },
  );

  it("fails closed when a v1 recovering run has no journal manifest", async () => {
    const f = await sessionFixture();
    const fake = fakeServer();
    const events: AgentRuntimeEvent[] = [];
    await expect(
      collect(
        new CodexAgentRuntime({
          sessionRoot: f.root,
          connectionFactory: fake.factory,
        }).run(f.request),
        events,
      ),
    ).rejects.toThrow("needs review");
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(f.reconcileTool).not.toHaveBeenCalled();
    expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(events.some((event) => event.type === "done")).toBe(false);
    const state = await f.readState();
    expect(state.runs[f.request.runId]?.status).toBe("recovery_required");
    expect(state.nodes["native-child"]).toMatchObject({
      status: "failed",
      nativeStatus: "recovery_required",
    });
    await expect(
      readFile(join(f.journalRoot, digest(f.request.runId), "manifest.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not revive an existing child from historical completed collaboration state", async () => {
    const f = await sessionFixture();
    await f.journal().initialize();
    const fake = fakeServer({ historyStatus: "completed" });
    const events = await collect(
      new CodexAgentRuntime({
        sessionRoot: f.root,
        connectionFactory: fake.factory,
      }).run(f.request),
    );
    const child = (await f.readState()).nodes["native-child"];
    expect(child).toMatchObject({
      threadId: "native-child",
      parentThreadId: "native-root",
      task: "Current task",
      status: "failed",
      nativeStatus: "interrupted",
      progress: "",
    });
    expect(child?.nativeRevision).toBeGreaterThan(40);
    expect(JSON.stringify(child)).not.toContain("Obsolete");
    const childEvents = events.filter(
      (event) => event.type === "subagent" && event.agentId === "native-child",
    );
    expect(childEvents.length).toBeGreaterThan(0);
    expect(
      childEvents.some((event) => event.type === "subagent" && event.status === "completed"),
    ).toBe(false);
    expect(f.executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it.each(["running", "completed"])(
    "repairs a missing child before an unknown receipt stops recovery (historic %s)",
    async (historyStatus) => {
      const f = await sessionFixture({ child: false });
      await f.journal().initialize();
      f.executeTool.mockRejectedValue(new Error("Lost reply after dispatch"));
      await expect(f.journal().execute(tool, args, "first-id")).rejects.toThrow("needs review");
      f.executeTool.mockClear();
      const order: string[] = [];
      f.reconcileTool.mockImplementation(async () => {
        order.push("readback");
        return { status: "unknown" };
      });
      const fake = fakeServer({
        historyStatus,
        onResume: async (connection) => {
          order.push("resume");
          expect(createCodexToolBridge).toHaveBeenCalledWith(
            expect.objectContaining({ recoveryOnly: true, tools: [] }),
          );
          expect(connection.args.join(" ")).toContain("features.multi_agent=false");
          const approval = await connection.onRequest("mcpServer/elicitation/request", {
            threadId: "native-root",
            serverName: "rakazo",
            mode: "form",
            _meta: { codex_approval_kind: "mcp_tool_call" },
          });
          expect(approval).toMatchObject({ action: "decline" });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      await expect(
        collect(
          new CodexAgentRuntime({
            sessionRoot: f.root,
            connectionFactory: fake.factory,
          }).run(f.request),
          events,
        ),
      ).rejects.toThrow("needs review");
      expect(order).toEqual(["resume", "readback"]);
      expect(f.executeTool).not.toHaveBeenCalled();
      expect(f.reconcileTool).toHaveBeenCalledExactlyOnceWith(tool.name, args, "first-id");
      expect(fake.calls.some((call) => call.method === "turn/start")).toBe(false);
      const state = await f.readState();
      const child = state.nodes["native-child"];
      expect(state.runs[f.request.runId]?.status).toBe("recovery_required");
      expect(child).toMatchObject({
        agentId: "native-child",
        threadId: "native-child",
        rootThreadId: "native-root",
        parentThreadId: "native-root",
        status: "failed",
        nativeStatus: "recovery_required",
        progress: "",
      });
      expect(child?.nativeRevision).toBeGreaterThan(40);
      expect(child?.result).not.toBe("Obsolete successful result");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "subagent",
          agentId: "native-child",
          nativeStatus: "recovery_required",
        }),
      );
      expect(events.some((event) => event.type === "done")).toBe(false);
    },
  );
});
