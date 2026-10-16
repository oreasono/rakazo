import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexConnectionOptions, CodexObject } from "./codex-app-server.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const bridges = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock("./codex-tool-bridge.js", () => ({
  createCodexToolBridge: vi.fn(async () => ({ socket: "/fake/tools.sock", close: bridges.close })),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  bridges.close.mockReset().mockResolvedValue(undefined);
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const request = (): AgentRunRequest => ({
  runId: "run-one",
  threadId: "product-thread",
  botId: "bot-one",
  prompt: "Use the assigned computer",
  instructions: "Use Rakazo tools",
  history: [],
  tools: [],
  model: {
    provider: "custom",
    id: "fake",
    apiKey: "fake-key",
    baseUrl: "https://model.invalid/v1",
  },
});

const approval = (patch: CodexObject = {}): CodexObject => ({
  serverName: "rakazo",
  threadId: "root",
  turnId: null, // The official schema permits missing turn correlation.
  mode: "form",
  message: "Allow tool?",
  requestedSchema: { type: "object", properties: {} },
  _meta: { codex_approval_kind: "mcp_tool_call" },
  ...patch,
});
const accepted = { action: "accept", content: {} };
const declined = { action: "decline", content: null };
const elicitation = (options: CodexConnectionOptions, patch: CodexObject = {}) =>
  options.onRequest("mcpServer/elicitation/request", approval(patch));

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const output: AgentRuntimeEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

async function fixture(
  options: {
    onTurn?: (connection: CodexConnectionOptions) => Promise<void>;
    complete?: boolean;
    status?: string;
    timeoutMs?: number;
    close?: () => Promise<void>;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "codex-lifecycle-"));
  directories.push(root);
  const calls: string[] = [];
  const connections: CodexConnectionOptions[] = [];
  const close = vi.fn(options.close ?? (async () => {}));
  const runtime = new CodexAgentRuntime({
    sessionRoot: root,
    runTimeoutMs: options.timeoutMs,
    connectionFactory: (connection) => {
      connections.push(connection);
      return {
        notify() {},
        close,
        async request(method: string) {
          calls.push(method);
          if (method === "thread/start" || method === "thread/resume")
            return { thread: { id: "root", turns: [] } };
          if (method === "turn/start") {
            await options.onTurn?.(connection);
            if (options.complete !== false) {
              connection.onNotification({
                method: "item/completed",
                params: { threadId: "root", item: { type: "agentMessage", text: "Done" } },
              });
              connection.onNotification({
                method: "turn/completed",
                params: {
                  threadId: "root",
                  turn: { id: "turn", status: options.status ?? "completed" },
                },
              });
            }
            return { turn: { id: "turn" } };
          }
          return {};
        },
      };
    },
  });
  const home = async () => {
    const name = (await readdir(root))[0];
    if (!name) throw new Error("Missing session directory");
    return join(root, name);
  };
  return {
    runtime,
    root,
    calls,
    connections,
    close,
    home,
    state: async () => JSON.parse(await readFile(join(await home(), "session.json"), "utf8")),
  };
}

describe("Codex controller tools and progress", () => {
  it("disables both native shell implementations while retaining native agents and scoped MCP on start and resume", async () => {
    const f = await fixture();
    await collect(f.runtime.run(request()));
    await collect(f.runtime.run({ ...request(), runId: "run-two" }));
    expect(f.calls).toContain("thread/start");
    expect(f.calls).toContain("thread/resume");
    expect(f.connections).toHaveLength(2);
    for (const connection of f.connections) {
      const config: Record<string, unknown> = {};
      for (let i = 0; i < connection.args.length; i++) {
        if (connection.args[i] !== "-c") continue;
        const value = connection.args[i + 1];
        if (!value) throw new Error("Missing configuration override");
        const separator = value.indexOf("=");
        config[value.slice(0, separator)] = JSON.parse(value.slice(separator + 1));
      }
      expect(config).toMatchObject({
        "features.shell_tool": false,
        "features.unified_exec": false,
        "features.multi_agent": true,
        "mcp_servers.rakazo.command": process.execPath,
        "mcp_servers.rakazo.required": true,
        "mcp_servers.rakazo.env.RAKAZO_CODEX_TOOL_SOCKET": "/fake/tools.sock",
      });
      expect(config["mcp_servers.rakazo.args"]).toEqual([
        expect.stringMatching(/codex-mcp-stdio\.mjs$/),
      ]);
    }
  });

  it("emits cumulative root progress per item without mixing child or unrelated deltas", async () => {
    const f = await fixture({
      onTurn: async (connection) => {
        connection.onNotification({
          method: "thread/started",
          params: { thread: { id: "child", parentThreadId: "root" } },
        });
        for (const [threadId, itemId, delta] of [
          ["root", "item-one", "正在"],
          ["child", "child-item", "Child progress"],
          ["root", "item-one", "检查"],
          ["unrelated", "foreign-item", "Not our progress"],
          ["root", "item-two", "开始"],
          ["root", "item-two", "验证"],
        ]) {
          connection.onNotification({
            method: "item/agentMessage/delta",
            params: { threadId, itemId, delta },
          });
        }
      },
    });
    const events = await collect(f.runtime.run(request()));
    expect(events.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", text: "正在" },
      { type: "progress", text: "正在检查" },
      { type: "progress", text: "开始" },
      { type: "progress", text: "开始验证" },
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        threadId: "child",
        progress: "Child progress",
      }),
    );
  });

  it("starts progress fresh on a resumed run even if the server reuses an item ID", async () => {
    let invocation = 0;
    const f = await fixture({
      onTurn: async (connection) => {
        invocation++;
        connection.onNotification({
          method: "item/agentMessage/delta",
          params: { threadId: "root", itemId: "same-item", delta: `Run ${invocation}` },
        });
      },
    });
    await collect(f.runtime.run(request()));
    const resumed = await collect(f.runtime.run({ ...request(), runId: "run-two" }));
    expect(resumed.filter((event) => event.type === "progress")).toEqual([
      { type: "progress", text: "Run 2" },
    ]);
  });
});

describe("scoped Codex MCP approvals", () => {
  it("accepts only root and verified native descendants even before queued projections drain", async () => {
    const replies: unknown[] = [];
    const f = await fixture({
      onTurn: async (connection) => {
        replies.push(await elicitation(connection));
        connection.onNotification({
          method: "thread/started",
          params: {
            thread: {
              id: "child",
              source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } },
            },
          },
        });
        replies.push(await elicitation(connection, { threadId: "child", turnId: "child-turn" }));
        connection.onNotification({
          method: "item/completed",
          params: {
            threadId: "child",
            item: {
              type: "collabAgentToolCall",
              tool: "spawnAgent",
              senderThreadId: "child",
              receiverThreadIds: ["grandchild"],
            },
          },
        });
        replies.push(await elicitation(connection, { threadId: "grandchild" }));
      },
    });
    const executeTool = vi.fn();
    await collect(f.runtime.run({ ...request(), executeTool }));
    expect(replies).toEqual([accepted, accepted, accepted]);
    // Accepting the MCP prompt never executes or bypasses the product tool gate.
    expect(executeTool).not.toHaveBeenCalled();
    const connection = f.connections[0];
    if (!connection) throw new Error("Missing connection");
    expect(await elicitation(connection)).toEqual(declined);
  });

  it.each([
    ["other server", { serverName: "other" }],
    ["URL auth", { mode: "url", url: "https://auth.invalid/", elicitationId: "auth" }],
    ["extended form", { mode: "openai/form" }],
    ["unmarked form", { _meta: undefined }],
    ["null metadata", { _meta: null }],
    ["auth form", { _meta: { codex_approval_kind: "authentication" } }],
    ["missing thread", { threadId: undefined }],
    ["unrelated root", { threadId: "foreign-root" }],
    ["unknown child", { threadId: "foreign-child" }],
    ["unknown collab receiver", { threadId: "foreign-receiver" }],
  ])("declines %s", async (_name, patch) => {
    const f = await fixture({
      onTurn: async (connection) => {
        connection.onNotification({
          method: "thread/started",
          params: { thread: { id: "foreign-child", parentThreadId: "foreign-root" } },
        });
        connection.onNotification({
          method: "item/completed",
          params: {
            threadId: "root",
            item: {
              type: "collabAgentToolCall",
              tool: "sendInput",
              receiverThreadIds: ["foreign-receiver"],
            },
          },
        });
        expect(await elicitation(connection, patch)).toEqual(declined);
        expect(await connection.onRequest("item/commandExecution/requestApproval", {})).toEqual({
          decision: "decline",
        });
      },
    });
    await collect(f.runtime.run(request()));
  });

  it("declines before admission and immediately on cancellation", async () => {
    const controller = new AbortController();
    const f = await fixture({
      onTurn: async (connection) => {
        controller.abort();
        expect(await elicitation(connection)).toEqual(declined);
      },
    });
    const iterator = f.runtime
      .run(request(), { signal: controller.signal })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("checkpoint");
    const connection = f.connections[0];
    if (!connection) throw new Error("Missing connection");
    expect(await elicitation(connection)).toEqual(declined);
    await expect(iterator.next()).rejects.toThrow("interrupted");
    expect(f.calls.filter((method) => method === "turn/interrupt")).toHaveLength(1);
  });

  it("does not share scope across bot connections", async () => {
    const f = await fixture({
      onTurn: async (connection) => {
        if (f.connections.length === 1) {
          connection.onNotification({
            method: "thread/started",
            params: { thread: { id: "private-child", parentThreadId: "root" } },
          });
          expect(await elicitation(connection, { threadId: "private-child" })).toEqual(accepted);
        } else
          expect(await elicitation(connection, { threadId: "private-child" })).toEqual(declined);
      },
    });
    await collect(f.runtime.run(request()));
    await collect(f.runtime.run({ ...request(), botId: "bot-two" }));
    expect(new Set(f.connections.map((connection) => connection.env.CODEX_HOME)).size).toBe(2);
  });
});

describe("Codex terminal state and cleanup", () => {
  it("keeps durable completion when the consumer stops at final text", async () => {
    const f = await fixture();
    for await (const event of f.runtime.run(request())) if (event.type === "text") break;
    expect((await f.state()).runs["run-one"].status).toBe("completed");
    await collect(f.runtime.run(request()));
    expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(f.calls).not.toContain("turn/interrupt");
  });

  it("does not start a turn cancelled while publishing the checkpoint", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const context: Partial<AdapterContext> = { signal: controller.signal };
    const iterator = f.runtime.run(request(), context)[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("checkpoint");
    controller.abort();
    await expect(iterator.next()).rejects.toThrow();
    expect(f.calls).not.toContain("turn/start");
    expect(await readdir(await f.home())).not.toContain("active.lock");
  });

  it("fails an interrupted native turn instead of reporting done", async () => {
    const f = await fixture({ status: "interrupted" });
    await expect(collect(f.runtime.run(request()))).rejects.toThrow("interrupted");
    await expect(collect(f.runtime.run(request()))).rejects.toThrow("worker restart");
    expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(1);
  });

  it("preserves unexpected-exit errors and does not repeat an admitted prompt", async () => {
    const f = await fixture({
      onTurn: async (connection) => {
        connection.onExit(new Error("transport lost"));
      },
    });
    await expect(collect(f.runtime.run(request()))).rejects.toThrow("transport lost");
    await expect(collect(f.runtime.run(request()))).rejects.toThrow("worker restart");
    expect(f.calls.filter((method) => method === "turn/start")).toHaveLength(1);
    expect(bridges.close).toHaveBeenCalled();
    expect(await readdir(await f.home())).not.toContain("active.lock");
  });

  it("preserves timeout errors through cancellation and unlocks the conversation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = await fixture({ complete: false, timeoutMs: 100 });
    const iterator = f.runtime.run(request())[Symbol.asyncIterator]();
    await iterator.next();
    const pending = collect({ [Symbol.asyncIterator]: () => iterator });
    const assertion = expect(pending).rejects.toThrow("Codex turn timed out");
    await vi.advanceTimersByTimeAsync(101);
    await assertion;
    expect(await readdir(await f.home())).not.toContain("active.lock");
  });

  it("continues bridge cleanup and unlock after a connection close failure", async () => {
    const f = await fixture({
      close: async () => {
        throw new Error("close failed");
      },
    });
    await expect(collect(f.runtime.run(request()))).rejects.toThrow("close failed");
    expect(bridges.close).toHaveBeenCalledOnce();
    expect(await readdir(await f.home())).not.toContain("active.lock");
    expect((await f.state()).runs["run-one"].status).toBe("completed");
  });

  it("does not reparent the root when a child sends it a message", async () => {
    const f = await fixture({
      onTurn: async (connection) => {
        connection.onNotification({
          method: "thread/started",
          params: { thread: { id: "child", parentThreadId: "root" } },
        });
        connection.onNotification({
          method: "item/completed",
          params: {
            threadId: "child",
            item: {
              type: "collabAgentToolCall",
              tool: "sendInput",
              senderThreadId: "child",
              receiverThreadIds: ["root"],
            },
          },
        });
      },
    });
    const events = await collect(f.runtime.run(request()));
    expect(
      events
        .filter((event) => event.type === "subagent" && event.threadId === "root")
        .every((event) => event.type === "subagent" && event.parentThreadId === null),
    ).toBe(true);
  });
});
