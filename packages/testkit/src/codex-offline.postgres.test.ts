import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CodexAgentRuntime, ComposioEmulator } from "@rakazo/adapters";
import type { ThreadSnapshot } from "@rakazo/contracts";
import { buildNativeSessionTrees, DEFAULT_AGENT_KNOWLEDGE } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import type { CodexConnectionOptions, CodexObject } from "../../adapters/src/codex-app-server.js";
import { CodexAppServer } from "../../adapters/src/codex-app-server.js";
import { sessionCookieHeader } from "./index.js";
import { startModelEmulator } from "./model-emulator.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const origin = "http://127.0.0.1:5173";

describe.skipIf(!enabled)("offline Codex product journey", () => {
  it("uses saved model settings and scoped MCP to persist a file, native tree and completed run", async () => {
    const fixtureKey = "offline-codex-fixture-key";
    // Provides only the saved compatible model connection; no model turn is allowed.
    const model = await startModelEmulator({ apiKey: fixtureKey, steps: [] });
    const dataDir = await mkdtemp(path.join(tmpdir(), "rakazo-codex-product-"));
    const connections: CodexConnectionOptions[] = [];
    let turns = 0;
    let stop: (() => Promise<void>) | undefined;
    try {
      const runtime = new CodexAgentRuntime({
        sessionRoot: path.join(dataDir, "codex-sessions"),
        connectionFactory: (connection) => {
          connections.push(connection);
          const config = (key: string) => {
            const value = connection.args.find((arg) => arg.startsWith(`${key}=`));
            if (!value) throw new Error(`Missing Codex config: ${key}`);
            return JSON.parse(value.slice(key.length + 1));
          };
          expect(config("model_providers.rakazo.base_url")).toBe(model.baseUrl);
          expect(connection.env.RAKAZO_CODEX_MODEL_KEY).toBe(fixtureKey);
          return {
            notify() {},
            async close() {},
            async request(method: string, params: CodexObject): Promise<CodexObject> {
              if (method === "thread/start") {
                expect(params.model).toBe(model.model.id);
                expect(params.developerInstructions).toContain(DEFAULT_AGENT_KNOWLEDGE);
                return { thread: { id: "fixture-native-root", turns: [] } };
              }
              if (method !== "turn/start") return {};
              turns++;
              expect(JSON.stringify(params.input)).toContain("Save hello to notes/result.txt.");
              connection.onNotification({
                method: "thread/started",
                params: {
                  thread: {
                    id: "fixture-native-child",
                    parentThreadId: "fixture-native-root",
                    agentNickname: "File helper",
                  },
                },
              });
              // Reuse the JSON-RPC stdio transport to run the actual MCP frontend
              // configured by CodexAgentRuntime, including its private bridge socket.
              const mcp = new CodexAppServer({
                binary: config("mcp_servers.rakazo.command"),
                args: config("mcp_servers.rakazo.args"),
                cwd: connection.cwd,
                env: {
                  RAKAZO_CODEX_TOOL_SOCKET: config(
                    "mcp_servers.rakazo.env.RAKAZO_CODEX_TOOL_SOCKET",
                  ),
                },
                onNotification() {},
                onRequest: async () => {
                  throw new Error("Unexpected MCP request");
                },
                onExit() {},
              });
              try {
                await mcp.request("initialize", {
                  protocolVersion: "2024-11-05",
                  clientInfo: { name: "offline-product-test", version: "1" },
                  capabilities: {},
                });
                mcp.notify("notifications/initialized", {});
                const listed = await mcp.request("tools/list", {});
                expect(listed.tools).toEqual(
                  expect.arrayContaining([
                    expect.objectContaining({ name: "write_file" }),
                    expect.objectContaining({ name: "shell" }),
                  ]),
                );
                const written = await mcp.request("tools/call", {
                  name: "write_file",
                  arguments: { path: "notes/result.txt", content: "hello" },
                });
                expect(written.isError).not.toBe(true);
                expect(written.content).toEqual([
                  { type: "text", text: JSON.stringify({ ok: true, path: "notes/result.txt" }) },
                ]);
                const shell = await mcp.request("tools/call", {
                  name: "shell",
                  arguments: { command: "wc -c notes/result.txt" },
                });
                expect(shell.isError).not.toBe(true);
              } finally {
                await mcp.close();
              }
              connection.onNotification({
                method: "turn/completed",
                params: {
                  threadId: "fixture-native-child",
                  turn: { id: "fixture-child-turn", status: "completed" },
                },
              });
              connection.onNotification({
                method: "item/completed",
                params: {
                  threadId: "fixture-native-root",
                  item: { type: "agentMessage", text: "Saved notes/result.txt.", phase: "final" },
                },
              });
              connection.onNotification({
                method: "turn/completed",
                params: {
                  threadId: "fixture-native-root",
                  turn: { id: "fixture-root-turn", status: "completed" },
                },
              });
              return { turn: { id: "fixture-root-turn" } };
            },
          };
        },
      });
      const { createApp } = await import("../../../apps/api/src/app.js");
      const handles = await createApp({
        databaseUrl: process.env.DATABASE_URL!,
        realtimeDatabaseUrl: process.env.DATABASE_URL!,
        authUrl: origin,
        webOrigin: origin,
        dataDir,
        sandboxProvider: "fake",
        agentRuntime: "codex",
        runtime,
        wakeupDriver: "memory",
        signupsEnabled: "true",
        deploymentModelKey: "",
        composio: new ComposioEmulator(),
        encryptionKey: "offline-codex-fixture-encryption-key",
      });
      stop = handles.stop;
      const signup = await handles.app.request("/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          email: `offline-codex-${randomUUID()}@rakazo.test`,
          password: "password12",
          name: "Offline fixture",
        }),
      });
      expect(signup.status).toBeLessThan(400);
      const cookie = sessionCookieHeader(signup);
      // Create before connecting a model so no automatic introduction consumes the turn.
      const bot = await rpc<{ id: string }>(handles.app, cookie, "bots/create", {
        name: "File fixture",
        title: "",
        description: "",
        notifyOnFinish: false,
        computerMode: "dedicated",
      });
      await rpc(handles.app, cookie, "models/connect", {
        provider: model.model.provider,
        modelId: model.model.id,
        baseUrl: model.baseUrl,
        apiKey: fixtureKey,
        contextWindow: 160_000,
        maxTokens: 4096,
      });
      await rpc(handles.app, cookie, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
      const sent = await rpc<{ runId: string }>(handles.app, cookie, "threads/send", {
        botId: bot.id,
        text: "Save hello to notes/result.txt.",
      });
      await expect
        .poll(
          async () =>
            handles.prisma.run.findUnique({
              where: { id: sent.runId },
              select: { status: true, error: true },
            }),
          { timeout: 15_000, interval: 100 },
        )
        .toMatchObject({ status: "completed", error: null });
      expect(connections).toHaveLength(1);
      expect(turns).toBe(1);
      model.assertComplete();
      expect(
        await rpc(handles.app, cookie, "computer/readFile", {
          botId: bot.id,
          path: "notes/result.txt",
        }),
      ).toMatchObject({ content: "hello" });
      // Check the durable workspace checkpoint independently of the fake computer's memory.
      expect(await readFile(path.join(dataDir, "homes", bot.id, "notes/result.txt"), "utf8")).toBe(
        "hello",
      );
      const thread = await rpc<ThreadSnapshot>(handles.app, cookie, "threads/get", {
        botId: bot.id,
      });
      expect(JSON.stringify(thread.messages)).toContain("Saved notes/result.txt.");
      expect(JSON.stringify(thread.messages)).not.toContain(fixtureKey);
      const trees = buildNativeSessionTrees(JSON.parse(JSON.stringify(thread.messages)));
      expect(trees).toHaveLength(1);
      expect(trees[0]?.nodes).toMatchObject([
        { threadId: "fixture-native-root", parentThreadId: null, status: "completed" },
        {
          threadId: "fixture-native-child",
          parentThreadId: "fixture-native-root",
          status: "completed",
        },
      ]);
      const commands = await rpc<Array<{ executionId: string; kind: string; status: string }>>(
        handles.app,
        cookie,
        "computer/commands",
        { botId: bot.id },
      );
      expect(commands).toMatchObject([
        { kind: "write_file", command: "notes/result.txt", status: "done", exitCode: 0, bytes: 5 },
        { kind: "shell", command: "wc -c notes/result.txt", status: "done", exitCode: 0 },
      ]);
      expect(new Set(commands.map((command) => command.executionId)).size).toBe(2);
      for (const command of commands)
        expect(JSON.parse(command.executionId)).toEqual([
          "codex-tool",
          sent.runId,
          expect.any(String),
        ]);
      const events = await handles.prisma.event.findMany({
        where: { runId: sent.runId, type: { in: ["agent.tool.called", "run.completed"] } },
      });
      expect(events.filter((event) => event.type === "agent.tool.called")).toHaveLength(2);
      expect(events.filter((event) => event.type === "run.completed")).toHaveLength(1);
    } finally {
      try {
        await stop?.();
      } finally {
        await model.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    }
  }, 30_000);
});

async function rpc<T>(app: App, cookie: string, procedure: string, input: unknown): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin },
    body: JSON.stringify({ json: input }),
  });
  expect(response.status).toBeLessThan(400);
  const body = (await response.json()) as { json: T };
  return body.json;
}
