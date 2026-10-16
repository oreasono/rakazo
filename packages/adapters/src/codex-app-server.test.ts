import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexConnectionOptions, CodexNotification } from "./codex-app-server.js";
import { CodexAppServer, CodexQueue } from "./codex-app-server.js";

// Real local subprocess with a deterministic JSONL peer. No Codex/model/VM is launched.
const PEER = String.raw`
const { createInterface } = require('node:readline');
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const pending = [];
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    send({ method: 'fixture/serverResponse', params: message });
    return;
  }
  const { id, method, params } = message;
  if (method === 'hold') return;
  if (method === 'reverse') {
    pending.push(message);
    if (pending.length === 2) for (const p of pending.reverse()) send({ id: p.id, result: p.params });
  } else if (method === 'child') {
    send({ method: 'thread/started', params: { thread: { id: 'native-child', parentThreadId: 'native-root' } } });
    send({ id, result: {} });
  } else if (method === 'ask') {
    send({ id: 'server-request', method: 'item/tool/request', params: { threadId: 'native-child' } });
    send({ id, result: {} });
  } else if (method === 'turn/interrupt') {
    send({ method: 'turn/completed', params: { ...params, status: 'interrupted' } });
    send({ id, result: {} });
  } else if (method === 'reject') {
    send({ id, error: { code: -32000, message: 'fixture-private-diagnostic' } });
  } else if (method === 'exit') {
    process.stderr.write('fixture-private-stderr');
    process.exit(7);
  } else if (method === 'malformed') {
    process.stdout.write('not-json\n');
  } else if (method === 'ignore-term') {
    process.on('SIGTERM', () => {});
    send({ id, result: {} });
  } else if (id !== undefined) send({ id, result: params });
});
`;

const clients: CodexAppServer[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function connect(overrides: Partial<CodexConnectionOptions> = {}) {
  const notifications: CodexNotification[] = [];
  const onExit = vi.fn();
  const onRequest = vi.fn(async () => ({ allowed: true }));
  const client = new CodexAppServer({
    binary: process.execPath,
    args: ["-e", PEER],
    cwd: tmpdir(),
    env: {},
    onNotification: (event) => notifications.push(event),
    onExit,
    onRequest,
    ...overrides,
  });
  clients.push(client);
  return { client, notifications, onExit, onRequest };
}

describe("Codex app-server JSONL transport (offline real subprocess)", () => {
  it("correlates out-of-order responses and preserves native child notifications", async () => {
    const { client, notifications } = connect();
    expect(
      await Promise.all([
        client.request("reverse", { value: "first" }),
        client.request("reverse", { value: "second" }),
      ]),
    ).toEqual([{ value: "first" }, { value: "second" }]);
    await client.request("child", {});
    expect(notifications).toContainEqual({
      method: "thread/started",
      params: { thread: { id: "native-child", parentThreadId: "native-root" } },
    });
  });

  it("answers server requests and sanitizes rejected request diagnostics", async () => {
    const { client, notifications } = connect({
      onRequest: async () => {
        throw new Error("fixture-private-tool-detail");
      },
    });
    await client.request("ask", {});
    await vi.waitFor(() =>
      expect(notifications).toContainEqual({
        method: "fixture/serverResponse",
        params: { id: "server-request", error: { code: -32603, message: "Request not permitted" } },
      }),
    );
    await expect(client.request("reject", {})).rejects.toThrow("Codex request rejected (-32000)");
    expect(JSON.stringify(notifications)).not.toContain("fixture-private-tool-detail");
  });

  it("can send turn/interrupt while another request is pending, then closes pending calls", async () => {
    const { client, notifications, onExit } = connect();
    const held = client.request("hold", {}).then(
      () => "unexpected success",
      (error: Error) => error.message,
    );
    await client.request("turn/interrupt", { threadId: "native-root", turnId: "native-turn" });
    expect(notifications).toContainEqual({
      method: "turn/completed",
      params: { threadId: "native-root", turnId: "native-turn", status: "interrupted" },
    });
    await client.close();
    expect(await held).toBe("Codex app-server connection closed");
    await expect(client.request("echo", {})).rejects.toThrow("connection closed");
    expect(onExit).not.toHaveBeenCalled();
    await client.close();
  });

  it.each(["exit", "malformed"])(
    "rejects pending calls on %s and reports one sanitized exit",
    async (method) => {
      const { client, onExit } = connect();
      const held = client.request("hold", {}).catch((error: Error) => error.message);
      await expect(client.request(method, {})).rejects.toThrow(
        "Codex app-server connection closed",
      );
      expect(await held).toBe("Codex app-server connection closed");
      expect(onExit).toHaveBeenCalledTimes(1);
      expect(onExit.mock.calls[0]?.[0]?.message).not.toContain("fixture-private");
    },
  );

  it("rejects spawn failure without leaving close waiting for a nonexistent process", async () => {
    const { client, onExit } = connect({ binary: "/nonexistent-codex-fixture/executable" });
    await expect(client.request("initialize", {})).rejects.toThrow("connection closed");
    await client.close();
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("escalates shutdown for a peer that ignores SIGTERM", async () => {
    const { client, onExit } = connect();
    await client.request("ignore-term", {});
    await client.close();
    await expect(client.request("echo", {})).rejects.toThrow("connection closed");
    expect(onExit).not.toHaveBeenCalled();
  }, 6_000);
});

describe("Codex notification queue", () => {
  it("drains buffered notifications before delivering a terminal error", async () => {
    const queue = new CodexQueue<string>();
    queue.push("child-completed");
    queue.end(new Error("transport failed"));
    queue.push("late-event");
    const iterator = queue[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ done: false, value: "child-completed" });
    await expect(iterator.next()).rejects.toThrow("transport failed");
  });

  it("retains the first terminal error if abort cleanup calls end again", async () => {
    const queue = new CodexQueue<string>();
    queue.end(new Error("Codex turn timed out"));
    queue.end();
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toThrow("Codex turn timed out");
  });
});
