import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexConnectionOptions, CodexObject } from "./codex-app-server.js";
import { CodexAgentRuntime } from "./codex-runtime.js";

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "codex-runtime-test-"));
  temporary.push(path);
  return path;
}

function input(runId = "run-one"): AgentRunRequest {
  return {
    botId: "bot-one",
    threadId: "product-thread",
    runId,
    prompt: "Delegate to a native child",
    instructions: "Use the assigned computer",
    history: [{ role: "user", content: "do not replay history" }],
    tools: [],
    model: {
      provider: "custom",
      id: "test-model",
      apiKey: "test-only-key",
      baseUrl: "https://model.invalid/v1",
    },
  };
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>) {
  const result: AgentRuntimeEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

function fakeServer() {
  const calls: Array<{ method: string; params: CodexObject }> = [];
  const connections: CodexConnectionOptions[] = [];
  let starts = 0;
  const factory = (options: CodexConnectionOptions) => {
    connections.push(options);
    return {
      notify() {},
      async close() {},
      async request(method: string, params: CodexObject): Promise<CodexObject> {
        calls.push({ method, params });
        if (method === "thread/start" || method === "thread/resume")
          return { thread: { id: "native-root", turns: [] } };
        if (method === "turn/start") {
          starts++;
          const turnId = `native-turn-${starts}`;
          queueMicrotask(() => {
            options.onNotification({
              method: "thread/started",
              params: {
                thread: {
                  id: "native-child",
                  parentThreadId: "native-root",
                  agentNickname: "Helper",
                },
              },
            });
            options.onNotification({
              method: "item/completed",
              params: {
                threadId: "native-root",
                item: {
                  type: "collabAgentToolCall",
                  tool: "spawnAgent",
                  senderThreadId: "native-root",
                  receiverThreadIds: ["native-child"],
                  prompt: "Use the assigned VM",
                  agentsStates: { "native-child": { status: "running" } },
                },
              },
            });
            options.onNotification({
              method: "item/completed",
              params: {
                threadId: "native-child",
                item: {
                  type: "agentMessage",
                  text: "Child artifact verified",
                  phase: "final",
                },
              },
            });
            options.onNotification({
              method: "turn/completed",
              params: {
                threadId: "native-child",
                turn: { id: "child-turn", status: "completed" },
              },
            });
            options.onNotification({
              method: "item/completed",
              params: {
                threadId: "native-root",
                item: {
                  type: "agentMessage",
                  text: `Root result ${starts}`,
                  phase: "final",
                },
              },
            });
            options.onNotification({
              method: "turn/completed",
              params: {
                threadId: "native-root",
                turn: { id: turnId, status: "completed" },
              },
            });
          });
          return { turn: { id: turnId } };
        }
        return {};
      },
    };
  };
  return { factory, calls, connections };
}

describe("Codex-owned runtime", () => {
  it("retains native child IDs and resumes the same root after rebuilding the runtime", async () => {
    const root = await directory();
    const fake = fakeServer();
    const first = await collect(
      new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(input()),
    );
    expect(first).toContainEqual(
      expect.objectContaining({
        type: "subagent",
        runtime: "codex",
        agentId: "native-child",
        threadId: "native-child",
        rootThreadId: "native-root",
        parentThreadId: "native-root",
        status: "completed",
        result: "Child artifact verified",
      }),
    );
    expect(first.filter((event) => event.type === "text")).toEqual([
      { type: "text", text: "Root result 1" },
    ]);
    const second = await collect(
      new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(
        input("run-two"),
      ),
    );
    expect(fake.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(fake.calls.find((call) => call.method === "thread/resume")?.params.threadId).toBe(
      "native-root",
    );
    expect(second).toContainEqual(
      expect.objectContaining({
        type: "checkpoint",
        blob: JSON.stringify({ runtime: "codex", threadId: "native-root", resumed: true }),
      }),
    );
    expect(JSON.stringify(fake.calls)).not.toContain("do not replay history");
    expect(JSON.stringify(fake.calls)).not.toContain("test-only-key");
    const connection = fake.connections[0];
    if (!connection) throw new Error("Expected a Codex connection");
    expect(connection.env.CODEX_HOME).toContain(root);
    expect(connection.args.join(" ")).not.toContain("test-only-key");
  });

  it("replays a completed run's projection without resending the prompt", async () => {
    const root = await directory();
    const fake = fakeServer();
    await collect(
      new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(input()),
    );
    const again = await collect(
      new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(input()),
    );
    expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(again.at(-1)).toEqual({ type: "done", text: "Root result 1" });
  });

  it("refuses ambiguous admission repeatedly, preserving the recovery guard", async () => {
    const root = await directory();
    const fake = fakeServer();
    await collect(
      new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(input()),
    );
    const home = (await readdir(root))[0];
    if (!home) throw new Error("Expected a Codex session directory");
    const stateFile = join(root, home, "session.json");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    state.runs["run-one"] = { status: "starting" };
    await writeFile(stateFile, JSON.stringify(state));
    for (let i = 0; i < 2; i++) {
      await expect(
        collect(
          new CodexAgentRuntime({ sessionRoot: root, connectionFactory: fake.factory }).run(
            input(),
          ),
        ),
      ).rejects.toThrow("worker restart");
    }
    expect(fake.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    expect(JSON.parse(await readFile(stateFile, "utf8")).runs["run-one"].status).toBe("starting");
  });

  it("does not adopt child events without a known parent", async () => {
    const root = await directory();
    const fake = fakeServer();
    const events = await collect(
      new CodexAgentRuntime({
        sessionRoot: root,
        connectionFactory: (options) => {
          options.onNotification({
            method: "thread/started",
            params: {
              thread: {
                id: "unrelated",
                parentThreadId: "another-root",
              },
            },
          });
          return fake.factory(options);
        },
      }).run(input()),
    );
    expect(events.some((event) => event.type === "subagent" && event.agentId === "unrelated")).toBe(
      false,
    );
  });
});
