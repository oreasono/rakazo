import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCodexToolBridge } from "./codex-tool-bridge.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function tool(name = "computer_observe"): ConnectorTool {
  return {
    name,
    description: "Test-only computer tool",
    inputSchema: { type: "object", properties: {} },
    route: {
      connectorId: "private-routing-id",
      toolName: "observe",
      resourceId: "private-computer-id",
    },
  };
}

async function bridge(
  input: {
    executeTool?: AgentRunRequest["executeTool"];
    tools?: ConnectorTool[];
    onToolCompleted?: AgentRunRequest["onToolCompleted"];
  } = {},
) {
  const tools = input.tools ?? [tool()];
  const executeTool = vi.fn(input.executeTool ?? (async () => ({ ok: true })));
  const onToolCompleted = vi.fn(input.onToolCompleted ?? (async () => {}));
  const emit = vi.fn();
  const pause = vi.fn();
  const controller = new AbortController();
  const request: AgentRunRequest = {
    botId: "fixture-bot",
    threadId: "fixture-product-thread",
    runId: "fixture-run",
    prompt: "offline fixture",
    instructions: "",
    history: [],
    tools,
    model: { provider: "fixture", id: "never-called" },
    executeTool,
    onToolCompleted,
  };
  const transport = await createCodexToolBridge({
    request,
    tools,
    signal: controller.signal,
    emit,
    pause,
  });
  cleanup.push(() => transport.close());
  return { ...transport, executeTool, onToolCompleted, emit, pause, controller };
}

function post(
  socket: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { socketPath: socket, path: "/tools", method: "POST", agent: false },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function call(name: string, executionId = "call-1", args: unknown = {}) {
  return { method: "tools/call", executionId, params: { name, arguments: args } };
}

async function mcp(socket: string) {
  const client = new Client({ name: "offline-bridge-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("./codex-mcp-stdio.mjs", import.meta.url))],
    env: { RAKAZO_CODEX_TOOL_SOCKET: socket },
    stderr: "pipe",
  });
  cleanup.push(() => client.close());
  await client.connect(transport);
  return client;
}

describe("Codex scoped tool bridge", () => {
  it("lists only granted public schemas and restricts its socket permissions", async () => {
    const b = await bridge();
    expect((await stat(b.socket)).mode & 0o777).toBe(0o600);
    const result = await post(b.socket, { method: "tools/list" });
    expect(result.status).toBe(200);
    expect(result.body.tools).toEqual([
      {
        name: "computer_observe",
        description: tool().description,
        inputSchema: tool().inputSchema,
      },
    ]);
    expect(JSON.stringify(result.body)).not.toContain("private-");
    expect(b.executeTool).not.toHaveBeenCalled();
  });

  it.each([
    call("ungranted_tool"),
    call("computer_observe", "bad/id"),
    call("computer_observe", "call-array", []),
    { method: "shell/exec", executionId: "call-shell" },
  ])(
    "rejects unknown tools, unsupported methods, invalid args or execution IDs: %j",
    async (body) => {
      const b = await bridge();
      expect(await post(b.socket, body)).toEqual({
        status: 403,
        body: { error: "Tool request unavailable" },
      });
      expect(b.executeTool).not.toHaveBeenCalled();
      expect(b.emit).not.toHaveBeenCalled();
    },
  );

  it("serializes concurrent callers including completion callbacks", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const order: string[] = [];
    const b = await bridge({
      executeTool: async (_name, args) => {
        order.push(`start-${args.n}`);
        if (args.n === 1) {
          started.resolve();
          await gate.promise;
        }
        order.push(`end-${args.n}`);
        return args.n;
      },
      onToolCompleted: async ({ result }) => {
        order.push(`complete-${result}`);
      },
    });
    const first = post(b.socket, call("computer_observe", "call-first", { n: 1 }));
    await started.promise;
    const second = post(b.socket, call("computer_observe", "call-second", { n: 2 }));
    try {
      await delay(30);
      expect(order).toEqual(["start-1"]);
    } finally {
      gate.resolve();
    }
    expect((await Promise.all([first, second])).map((result) => result.status)).toEqual([200, 200]);
    expect(order).toEqual(["start-1", "end-1", "complete-1", "start-2", "end-2", "complete-2"]);
    expect(b.executeTool.mock.calls[0]?.[2]).toBe(
      JSON.stringify(["codex-tool", "fixture-run", "call-first"]),
    );
    expect(b.executeTool.mock.calls[0]?.[3]).toEqual(tool().route);
  });

  it("rejects queued and new work after interruption without executing a second tool", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const b = await bridge({
      executeTool: async () => {
        started.resolve();
        await gate.promise;
        return "done";
      },
    });
    const first = post(b.socket, call("computer_observe", "first"));
    await started.promise;
    const second = post(b.socket, call("computer_observe", "second"));
    b.controller.abort();
    gate.resolve();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(403);
    expect((await post(b.socket, call("computer_observe", "third"))).status).toBe(403);
    expect(b.executeTool).toHaveBeenCalledTimes(1);
  });

  it("returns sanitized errors and releases the serialization queue after executor failure", async () => {
    let calls = 0;
    const b = await bridge({
      executeTool: async () => {
        if (++calls === 1) throw new Error("fixture-private-executor-detail");
        return { ok: true };
      },
    });
    const first = await post(b.socket, call("computer_observe", "first"));
    expect(first.body).toEqual({
      isError: true,
      content: [{ type: "text", text: "The requested tool failed." }],
    });
    expect(b.onToolCompleted.mock.calls[0]?.[0]?.error).toBeInstanceOf(Error);
    expect((await post(b.socket, call("computer_observe", "second"))).body).toEqual({
      content: [{ type: "text", text: '{"ok":true}' }],
    });
  });

  it.each(["ask_user", "request_takeover"])(
    "pauses %s without dispatching an executor side effect",
    async (name) => {
      const b = await bridge({ tools: [tool(name)] });
      expect(
        (
          await post(
            b.socket,
            call(name, "pause", { question: "Proceed?", options: ["Yes", "No"], reason: "Login" }),
          )
        ).status,
      ).toBe(200);
      expect(b.pause).toHaveBeenCalledTimes(1);
      expect(b.executeTool).not.toHaveBeenCalled();
      expect(b.onToolCompleted).toHaveBeenCalledTimes(1);
      expect(b.emit).toHaveBeenCalledWith(
        expect.objectContaining({ type: name === "ask_user" ? "ask" : "takeover" }),
      );
    },
  );

  it("closes idle sockets, removes the private directory and rejects further connections", async () => {
    const b = await bridge();
    await b.close();
    await expect(stat(dirname(b.socket))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(post(b.socket, call("computer_observe"))).rejects.toThrow();
  });

  it("finishes shutdown after abort even if an in-flight executor does not settle", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const b = await bridge({
      executeTool: async () => {
        started.resolve();
        await gate.promise;
        return null;
      },
    });
    const active = post(b.socket, call("computer_observe")).catch(() => undefined);
    await started.promise;
    b.controller.abort();
    const closing = b.close();
    try {
      // Bounded observation; cleanup always releases the fake executor, including on failure.
      const completed = await Promise.race([
        closing.then(() => true),
        delay(1_000).then(() => false),
      ]);
      expect(completed).toBe(true);
    } finally {
      gate.resolve();
      await closing;
      await active;
    }
  });
});

describe("MCP stdio frontend (real offline child processes)", () => {
  it("initializes, lists tools and relays text plus image blocks unchanged", async () => {
    const content = [
      { type: "text", text: "Screenshot from the assigned computer" },
      { type: "image", mimeType: "image/png", data: PNG },
    ];
    const b = await bridge({ executeTool: async () => ({ kind: "agent_tool_result", content }) });
    const client = await mcp(b.socket);
    expect((await client.listTools()).tools.map((item) => item.name)).toEqual(["computer_observe"]);
    const result = await client.callTool({ name: "computer_observe", arguments: {} });
    expect(result.content).toEqual(content);
    expect(b.executeTool.mock.calls[0]?.[2]).toMatch(
      /^\["codex-tool","fixture-run","[a-f0-9-]+"\]$/,
    );
    await client.ping();
  });

  it("refuses an ungranted tool from a real MCP child without executing it", async () => {
    const b = await bridge();
    const client = await mcp(b.socket);
    await expect(client.callTool({ name: "host_shell", arguments: {} })).rejects.toThrow(
      "scoped Rakazo tool connection is unavailable",
    );
    expect(b.executeTool).not.toHaveBeenCalled();
  });

  it("shares the same serial writer grant across two native-child MCP processes", async () => {
    const gate = deferred<void>();
    const started = deferred<void>();
    const order: number[] = [];
    const b = await bridge({
      executeTool: async (_name, args) => {
        order.push(Number(args.n));
        if (args.n === 1) {
          started.resolve();
          await gate.promise;
        }
        return args.n;
      },
    });
    const one = await mcp(b.socket);
    const two = await mcp(b.socket);
    const first = one.callTool({ name: "computer_observe", arguments: { n: 1 } });
    await started.promise;
    const second = two.callTool({ name: "computer_observe", arguments: { n: 2 } });
    try {
      await delay(30);
      expect(order).toEqual([1]);
    } finally {
      gate.resolve();
    }
    await Promise.all([first, second]);
    expect(order).toEqual([1, 2]);
  });
});
