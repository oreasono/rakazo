import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunRequest, AgentRuntimeEvent, ConnectorTool } from "@rakazo/adapter-kit";
import { isToolPauseResult } from "./approval-effect.js";

export async function createCodexToolBridge(options: {
  request: AgentRunRequest;
  tools: ConnectorTool[];
  signal: AbortSignal;
  emit: (event: AgentRuntimeEvent) => void;
  pause: () => void;
}) {
  const directory = await mkdtemp(join(tmpdir(), "rkc-"));
  const socket = join(directory, "tools.sock");
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  let serial = Promise.resolve();
  let closed = false;
  const server = createServer(async (req, res) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== "POST" || req.url !== "/tools") throw new Error("Invalid route");
      let data = "";
      for await (const chunk of req) {
        data += chunk.toString();
        if (Buffer.byteLength(data) > 1024 * 1024) throw new Error("Request too large");
      }
      const body = JSON.parse(data) as {
        method: string;
        executionId: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (closed || options.signal.aborted) throw new Error("Run ended");
      if (body.method === "tools/list") {
        reply(200, {
          tools: options.tools.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema,
          })),
        });
        return;
      }
      const name = body.params?.name;
      const tool = name ? tools.get(name) : undefined;
      if (body.method !== "tools/call" || !tool || !/^[a-zA-Z0-9-]{1,80}$/.test(body.executionId)) {
        throw new Error("Tool is not granted");
      }
      const args = body.params?.arguments ?? {};
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid arguments");
      const executionId = JSON.stringify(["codex-tool", options.request.runId, body.executionId]);
      // Native children inherit one root-scoped tool grant and one desktop writer.
      const work = serial.then(async () => {
        if (closed || options.signal.aborted) throw new Error("Run ended");
        const startedAt = Date.now();
        options.emit({ type: "tool", name: tool.name, args, executionId });
        let result: unknown;
        let failure: unknown;
        try {
          if (tool.name === "ask_user") {
            const labels = Array.isArray(args.options) ? args.options.map(String) : [];
            options.emit({
              type: "ask",
              text: String(args.question ?? "Please choose"),
              actions: labels.map((label, i) => ({ id: `choice-${i + 1}`, label })),
            });
            options.pause();
            return { content: [{ type: "text", text: "Waiting for the user." }] };
          }
          if (tool.name === "request_takeover") {
            options.emit({ type: "takeover", reason: String(args.reason ?? "Takeover requested") });
            options.pause();
            return { content: [{ type: "text", text: "Waiting for takeover." }] };
          }
          if (!options.request.executeTool) throw new Error("No tool executor");
          result = await options.request.executeTool(tool.name, args, executionId, tool.route);
          if (isToolPauseResult(result)) options.pause();
          if (
            result &&
            typeof result === "object" &&
            "kind" in result &&
            result.kind === "agent_tool_result" &&
            "content" in result
          ) {
            return { content: result.content };
          }
          return { content: [{ type: "text", text: JSON.stringify(result ?? null) }] };
        } catch (error) {
          failure = error;
          // Preserve a useful error without returning arbitrary adapter diagnostics.
          return { isError: true, content: [{ type: "text", text: "The requested tool failed." }] };
        } finally {
          await options.request.onToolCompleted?.({
            name: tool.name,
            executionId,
            durationMs: Date.now() - startedAt,
            ...(result === undefined ? {} : { result }),
            ...(failure === undefined ? {} : { error: failure }),
          });
        }
      });
      serial = work.then(
        () => undefined,
        () => undefined,
      );
      reply(200, await work);
    } catch {
      reply(403, { error: "Tool request unavailable" });
    }
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return {
    socket,
    async close() {
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      // Cancellation revokes this bridge immediately. A faulty downstream tool
      // must not keep the runtime lock or its listener alive indefinitely.
      // The executor owns cancellation of any already-started external effect.
      if (!options.signal.aborted) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            options.signal.removeEventListener("abort", finish);
            resolve();
          };
          options.signal.addEventListener("abort", finish, { once: true });
          void serial.then(finish, finish);
          if (options.signal.aborted) finish();
        });
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}
