import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import type { CodexConnectionOptions } from "./codex-app-server.js";
import { CodexAgentRuntime } from "./codex-runtime.js";
import { CodexToolJournal } from "./codex-tool-journal.js";

const directories: string[] = [];
beforeEach(() => vi.stubEnv("RAKAZO_CODEX_CRASH_GATE", ""));
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const shell: ConnectorTool = {
  name: "shell",
  description: "Inert test effect",
  inputSchema: { type: "object" },
};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function collect(stream: AsyncIterable<AgentRuntimeEvent>, output: AgentRuntimeEvent[] = []) {
  for await (const event of stream) output.push(event);
  return output;
}
function post(socket: string, name = "shell", executionId = "call-one") {
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { socketPath: socket, method: "POST", path: "/tools", agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify({ method: "tools/call", executionId, params: { name, arguments: {} } }));
  });
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "codex-pending-tools-"));
  directories.push(root);
  const executeTool = vi.fn<NonNullable<AgentRunRequest["executeTool"]>>(async () => ({ code: 0 }));
  const onToolCompleted = vi.fn<NonNullable<AgentRunRequest["onToolCompleted"]>>(async () => {});
  const request: AgentRunRequest = {
    runId: "run-one",
    botId: "bot-one",
    threadId: "product-thread",
    prompt: "Offline task",
    instructions: "",
    history: [],
    tools: [shell],
    executeTool,
    onToolCompleted,
    model: {
      provider: "fixture",
      id: "unused",
      apiKey: "fake-key",
      baseUrl: "https://model.invalid/v1",
    },
  };
  const owner = JSON.stringify(["", "", request.threadId, request.botId]);
  const home = join(root, digest(owner));
  const stateFile = join(home, "session.json");
  const behavior: {
    status: string;
    beforeEnd?: (connection: CodexConnectionOptions, socket: string) => Promise<void>;
    afterEnd?: (connection: CodexConnectionOptions, socket: string) => Promise<void>;
  } = { status: "completed" };
  const factory = vi.fn((connection: CodexConnectionOptions) => {
    const entry = connection.args.find((arg) =>
      arg.startsWith("mcp_servers.rakazo.env.RAKAZO_CODEX_TOOL_SOCKET="),
    )!;
    const socket = JSON.parse(entry.slice(entry.indexOf("=") + 1)) as string;
    return {
      notify() {},
      async close() {},
      async request(method: string) {
        if (method === "thread/start" || method === "thread/resume")
          return { thread: { id: "native-root", turns: [] } };
        if (method === "turn/start") {
          connection.onNotification({
            method: "thread/started",
            params: { thread: { id: "native-child", parentThreadId: "native-root" } },
          });
          await behavior.beforeEnd?.(connection, socket);
          if (behavior.status !== "paused") {
            connection.onNotification({
              method: "item/completed",
              params: {
                threadId: "native-root",
                item: { type: "agentMessage", text: "Root finished", phase: "final" },
              },
            });
            connection.onNotification({
              method: "turn/completed",
              params: {
                threadId: "native-root",
                turn: { id: "turn-one", status: behavior.status },
              },
            });
          }
          await behavior.afterEnd?.(connection, socket);
          return { turn: { id: "turn-one" } };
        }
        return {};
      },
    };
  });
  const runtime = () =>
    new CodexAgentRuntime({ sessionRoot: root, connectionFactory: factory, runTimeoutMs: 3_000 });
  const journal = (runId = request.runId) =>
    new CodexToolJournal(
      join(home, "operations"),
      { ...request, runId },
      new AbortController().signal,
    );
  const readState = async () => JSON.parse(await readFile(stateFile, "utf8"));
  const seed = async (
    status: string,
    receipt: "prepared" | "dispatched" | "completed" | "missing",
    marker = true,
  ) => {
    await mkdir(home, { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({
        version: 1,
        owner,
        rootThreadId: "native-root",
        revision: 2,
        nodes: Object.fromEntries(
          ["native-root", "native-child"].map((id) => [
            id,
            {
              type: "subagent",
              runtime: "codex",
              rootThreadId: "native-root",
              threadId: id,
              agentId: id,
              parentThreadId: id === "native-root" ? null : "native-root",
              name: id,
              task: "",
              status: "running",
              nativeStatus: "running",
              nativeRevision: 2,
            },
          ]),
        ),
        runs: { [request.runId]: { status, ...(marker ? { journalVersion: 1 } : {}) } },
      }),
    );
    if (receipt !== "missing") {
      const seedJournal = new CodexToolJournal(
        join(home, "operations"),
        { ...request, executeTool: async () => ({ code: 0 }) },
        new AbortController().signal,
      );
      await seedJournal.initialize();
      await seedJournal.execute(shell, {}, "seed-operation");
      if (receipt !== "completed") {
        const file = join(
          home,
          "operations",
          digest(request.runId),
          `${digest("seed-operation")}.json`,
        );
        const record = JSON.parse(await readFile(file, "utf8"));
        delete record.result;
        await writeFile(file, JSON.stringify({ ...record, status: receipt }));
      }
    }
  };
  return {
    root,
    home,
    request,
    executeTool,
    onToolCompleted,
    behavior,
    factory,
    runtime,
    journal,
    readState,
    stateFile,
    seed,
  };
}

describe("Codex terminal operation barrier", () => {
  it.each(["completed", "interrupted"])(
    "refuses root %s while a child executor is pending, including after late settlement",
    async (status) => {
      const f = await fixture();
      const started = deferred();
      const release = deferred();
      const settled = deferred();
      f.executeTool.mockImplementation(async () => {
        started.resolve();
        await release.promise;
        return { code: 0 };
      });
      f.onToolCompleted.mockImplementation(async () => {
        settled.resolve();
      });
      let http: Promise<unknown> | undefined;
      f.behavior.status = status;
      f.behavior.beforeEnd = async (_connection, socket) => {
        http = post(socket).catch(() => undefined);
        await started.promise;
      };
      try {
        const events: AgentRuntimeEvent[] = [];
        await expect(collect(f.runtime().run(f.request), events)).rejects.toThrow("needs review");
        expect(events.some((event) => event.type === "done")).toBe(false);
        expect(events).toContainEqual(
          expect.objectContaining({
            type: "subagent",
            agentId: "native-child",
            nativeStatus: "recovery_required",
          }),
        );
        expect((await f.readState()).runs["run-one"]).toMatchObject({
          status: "recovery_required",
          journalVersion: 1,
        });
        expect((await f.journal().records())[0]?.status).toBe("dispatched");
        await expect(collect(f.runtime().run({ ...f.request, runId: "run-two" }))).rejects.toThrow(
          "needs review",
        );
        expect(f.factory).toHaveBeenCalledOnce();
        expect(f.executeTool).toHaveBeenCalledOnce();
        release.resolve();
        await settled.promise;
        expect((await f.journal().records())[0]?.status).toBe("completed");
        expect((await f.readState()).runs["run-one"].status).toBe("recovery_required");
        await expect(collect(f.runtime().run({ ...f.request, runId: "run-two" }))).rejects.toThrow(
          "needs review",
        );
        expect(f.executeTool).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await settled.promise;
        await http;
      }
    },
  );

  it("seals admission even before the accepted operation creates its first receipt", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const settled = deferred();
    const execute = CodexToolJournal.prototype.execute;
    vi.spyOn(CodexToolJournal.prototype, "execute").mockImplementation(async function (
      this: CodexToolJournal,
      ...args
    ) {
      entered.resolve();
      await release.promise;
      return execute.apply(this, args);
    });
    f.onToolCompleted.mockImplementation(async () => {
      settled.resolve();
    });
    let http: Promise<unknown> | undefined;
    f.behavior.beforeEnd = async (_connection, socket) => {
      http = post(socket).catch(() => undefined);
      await entered.promise;
    };
    try {
      await expect(collect(f.runtime().run(f.request))).rejects.toThrow("needs review");
      expect(await f.journal().records()).toEqual([]);
      expect(f.executeTool).not.toHaveBeenCalled();
      await expect(collect(f.runtime().run({ ...f.request, runId: "run-two" }))).rejects.toThrow(
        "needs review",
      );
    } finally {
      release.resolve();
      await settled.promise;
      await http;
    }
  });

  it.each(["completed", "paused", "interrupted"])(
    "checks unresolved receipts behind an older %s status before a new run",
    async (status) => {
      const f = await fixture();
      await f.seed(status, "dispatched");
      await expect(collect(f.runtime().run({ ...f.request, runId: "run-two" }))).rejects.toThrow(
        "needs review",
      );
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.executeTool).not.toHaveBeenCalled();
      expect((await f.readState()).runs["run-one"].status).toBe("recovery_required");
    },
  );

  it.each(["prepared", "dispatched", "missing"] as const)(
    "blocks same-run completed replay with %s receipts, even without the old terminal marker",
    async (receipt) => {
      const f = await fixture();
      await f.seed("completed", receipt, false);
      const events: AgentRuntimeEvent[] = [];
      await expect(collect(f.runtime().run(f.request), events)).rejects.toThrow("needs review");
      expect(events.some((event) => event.type === "done")).toBe(false);
      expect(f.factory).not.toHaveBeenCalled();
      expect(f.executeTool).not.toHaveBeenCalled();
    },
  );

  it("blocks recovery of another run when an older completed run has an unresolved receipt", async () => {
    const f = await fixture();
    await f.seed("completed", "dispatched", false);
    const state = await f.readState();
    state.runs["run-two"] = { status: "running", journalVersion: 1 };
    await writeFile(f.stateFile, JSON.stringify(state));
    await f.journal("run-two").initialize();
    await expect(collect(f.runtime().run({ ...f.request, runId: "run-two" }))).rejects.toThrow(
      "needs review",
    );
    expect(f.factory).not.toHaveBeenCalled();
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it("rejects recovery tool attempts even when root completion is already queued", async () => {
    const f = await fixture();
    await f.seed("running", "completed");
    f.behavior.afterEnd = async (connection, socket) => {
      expect(connection.args).toContain("features.multi_agent=false");
      expect(await post(socket, "shell", "malicious-new-id")).toBe(403);
    };
    const events: AgentRuntimeEvent[] = [];
    await expect(collect(f.runtime().run(f.request), events)).rejects.toThrow("needs review");
    expect(events.some((event) => event.type === "done")).toBe(false);
    expect((await f.readState()).runs["run-one"].status).toBe("recovery_required");
    expect(f.executeTool).not.toHaveBeenCalled();
  });

  it.each(["ask_user", "request_takeover"])(
    "preserves harmless %s pause while its audit callback is pending",
    async (name) => {
      const f = await fixture();
      const control = { ...shell, name };
      f.request.tools = [control];
      const entered = deferred();
      const release = deferred();
      const settled = deferred();
      f.onToolCompleted.mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        settled.resolve();
      });
      let http: Promise<unknown> | undefined;
      f.behavior.status = "paused";
      f.behavior.beforeEnd = async (_connection, socket) => {
        http = post(socket, name).catch(() => undefined);
        await entered.promise;
      };
      try {
        const events = await collect(f.runtime().run(f.request));
        expect(
          events.some((event) => event.type === (name === "ask_user" ? "ask" : "takeover")),
        ).toBe(true);
        expect((await f.readState()).runs["run-one"]).toMatchObject({
          status: "paused",
          journalVersion: 1,
        });
        expect(await f.journal().records()).toEqual([]);
        expect(f.executeTool).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await settled.promise;
        await http;
      }
    },
  );

  it("preserves a journaled product-approval pause while its audit callback is pending", async () => {
    const f = await fixture();
    const entered = deferred();
    const release = deferred();
    const settled = deferred();
    f.executeTool.mockResolvedValue(approvalPausedToolResult());
    f.onToolCompleted.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      settled.resolve();
    });
    let http: Promise<unknown> | undefined;
    f.behavior.status = "paused";
    f.behavior.beforeEnd = async (_connection, socket) => {
      http = post(socket).catch(() => undefined);
      await entered.promise;
    };
    try {
      await collect(f.runtime().run(f.request));
      expect((await f.readState()).runs["run-one"]).toMatchObject({
        status: "paused",
        journalVersion: 1,
      });
      expect((await f.journal().records())[0]).toMatchObject({
        status: "completed",
        result: approvalPausedToolResult(),
      });
      expect(f.executeTool).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await settled.promise;
      await http;
    }
  });

  it("allows settled completion, same-ID projection replay, and a new run", async () => {
    const f = await fixture();
    let id = 0;
    f.behavior.beforeEnd = async (_connection, socket) => {
      expect(await post(socket, "shell", `call-${++id}`)).toBe(200);
    };
    expect((await collect(f.runtime().run(f.request))).at(-1)).toMatchObject({ type: "done" });
    expect((await f.readState()).runs["run-one"]).toMatchObject({
      status: "completed",
      journalVersion: 1,
    });
    await collect(f.runtime().run(f.request));
    expect(f.executeTool).toHaveBeenCalledOnce();
    await collect(f.runtime().run({ ...f.request, runId: "run-two" }));
    expect(f.executeTool).toHaveBeenCalledTimes(2);
  });
});
