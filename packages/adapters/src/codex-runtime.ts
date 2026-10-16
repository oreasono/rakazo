import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import type {
  CodexConnection,
  CodexConnectionOptions,
  CodexNotification,
  CodexObject,
} from "./codex-app-server.js";
import { CodexAppServer, CodexQueue } from "./codex-app-server.js";
import { createCodexToolBridge } from "./codex-tool-bridge.js";

type NativeNode = Extract<AgentRuntimeEvent, { type: "subagent" }> & {
  runtime: "codex";
  rootThreadId: string;
  threadId: string;
  parentThreadId: string | null;
  nativeStatus: string;
  nativeRevision?: number;
};
interface SessionState {
  version: 1;
  owner: string;
  rootThreadId: string;
  nodes: Record<string, NativeNode>;
  revision?: number;
  runs: Record<
    string,
    {
      status: "starting" | "running" | "completed" | "interrupted" | "paused";
      turnId?: string;
      text?: string;
    }
  >;
}
interface CodexThread {
  id: string;
  parentThreadId?: string | null;
  agentNickname?: string;
  preview?: string;
  source?: { subAgent?: { thread_spawn?: { parent_thread_id?: string } } };
  turns?: Array<{ id: string; status: string; items?: CodexItem[] }>;
}
interface CodexItem {
  type: string;
  id?: string;
  text?: string;
  phase?: string;
  tool?: string;
  prompt?: string;
  senderThreadId?: string;
  receiverThreadIds?: string[];
  agentsStates?: Record<string, { status: string; message?: string }>;
}

export interface CodexRuntimeOptions {
  sessionRoot: string;
  binary?: string;
  runTimeoutMs?: number;
  connectionFactory?: (options: CodexConnectionOptions) => CodexConnection;
}

/** Codex owns history and delegation. Rakazo supplies scoped tools and event projections. */
export class CodexAgentRuntime implements AgentRuntime {
  private readonly running = new Map<string, AbortController>();
  constructor(private readonly options: CodexRuntimeOptions) {}

  describe() {
    return {
      id: "codex",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
    };
  }

  async abort(runId: string) {
    this.running.get(runId)?.abort();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (request.model.oauth)
      throw new Error("Codex runtime currently requires an API-key model connection");
    if (!request.model.apiKey || !request.model.baseUrl) {
      throw new Error("Codex runtime requires a configured Responses API endpoint and key");
    }
    const owner = JSON.stringify([
      context?.spaceId ?? "",
      context?.userId ?? "",
      request.threadId,
      request.botId,
    ]);
    const hash = createHash("sha256").update(owner).digest("hex");
    const home = join(resolve(this.options.sessionRoot), hash);
    const codexHome = join(home, "codex");
    const workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const unlock = await claimSession(join(home, "active.lock"));
    const stateFile = join(home, "session.json");
    let state: SessionState;
    try {
      state = JSON.parse(await readFile(stateFile, "utf8")) as SessionState;
      if (state.version !== 1 || state.owner !== owner || !state.rootThreadId)
        throw new Error("Invalid Codex session binding");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        await unlock();
        throw error;
      }
      state = { version: 1, owner, rootThreadId: "", nodes: {}, runs: {} };
    }
    const save = async () => {
      const temporary = `${stateFile}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
        await rename(temporary, stateFile);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    };
    const controller = new AbortController();
    const abortFromContext = () => controller.abort();
    context?.signal?.addEventListener("abort", abortFromContext, { once: true });
    if (context?.signal?.aborted) controller.abort();
    this.running.set(request.runId, controller);
    const queue = new CodexQueue<CodexNotification | { event: AgentRuntimeEvent }>();
    const emit = (event: AgentRuntimeEvent) => queue.push({ event });
    let rpc: CodexConnection | undefined;
    let bridge: Awaited<ReturnType<typeof createCodexToolBridge>> | undefined;
    let turnId: string | undefined;
    let finished = false;
    let admitted = false;
    let paused = false;
    let finalText = "";
    let progressItemId: string | undefined;
    let progressText = "";
    let abortTask: Promise<unknown> | undefined;
    let interruptedTurnId: string | undefined;
    let terminalError: Error | undefined;
    let runFailed = false;
    const scopedThreads = new Set<string>();
    if (state.rootThreadId) scopedThreads.add(state.rootThreadId);
    // Restore only descendants with a complete chain back to this owner's root.
    for (let changed = true; changed; ) {
      changed = false;
      for (const value of Object.values(state.nodes)) {
        if (
          value.rootThreadId === state.rootThreadId &&
          value.parentThreadId &&
          scopedThreads.has(value.parentThreadId) &&
          !scopedThreads.has(value.threadId)
        ) {
          scopedThreads.add(value.threadId);
          changed = true;
        }
      }
    }
    const observeScope = ({ method, params }: CodexNotification) => {
      // Server requests can follow notifications before the generator consumes its queue.
      // Register ancestry synchronously so a legitimate child is not declined in that gap.
      if (method === "thread/started") {
        const child = params.thread as CodexThread | undefined;
        const parent =
          child?.parentThreadId ?? child?.source?.subAgent?.thread_spawn?.parent_thread_id;
        if (child?.id && parent && scopedThreads.has(parent)) scopedThreads.add(child.id);
      }
      const item = params.item as CodexItem | undefined;
      if (
        (method === "item/started" || method === "item/completed") &&
        item?.type === "collabAgentToolCall" &&
        item.tool === "spawnAgent" &&
        typeof params.threadId === "string" &&
        scopedThreads.has(params.threadId) &&
        (!item.senderThreadId || item.senderThreadId === params.threadId)
      ) {
        for (const id of item.receiverThreadIds ?? []) scopedThreads.add(id);
      }
    };
    const interrupt = () => {
      if (rpc && state.rootThreadId && turnId && !finished && interruptedTurnId !== turnId) {
        interruptedTurnId = turnId;
        abortTask = rpc
          .request("turn/interrupt", { threadId: state.rootThreadId, turnId })
          .catch(() => undefined);
      }
    };
    const fail = (error: Error) => {
      terminalError ??= error;
      queue.end(terminalError);
      controller.abort();
    };
    const timeout = setTimeout(
      () => {
        fail(new Error("Codex turn timed out"));
      },
      this.options.runTimeoutMs ?? 15 * 60_000,
    );
    const stop = () => {
      interrupt();
      // Preserve the primary timeout/exit cause when cancellation also ends the stream.
      queue.end(terminalError);
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    const node = (
      id: string,
      parent: string | null,
      patch: Partial<NativeNode> = {},
    ): NativeNode => ({
      type: "subagent",
      runtime: "codex",
      rootThreadId: state.rootThreadId,
      threadId: id,
      parentThreadId: parent,
      agentId: id,
      name: parent ? "Codex agent" : "Codex",
      task: "",
      status: "running",
      nativeStatus: "running",
      ...state.nodes[id],
      ...patch,
    });
    const update = (next: NativeNode) => {
      if (JSON.stringify(state.nodes[next.threadId]) === JSON.stringify(next)) return;
      state.revision = (state.revision ?? 0) + 1;
      next.nativeRevision = state.revision;
      state.nodes[next.threadId] = next;
      emit(next);
    };
    const applyCollab = (item: CodexItem, sender: string) => {
      if (!state.nodes[sender]) return;
      for (const id of item.receiverThreadIds ?? []) {
        if (!state.nodes[id] && item.tool !== "spawnAgent") continue;
        if (item.tool === "spawnAgent" && scopedThreads.has(sender)) scopedThreads.add(id);
        const status = item.agentsStates?.[id];
        update(
          node(id, state.nodes[id] ? state.nodes[id].parentThreadId : sender, {
            ...(item.tool === "spawnAgent" ? { task: item.prompt ?? "" } : {}),
            ...(status
              ? {
                  nativeStatus: status.status,
                  status: normalizedStatus(status.status),
                  ...(status.message ? { result: status.message } : {}),
                }
              : {}),
          }),
        );
      }
    };
    try {
      const priorRun = state.runs[request.runId];
      if (priorRun?.status === "completed") {
        finished = true;
        for (const value of Object.values(state.nodes)) yield value;
        if (priorRun.text) yield { type: "text", text: priorRun.text };
        yield { type: "done", text: priorRun.text };
        return;
      }
      if (priorRun && ["starting", "running", "interrupted"].includes(priorRun.status)) {
        // A crash between sending turn/start and recording its reply is ambiguous.
        // Never repeat an already admitted prompt or an external effect automatically.
        throw new Error(
          "This Codex run was interrupted by a worker restart; send a new message to resume the same conversation",
        );
      }
      controller.signal.throwIfAborted();
      bridge = await createCodexToolBridge({
        request,
        tools: request.tools.filter((tool) => tool.name !== "run_subagent"),
        signal: controller.signal,
        emit,
        pause: () => {
          paused = true;
          queue.push({ method: "rakazo/paused", params: {} });
        },
      });
      controller.signal.throwIfAborted();
      const config: Record<string, unknown> = {
        model_provider: "rakazo",
        "model_providers.rakazo.name": "Rakazo connection",
        "model_providers.rakazo.base_url": request.model.baseUrl,
        "model_providers.rakazo.env_key": "RAKAZO_CODEX_MODEL_KEY",
        "model_providers.rakazo.wire_api": "responses",
        "model_providers.rakazo.requires_openai_auth": false,
        "model_providers.rakazo.supports_websockets": false,
        "mcp_servers.rakazo.command": process.execPath,
        "mcp_servers.rakazo.args": [
          fileURLToPath(new URL("./codex-mcp-stdio.mjs", import.meta.url)),
        ],
        "mcp_servers.rakazo.env.RAKAZO_CODEX_TOOL_SOCKET": bridge.socket,
        "mcp_servers.rakazo.required": true,
        "features.multi_agent": true,
        // The controller delegates computer operations to scoped MCP tools. A read-only
        // sandbox still permits host commands and environment reads, so remove both
        // native shell implementations while retaining Codex's native agent tools.
        "features.shell_tool": false,
        "features.unified_exec": false,
      };
      const env: NodeJS.ProcessEnv = {};
      for (const key of ["PATH", "SYSTEMROOT", "LANG", "TMPDIR"])
        if (process.env[key]) env[key] = process.env[key];
      Object.assign(env, {
        HOME: home,
        CODEX_HOME: codexHome,
        RAKAZO_CODEX_MODEL_KEY: request.model.apiKey,
      });
      const args = ["app-server", "--listen", "stdio://"];
      for (const [key, value] of Object.entries(config))
        args.push("-c", `${key}=${JSON.stringify(value)}`);
      rpc = (this.options.connectionFactory ?? ((options) => new CodexAppServer(options)))({
        binary: this.options.binary ?? "codex",
        args,
        cwd: workspace,
        env,
        onNotification: (notification) => {
          observeScope(notification);
          queue.push(notification);
        },
        onExit: fail,
        onRequest: async (method, params) => {
          if (
            method === "item/commandExecution/requestApproval" ||
            method === "item/fileChange/requestApproval"
          )
            return { decision: "decline" };
          if (method === "mcpServer/elicitation/request") {
            const meta = params._meta as CodexObject | null | undefined;
            const allowed =
              admitted &&
              !finished &&
              !paused &&
              !controller.signal.aborted &&
              params.serverName === "rakazo" &&
              params.mode === "form" &&
              meta?.codex_approval_kind === "mcp_tool_call" &&
              typeof params.threadId === "string" &&
              scopedThreads.has(params.threadId);
            // This authorizes the scoped MCP transport only. The bridge's tool grant and
            // the product executor's approval/effect gate still authorize the operation.
            return { action: allowed ? "accept" : "decline", content: allowed ? {} : null };
          }
          throw new Error("Unsupported Codex server request");
        },
      });
      await rpc.request("initialize", {
        clientInfo: { name: "rakazo", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      controller.signal.throwIfAborted();
      rpc.notify("initialized", {});
      const parameters = {
        model: request.model.id,
        cwd: workspace,
        environments: [],
        sandbox: "read-only",
        approvalPolicy: "never",
        developerInstructions: `${request.instructions}\n\nCodex owns this conversation and native subagent delegation. Use native agent tools for subagents. The available Rakazo MCP tools operate the assigned remote computer; the controller workspace is not that computer. Never replace remote computer operations with local shell commands.`,
      };
      const wasResumed = Boolean(state.rootThreadId);
      const result = await rpc.request(wasResumed ? "thread/resume" : "thread/start", {
        ...parameters,
        ...(wasResumed ? { threadId: state.rootThreadId } : {}),
      });
      controller.signal.throwIfAborted();
      const thread = result.thread as CodexThread;
      if (!thread?.id || (wasResumed && thread.id !== state.rootThreadId))
        throw new Error("Codex thread identity mismatch");
      state.rootThreadId = thread.id;
      scopedThreads.add(thread.id);
      update(
        node(thread.id, null, { task: request.prompt, status: "running", nativeStatus: "running" }),
      );
      // Collab facts in the authoritative resumed thread can repair a missed UI event.
      for (const turn of thread.turns ?? []) {
        for (const item of turn.items ?? [])
          if (item.type === "collabAgentToolCall") applyCollab(item, thread.id);
      }
      for (const value of Object.values(state.nodes)) emit(value);
      await save();
      yield {
        type: "checkpoint",
        blob: JSON.stringify({
          runtime: "codex",
          threadId: state.rootThreadId,
          resumed: wasResumed,
        }),
      };
      controller.signal.throwIfAborted();
      state.runs[request.runId] = { status: "starting" };
      await save();
      controller.signal.throwIfAborted();
      admitted = true;
      const input: CodexObject[] = [{ type: "text", text: request.prompt }];
      for (const image of request.currentTurnImages ?? [])
        input.push({
          type: "image",
          url: `data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")}`,
        });
      const turn = await rpc.request("turn/start", {
        threadId: state.rootThreadId,
        input,
        environments: [],
        effort:
          request.model.thinkingLevel === "off"
            ? "none"
            : (request.model.thinkingLevel ?? "medium"),
      });
      turnId = (turn.turn as { id?: string })?.id;
      if (!turnId) throw new Error("Codex did not return a turn ID");
      // Abort may have arrived while turn/start was in flight and its ID was still unknown.
      if (controller.signal.aborted) {
        interrupt();
        throw terminalError ?? new Error("Codex turn interrupted");
      }
      state.runs[request.runId] = { status: "running", turnId };
      await save();
      for await (const notice of queue) {
        if ("event" in notice) {
          yield notice.event;
          continue;
        }
        const { method, params } = notice;
        if (method === "rakazo/paused") break;
        const tid = String(params.threadId ?? "");
        if (method === "thread/started") {
          const child = params.thread as CodexThread;
          const parent =
            child?.parentThreadId ?? child?.source?.subAgent?.thread_spawn?.parent_thread_id;
          if (child?.id && parent && state.nodes[parent]) {
            update(
              node(child.id, parent, {
                name: child.agentNickname ?? "Codex agent",
                task: child.preview ?? "",
              }),
            );
          }
        }
        const item = params.item as CodexItem | undefined;
        if (
          item?.type === "collabAgentToolCall" &&
          ["item/started", "item/completed"].includes(method) &&
          scopedThreads.has(tid) &&
          (!item.senderThreadId || item.senderThreadId === tid)
        ) {
          applyCollab(item, tid);
        }
        if (method === "item/agentMessage/delta" && state.nodes[tid]) {
          if (tid === state.rootThreadId) {
            const itemId = typeof params.itemId === "string" ? params.itemId : undefined;
            if (progressItemId !== itemId) progressText = "";
            progressItemId = itemId;
            progressText += String(params.delta ?? "");
            // The executor replaces the progress message, so emit this item's full text.
            yield { type: "progress", text: progressText };
          } else
            update(
              node(tid, state.nodes[tid].parentThreadId, {
                progress: `${state.nodes[tid].progress ?? ""}${String(params.delta ?? "")}`.slice(
                  -2000,
                ),
              }),
            );
        }
        if (method === "item/completed" && item?.type === "agentMessage" && state.nodes[tid]) {
          if (tid === state.rootThreadId && item.phase !== "commentary")
            finalText = item.text ?? "";
          else if (tid !== state.rootThreadId)
            update(node(tid, state.nodes[tid].parentThreadId, { result: item.text ?? "" }));
        }
        if (method === "turn/completed" && state.nodes[tid]) {
          const ended = params.turn as { id: string; status: string; error?: { message?: string } };
          if (tid === state.rootThreadId && ended.id === turnId) {
            if (ended.status === "failed") throw new Error("Codex model turn failed");
            if (ended.status !== "completed" && ended.status !== "interrupted") {
              throw new Error("Codex returned an unexpected terminal turn status");
            }
            const interrupted = ended.status === "interrupted";
            update(
              node(tid, null, {
                status: interrupted ? "failed" : "completed",
                nativeStatus: ended.status,
                result: finalText,
              }),
            );
            state.runs[request.runId] = {
              status: interrupted ? "interrupted" : "completed",
              turnId,
              text: finalText,
            };
            await save();
            if (interrupted) throw new Error("Codex turn interrupted");
            // The durable terminal record is authoritative even if the consumer stops at a
            // final text/node event or fails while publishing it. Never overwrite it on return().
            finished = true;
            // Flush queued node projections before ending the runtime generator.
            for (const value of Object.values(state.nodes)) yield value;
            if (finalText) yield { type: "text", text: finalText };
            yield { type: "done", text: finalText };
            return;
          }
          if (tid !== state.rootThreadId)
            update(
              node(tid, state.nodes[tid].parentThreadId, {
                status: ended.status === "completed" ? "completed" : "failed",
                nativeStatus: ended.status,
              }),
            );
        }
        await save();
      }
      if (terminalError) throw terminalError;
      if (!paused) throw new Error("Codex turn ended without completion");
    } catch (error) {
      runFailed = true;
      throw terminalError ?? error;
    } finally {
      clearTimeout(timeout);
      context?.signal?.removeEventListener("abort", abortFromContext);
      let cleanupError: unknown;
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          cleanupError ??= error;
        }
      };
      // Revoke tool admission on every exit, including a completed result's early return.
      controller.abort();
      if (!finished && state.rootThreadId && admitted) {
        await cleanup(async () => {
          state.runs[request.runId] = { status: paused ? "paused" : "interrupted", turnId };
          state.revision = (state.revision ?? 0) + 1;
          state.nodes[state.rootThreadId] = node(state.rootThreadId, null, {
            status: paused ? "running" : "failed",
            nativeStatus: paused ? "waiting" : "interrupted",
            nativeRevision: state.revision,
          });
          await save();
        });
      }
      await cleanup(async () => abortTask);
      await cleanup(async () => rpc?.close());
      await cleanup(async () => bridge?.close());
      controller.signal.removeEventListener("abort", stop);
      if (this.running.get(request.runId) === controller) this.running.delete(request.runId);
      queue.end();
      await cleanup(unlock);
      // biome-ignore lint/correctness/noUnsafeFinally: Report cleanup failure only when no primary run error is being rethrown.
      if (cleanupError && !runFailed) throw cleanupError;
    }
  }
}

function normalizedStatus(status: string): "running" | "completed" | "failed" {
  if (status === "completed" || status === "shutdown") return "completed";
  if (["errored", "notFound", "interrupted", "failed"].includes(status)) return "failed";
  return "running";
}

async function claimSession(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await createSessionLock(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-lock removal: two contenders must not both unlink after one
      // has already acquired the replacement lock. An abandoned reclaim guard fails
      // closed and requires operator recovery rather than risking concurrent effects.
      const releaseReclaim = await createSessionLock(`${path}.reclaim`).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error("Codex session lock recovery is already in progress");
        throw error;
      });
      try {
        let lock: { pid: number };
        try {
          lock = JSON.parse(await readFile(path, "utf8")) as { pid: number };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
          throw new Error("Invalid Codex session lock");
        try {
          process.kill(lock.pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
            await unlink(path);
            continue;
          }
        }
        throw new Error("This Codex conversation already has an active run");
      } finally {
        await releaseReclaim();
      }
    }
  }
  throw new Error("Could not acquire the Codex conversation");
}

async function createSessionLock(path: string): Promise<() => Promise<void>> {
  const file = await open(path, "wx", 0o600);
  const owner = randomUUID();
  try {
    await file.writeFile(JSON.stringify({ pid: process.pid, owner }));
  } catch (error) {
    await unlink(path).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
  return async () => {
    try {
      const lock = JSON.parse(await readFile(path, "utf8")) as { owner?: string };
      // Never release a replacement lock after an operator has recovered the session.
      if (lock.owner === owner) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
