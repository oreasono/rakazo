import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { AdapterContext, ComputerRef, PortableFile, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncusProcessRequest, IncusSandboxOptions } from "./incus-sandbox.js";
import { IncusSandboxProvider } from "./incus-sandbox.js";
import { INCUS_EXEC_SCRIPT, INCUS_FILE_SCRIPT } from "./incus-sandbox-guest.js";
import { runIncusProcess } from "./incus-sandbox-process.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn((signal: string) => {
      child.emit("close", null, signal);
      return true;
    }),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

describe("Incus process transport (in-memory fake child)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });
  const request: IncusProcessRequest = {
    argv: ["fake-incus", "argument"],
    input: "fake payload\n",
    keepStdinOpen: true,
    timeoutMs: 1000,
    maxOutputBytes: 100,
    signal: new AbortController().signal,
  };

  it("streams decoded UTF-8, separates stderr, preserves exit and never uses a host shell", async () => {
    const child = fakeChild();
    const iterator = runIncusProcess(request)[Symbol.asyncIterator]();
    const first = iterator.next();
    const bytes = Buffer.from("中文");
    child.stdout.write(bytes.subarray(0, 1));
    child.stdout.write(bytes.subarray(1));
    expect(await first).toEqual({ done: false, value: { type: "stdout", data: "中文" } });
    expect(child.stdin.writableEnded).toBe(false);
    expect(child.stdin.read().toString()).toBe("fake payload\n");
    child.stderr.write("warning");
    child.emit("close", 7, null);
    expect((await iterator.next()).value).toEqual({ type: "stderr", data: "warning" });
    expect((await iterator.next()).value).toEqual({ type: "exit", code: 7 });
    expect((await iterator.next()).done).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      "fake-incus",
      ["argument"],
      expect.objectContaining({ shell: false }),
    );
  });

  it("closes one-shot daemon stdin and kills a transport when its consumer stops early", async () => {
    const child = fakeChild();
    const iterator = runIncusProcess({ ...request, keepStdinOpen: false })[Symbol.asyncIterator]();
    const first = iterator.next();
    child.stdout.write("partial");
    await first;
    expect(child.stdin.writableEnded).toBe(true);
    await iterator.return?.();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("aborts the guest liveness channel and transport", async () => {
    const child = fakeChild();
    const controller = new AbortController();
    const pending = events(runIncusProcess({ ...request, signal: controller.signal }));
    const rejected = expect(pending).rejects.toThrow("aborted");
    controller.abort();
    await rejected;
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not spawn for an already aborted operation", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    await expect(
      events(runIncusProcess({ ...request, signal: controller.signal })),
    ).rejects.toThrow("already cancelled");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("bounds output and fails instead of returning a success exit", async () => {
    const child = fakeChild();
    const pending = events(runIncusProcess({ ...request, maxOutputBytes: 3 }));
    const rejected = expect(pending).rejects.toThrow("output limit");
    child.stdout.write("overflow");
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("times out and kills an unresponsive transport", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const pending = events(runIncusProcess(request));
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const scope = { spaceId: "space-test", botId: "bot-test" };
const context: AdapterContext = {
  ...scope,
  operationId: "op-test",
  traceId: "trace-test",
  userId: "user-test",
  signal: new AbortController().signal,
};
const request = { botId: scope.botId, homePath: "/host/checkout/not-the-guest-home" };
const binding = { ...scope, instance: "disposable-test", workspacePath: "/home/agent" };
const ref: ComputerRef = {
  id: "incus:test-project:local:disposable-test",
  botId: scope.botId,
  providerRef: "incus:test-project:local:disposable-test",
  kind: "incus" as ComputerRef["kind"],
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

type Result = { stdout?: string; stderr?: string; code?: number };
type Handler = (call: IncusProcessRequest) => Result | undefined | Promise<Result | undefined>;
function fixture(options: Partial<IncusSandboxOptions> = {}, handler?: Handler) {
  const calls: IncusProcessRequest[] = [];
  let state = "Running";
  const runner = async function* (call: IncusProcessRequest): AsyncIterable<ProcessEvent> {
    calls.push(call);
    const overridden = await handler?.(call);
    const command = call.argv[3];
    let result = overridden;
    if (!result) {
      if (command === "list")
        result = {
          stdout: JSON.stringify(
            state === "Missing"
              ? []
              : [
                  {
                    name: binding.instance,
                    type: "virtual-machine",
                    status: state,
                    state: { network: null },
                  },
                ],
          ),
        };
      else if (command === "start") {
        state = "Running";
        result = {};
      } else if (command === "stop") {
        state = "Stopped";
        result = {};
      } else if (command === "delete") {
        state = "Missing";
        result = {};
      } else if (call.argv.includes("pac-computerd")) {
        const op = JSON.parse(call.input!);
        result = {
          stdout: `${JSON.stringify({
            id: op.id,
            ok: true,
            result: op.op === "screenshot" ? { png_b64: PNG, width: 1, height: 1 } : {},
          })}\n`,
        };
      } else if (call.argv.includes(INCUS_EXEC_SCRIPT)) result = { stdout: "guest output\n" };
      else if (call.argv.includes(INCUS_FILE_SCRIPT)) {
        const payload = JSON.parse(call.input!);
        result = { stdout: JSON.stringify(payload.op === "list" ? [] : {}) };
      } else throw new Error("Unexpected fake transport invocation");
    }
    if (result.stdout) yield { type: "stdout", data: result.stdout };
    if (result.stderr) yield { type: "stderr", data: result.stderr };
    yield { type: "exit", code: result.code ?? 0 };
  };
  const config: IncusSandboxOptions = {
    project: "test-project",
    instances: [binding],
    runner,
    ...options,
  };
  return {
    calls,
    config,
    provider: new IncusSandboxProvider(config),
    setState(value: string) {
      state = value;
    },
  };
}

async function events(source: AsyncIterable<ProcessEvent>): Promise<ProcessEvent[]> {
  const result: ProcessEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe("Incus Ubuntu sandbox (offline fake runners)", () => {
  it("separates persisted homeKey from product ownerBotId across attach and restart", async () => {
    const homeKey = "persisted-computer-home";
    const f = fixture({ instances: [{ ...binding, botId: homeKey, ownerBotId: scope.botId }] });
    const first = await f.provider.provision({ ...request, botId: homeKey }, context);
    expect(first.botId).toBe(homeKey);
    const restarted = new IncusSandboxProvider(f.config);
    expect(
      await restarted.provision(
        { ...request, botId: homeKey, providerRef: first.providerRef },
        context,
      ),
    ).toEqual(first);
    expect((await restarted.observe(first, context)).width).toBe(1);
    const calls = f.calls.length;
    await expect(restarted.observe(first, { ...context, botId: homeKey })).rejects.toThrow(
      "not authorized",
    );
    await expect(restarted.observe(first, { ...context, botId: "other-bot" })).rejects.toThrow(
      "not authorized",
    );
    await expect(restarted.observe(first, { ...context, spaceId: "other-space" })).rejects.toThrow(
      "not authorized",
    );
    await expect(restarted.observe({ ...first, botId: scope.botId }, context)).rejects.toThrow(
      "not authorized",
    );
    expect(f.calls).toHaveLength(calls);
  });

  it("requires an explicit owner mapping when the product bot differs from the home key", async () => {
    const f = fixture({ instances: [{ ...binding, botId: "persisted-computer-home" }] });
    await expect(
      f.provider.provision({ ...request, botId: "persisted-computer-home" }, context),
    ).rejects.toThrow("not authorized");
    expect(f.calls).toHaveLength(0);
  });

  it("keeps bot-less lifecycle calls scoped to the exact home and space", async () => {
    const homeKey = "persisted-computer-home";
    const f = fixture({ instances: [{ ...binding, botId: homeKey, ownerBotId: scope.botId }] });
    const first = await f.provider.provision({ ...request, botId: homeKey }, context);
    const maintenance = { ...context, botId: undefined };
    expect(await f.provider.isRunning(first, maintenance)).toBe(true);
    await expect(
      f.provider.isRunning(first, { ...maintenance, spaceId: "other-space" }),
    ).rejects.toThrow("not authorized");
    await expect(
      f.provider.isRunning({ ...first, botId: "other-home" }, maintenance),
    ).rejects.toThrow("not authorized");
  });

  it("attaches only the configured VM and recovers the same reference after an adapter restart", async () => {
    const f = fixture();
    const first = await f.provider.provision(request, context);
    expect(first).toEqual({ ...ref, fresh: false, started: false });
    expect(f.calls[0]!.argv).toEqual([
      "incus",
      "--project",
      "test-project",
      "list",
      binding.instance,
      "--format",
      "json",
    ]);
    const restarted = new IncusSandboxProvider(f.config);
    expect(
      await restarted.provision({ ...request, providerRef: first.providerRef }, context),
    ).toEqual(first);
    expect(await restarted.isRunning(first, context)).toBe(true);
    expect(f.calls.every((call) => !call.argv.includes("launch"))).toBe(true);
  });

  it.each(["Stopped", "Frozen"])(
    "starts an attached %s VM, including network:null status",
    async (state) => {
      const f = fixture();
      f.setState(state);
      expect(await f.provider.provision(request, context)).toMatchObject({
        started: true,
        fresh: false,
      });
      expect(f.calls[1]!.argv).toEqual([
        "incus",
        "--project",
        "test-project",
        "start",
        binding.instance,
      ]);
    },
  );

  it("does not create a replacement if the configured VM is missing", async () => {
    const f = fixture();
    f.setState("Missing");
    await expect(f.provider.provision(request, context)).rejects.toThrow("Missing");
    expect(f.calls).toHaveLength(1);
  });

  it("ignores prefix matches and rejects containers", async () => {
    const f = fixture({}, () => ({
      stdout: JSON.stringify([
        { name: `${binding.instance}-other`, type: "virtual-machine", status: "Running" },
      ]),
    }));
    expect(await f.provider.isRunning(ref, context)).toBe(false);
    const container = fixture({}, () => ({
      stdout: JSON.stringify([{ name: binding.instance, type: "container", status: "Running" }]),
    }));
    await expect(container.provider.provision(request, context)).rejects.toThrow("virtual machine");
  });

  it.each([
    { providerRef: "incus:other-project:local:disposable-test" },
    { providerRef: "incus:test-project:local:production" },
    { id: "forged" },
    { botId: "other-bot" },
    { kind: "docker" as ComputerRef["kind"] },
  ])("denies forged reference %j before running a host command", async (override) => {
    const f = fixture();
    const forged = { ...ref, ...override };
    await expect(f.provider.observe(forged, context)).rejects.toThrow("not authorized");
    await expect(
      f.provider.writeFile(forged, { path: "a", content: new Uint8Array() }, context),
    ).rejects.toThrow("not authorized");
    await expect(events(f.provider.execute(forged, { argv: ["true"] }, context))).rejects.toThrow(
      "not authorized",
    );
    await expect(f.provider.stop(forged, context)).rejects.toThrow("not authorized");
    expect(f.calls).toHaveLength(0);
  });

  it("denies cross-space/bot access and a providerRef supplied during provision", async () => {
    const f = fixture();
    await expect(f.provider.observe(ref, { ...context, spaceId: "other-space" })).rejects.toThrow(
      "not authorized",
    );
    await expect(f.provider.observe(ref, { ...context, botId: "other-bot" })).rejects.toThrow(
      "not authorized",
    );
    await expect(
      f.provider.provision({ ...request, providerRef: "production" }, context),
    ).rejects.toThrow("not authorized");
    await expect(f.provider.provision({ ...request, botId: "other-bot" }, context)).rejects.toThrow(
      "not authorized",
    );
    expect(f.calls).toHaveLength(0);
  });

  it("validates immutable deployment configuration and rejects ambiguous assignments", async () => {
    expect(() => fixture({ project: "--project=other" })).toThrow("project");
    expect(() => fixture({ instances: [{ ...binding, instance: "remote:other" }] })).toThrow(
      "instance",
    );
    expect(() => fixture({ instances: [binding, binding] })).toThrow("unique");
    expect(() => fixture({ instances: [{ ...binding, workspacePath: "/" }] })).toThrow(
      "workspacePath",
    );
    const bindings = [{ ...binding }];
    const f = fixture({ instances: bindings });
    bindings[0]!.instance = "production";
    expect(f.config.instances[0]!.instance).toBe("production");
    // Its own config snapshot remains authorized only for the original disposable VM.
    await expect(
      f.provider.provision({ ...request, providerRef: "production" }, context),
    ).rejects.toThrow("not authorized");
  });

  it("quotes one SSH command while keeping guest payloads out of argv", async () => {
    const f = fixture(
      {
        transport: {
          kind: "ssh",
          argv: ["ssh", "-i", "/fake/key", "host.test"],
          incusArgv: ["/opt/incus's/bin/incus"],
        },
        remote: "lab",
      },
      () => ({ stdout: "hello", code: 0 }),
    );
    const sshRef = {
      ...ref,
      id: "incus:test-project:lab:disposable-test",
      providerRef: "incus:test-project:lab:disposable-test",
    };
    expect(
      await events(
        f.provider.execute(sshRef, { argv: ["printf", "$(not-host-code)`test`'中文"] }, context),
      ),
    ).toContainEqual({ type: "exit", code: 0 });
    const call = f.calls[0]!;
    expect(call.argv.slice(0, -1)).toEqual([
      "ssh",
      "-T",
      "-o",
      "BatchMode=yes",
      "-i",
      "/fake/key",
      "host.test",
    ]);
    expect(call.argv.at(-1)).toContain("'/opt/incus'\"'\"'s/bin/incus'");
    expect(call.argv.at(-1)).toContain("'--project' 'test-project' 'exec' 'lab:disposable-test'");
    expect(call.argv.join(" ")).not.toContain("$(not-host-code)");
    expect(JSON.parse(call.input!).argv[1]).toBe("$(not-host-code)`test`'中文");
  });

  it("executes as the guest user, keeps stdout/stderr/exit honest, and passes cwd/env/unset/timeout", async () => {
    const f = fixture({}, () => ({
      stdout: "partial\n",
      stderr: "command timed out\n",
      code: 124,
    }));
    const result = await events(
      f.provider.execute(
        ref,
        {
          argv: ["sh", "-c", "echo hello"],
          cwd: "/home/agent/Desktop",
          env: { TOKEN: "fake", KEEP: "1" },
          unsetEnv: ["TOKEN"],
          timeoutMs: 123,
        },
        context,
      ),
    );
    expect(result).toEqual([
      { type: "stdout", data: "partial\n" },
      { type: "stderr", data: "command timed out\n" },
      { type: "exit", code: 124 },
    ]);
    const call = f.calls[0]!;
    expect(call.argv.slice(0, -1)).toEqual([
      "incus",
      "--project",
      "test-project",
      "exec",
      binding.instance,
      "--mode",
      "non-interactive",
      "--",
      "runuser",
      "-u",
      "agent",
      "--",
      "env",
      "DISPLAY=:1",
      "python3",
      "-u",
      "-c",
    ]);
    expect(call.keepStdinOpen).toBe(true);
    expect(call.timeoutMs).toBe(10_123);
    expect(JSON.parse(call.input!)).toEqual({
      argv: ["sh", "-c", "echo hello"],
      root: "/home/agent",
      cwd: "Desktop",
      env: { TOKEN: "fake", KEEP: "1" },
      unsetEnv: ["TOKEN"],
      timeoutMs: 123,
    });
    expect(call.argv.join(" ")).not.toContain(request.homePath);
    expect(call.signal).toBe(context.signal);
  });

  it("streams a partial command result before exit and closes the injected transport on early return", async () => {
    const release = gate();
    let closed = false;
    const f = fixture({
      runner: async function* () {
        try {
          yield { type: "stdout", data: "first" };
          await release.promise;
          yield { type: "exit", code: 0 };
        } finally {
          closed = true;
        }
      },
    });
    const stream = f.provider.execute(ref, { argv: ["slow"] }, context)[Symbol.asyncIterator]();
    expect(await stream.next()).toEqual({ done: false, value: { type: "stdout", data: "first" } });
    await stream.return?.();
    expect(closed).toBe(true);
    release.release();
  });

  it("rejects missing exit status and oversized output instead of reporting success", async () => {
    const missing = fixture({
      runner: async function* () {
        yield { type: "stdout", data: "partial" };
      },
    });
    await expect(
      events(missing.provider.execute(ref, { argv: ["true"] }, context)),
    ).rejects.toThrow("without exit");
    const oversized = fixture({ maxOutputBytes: 3 }, () => ({ stdout: "four" }));
    await expect(
      events(oversized.provider.execute(ref, { argv: ["true"] }, context)),
    ).rejects.toThrow("output limit");
  });

  it("checks prepare against the real guest protocol and returns PNG bytes/dimensions", async () => {
    const f = fixture();
    await f.provider.prepare(ref, context);
    expect(f.calls).toHaveLength(2);
    expect(JSON.parse(f.calls[0]!.input!)).toMatchObject({ op: "prepare", root: "/home/agent" });
    const observation = await f.provider.observe(ref, context);
    expect(observation).toMatchObject({ width: 1, height: 1, mimeType: "image/png" });
    expect(Buffer.from(observation.image).toString("base64")).toBe(PNG);
    expect(observation.frameId).toMatch(/^[a-f0-9]{64}$/);
    expect((await f.provider.connectScreen(ref, { view: "snapshot" }, context)).url).toBe(
      `data:image/png;base64,${PNG}`,
    );
  });

  it("maps GUI actions and reports completed source actions, including Unicode paste and post-action screenshot", async () => {
    const f = fixture();
    const result = await f.provider.act(
      ref,
      {
        actions: [
          { kind: "pointer", type: "down", x: 10, y: 20 },
          { kind: "pointer", type: "up", x: 30, y: 40 },
          { kind: "pointer", type: "click", x: 50, y: 60, button: "right" },
          { kind: "key", key: "Enter", modifiers: ["ctrl"] },
          { kind: "clipboard", text: "明天下午三点开会" },
          { kind: "scroll", direction: "up", amount: 4 },
          { kind: "wait", ms: 200 },
        ],
        settleMs: 100,
      },
      context,
    );
    expect(result.completed).toBe(7);
    expect(result.observation?.image).toEqual(Buffer.from(PNG, "base64"));
    expect(f.calls.map((c) => JSON.parse(c.input!))).toEqual([
      { id: 1, op: "move", x: 10, y: 20 },
      { id: 1, op: "mouse_down", button: "left" },
      { id: 1, op: "move", x: 30, y: 40 },
      { id: 1, op: "mouse_up", button: "left" },
      { id: 1, op: "click", x: 50, y: 60, button: "right" },
      { id: 1, op: "key", keys: ["ctrl", "Return"] },
      { id: 1, op: "type", text: "明天下午三点开会" },
      { id: 1, op: "scroll", dy: -4 },
      { id: 1, op: "wait", seconds: 0.2 },
      { id: 1, op: "wait", seconds: 0.1 },
      { id: 1, op: "screenshot" },
    ]);
  });

  it("fails the GUI batch at the first daemon error without sending later actions", async () => {
    const f = fixture({}, () => ({
      stdout: JSON.stringify({ id: 1, ok: false, error: "fake guest failure" }),
    }));
    await expect(
      f.provider.act(
        ref,
        {
          actions: [
            { kind: "clipboard", text: "first" },
            { kind: "clipboard", text: "never" },
          ],
        },
        context,
      ),
    ).rejects.toThrow("operation failed");
    expect(f.calls).toHaveLength(1);
  });

  it.each([
    { id: 2, ok: true, result: {} },
    { id: 1, ok: true, result: { png_b64: "bad!", width: 1, height: 1 } },
    { id: 1, ok: true, result: { png_b64: PNG, width: 800, height: 600 } },
  ])("rejects corrupt or mismatched screenshot replies %j", async (reply) => {
    const f = fixture({}, () => ({ stdout: JSON.stringify(reply) }));
    await expect(f.provider.observe(ref, context)).rejects.toThrow();
  });

  it("serializes complete GUI batches across native child calls", async () => {
    const entered = gate();
    const release = gate();
    const f = fixture({}, async (call) => {
      const payload = JSON.parse(call.input!);
      if (payload.text === "A1") {
        entered.release();
        await release.promise;
      }
      return { stdout: JSON.stringify({ id: 1, ok: true, result: {} }) };
    });
    const first = f.provider.act(
      ref,
      {
        actions: [
          { kind: "clipboard", text: "A1" },
          { kind: "clipboard", text: "A2" },
        ],
        observe: false,
      },
      context,
    );
    await entered.promise;
    const second = f.provider.act(
      ref,
      { actions: [{ kind: "clipboard", text: "B1" }], observe: false },
      context,
    );
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
    release.release();
    await Promise.all([first, second]);
    expect(f.calls.map((c) => JSON.parse(c.input!).text)).toEqual(["A1", "A2", "B1"]);
  });

  it("aborts a queued child promptly without unlocking the active child or sending its input", async () => {
    const entered = gate();
    const release = gate();
    const f = fixture({}, async (call) => {
      if (JSON.parse(call.input!).text === "active") {
        entered.release();
        await release.promise;
      }
      return { stdout: JSON.stringify({ id: 1, ok: true, result: {} }) };
    });
    const active = f.provider.act(
      ref,
      { actions: [{ kind: "clipboard", text: "active" }], observe: false },
      context,
    );
    await entered.promise;
    const controller = new AbortController();
    const cancelled = f.provider.act(
      ref,
      { actions: [{ kind: "clipboard", text: "cancelled" }], observe: false },
      { ...context, signal: controller.signal },
    );
    controller.abort(new Error("test cancellation"));
    await expect(cancelled).rejects.toThrow("test cancellation");
    const after = f.provider.act(
      ref,
      { actions: [{ kind: "clipboard", text: "after" }], observe: false },
      context,
    );
    await Promise.resolve();
    expect(f.calls).toHaveLength(1);
    release.release();
    await Promise.all([active, after]);
    expect(f.calls.map((c) => JSON.parse(c.input!).text)).toEqual(["active", "after"]);
  });

  it("carries binary files through JSON/base64 and enforces read limits", async () => {
    const content = Buffer.from([0, 255, 13, 10, 128]);
    const f = fixture({}, (call) => {
      const payload = JSON.parse(call.input!);
      return {
        stdout: JSON.stringify(payload.op === "read" ? { base64: content.toString("base64") } : {}),
      };
    });
    await f.provider.writeFile(
      ref,
      { path: "Desktop/测试 '$(no)'.bin", content, executable: true },
      context,
    );
    expect(JSON.parse(f.calls[0]!.input!)).toMatchObject({
      op: "write",
      path: "Desktop/测试 '$(no)'.bin",
      executable: true,
      base64: content.toString("base64"),
    });
    expect(await f.provider.readFile(ref, "Desktop/a.bin", context, { maxBytes: 5 })).toEqual(
      content,
    );
    await expect(
      f.provider.readFile(ref, "Desktop/a.bin", context, { maxBytes: 4 }),
    ).rejects.toThrow("maxBytes");
    expect(f.calls.every((c) => c.argv.includes(INCUS_FILE_SCRIPT))).toBe(true);
    expect(f.calls.every((c) => !c.argv.join(" ").includes("$(no)"))).toBe(true);
  });

  it.each(["../escape", "/etc/passwd", "a/../../escape", "a/./b", "a\\b", "nul\0file"])(
    "rejects path %j before transport",
    async (filePath) => {
      const f = fixture();
      await expect(f.provider.readFile(ref, filePath, context)).rejects.toThrow();
      await expect(
        f.provider.writeFile(ref, { path: filePath, content: new Uint8Array() }, context),
      ).rejects.toThrow();
      await expect(
        events(f.provider.execute(ref, { argv: ["true"], cwd: filePath }, context)),
      ).rejects.toThrow();
      expect(f.calls).toHaveLength(0);
    },
  );

  it("rejects malicious file listings and oversized write payloads", async () => {
    const f = fixture({ maxFileBytes: 2 }, () => ({
      stdout: JSON.stringify([{ path: "../secret", kind: "file", size: 1 }]),
    }));
    await expect(f.provider.listFiles(ref, "", context)).rejects.toThrow();
    await expect(
      f.provider.writeFile(ref, { path: "a", content: Buffer.from("big") }, context),
    ).rejects.toThrow("maxBytes");
    expect(f.calls).toHaveLength(1);
  });

  it("exports and imports bounded workspace-relative files", async () => {
    const f = fixture({}, (call) => {
      const payload = JSON.parse(call.input!);
      if (payload.op === "list")
        return {
          stdout: JSON.stringify(
            payload.path === ""
              ? [{ path: "notes", kind: "dir", size: 0 }]
              : [{ path: "notes/a.txt", kind: "file", size: 2, executable: false }],
          ),
        };
      return { stdout: JSON.stringify(payload.op === "read" ? { base64: "aGk=" } : {}) };
    });
    const exported: PortableFile[] = [];
    for await (const file of f.provider.exportWorkspace(ref, context)) exported.push(file);
    expect(exported).toEqual([
      { path: "notes/a.txt", content: Buffer.from("hi"), executable: false },
    ]);
    await f.provider.importWorkspace(
      ref,
      (async function* () {
        yield exported[0]!;
      })(),
      context,
    );
    expect(JSON.parse(f.calls.at(-1)!.input!)).toMatchObject({
      op: "write",
      path: "notes/a.txt",
      base64: "aGk=",
    });
  });

  it("does not destroy unowned attached instances, even after restart; owned cleanup is idempotent", async () => {
    const f = fixture();
    await expect(new IncusSandboxProvider(f.config).destroy(ref, context)).rejects.toThrow(
      "unowned",
    );
    expect(f.calls).toHaveLength(0);
    const owned = fixture({ instances: [{ ...binding, owned: true }] });
    await owned.provider.destroy(ref, context);
    await owned.provider.destroy(ref, context);
    expect(owned.calls.filter((c) => c.argv.includes("delete"))).toHaveLength(1);
    expect(owned.calls.find((c) => c.argv.includes("delete"))!.argv).toEqual([
      "incus",
      "--project",
      "test-project",
      "delete",
      "--force",
      binding.instance,
    ]);
  });

  it("stops gently and reports failure without silently forcing an attached VM", async () => {
    const f = fixture({}, (call) =>
      call.argv.includes("stop") ? { stderr: "private diagnostic", code: 1 } : undefined,
    );
    await expect(f.provider.stop(ref, context)).rejects.toThrow("Incus stop failed (exit 1)");
    expect(f.calls.some((c) => c.argv.includes("--force"))).toBe(false);
  });

  it("declares unsupported capabilities and rejects an unsupported batch before any input", async () => {
    const f = fixture();
    expect(f.provider.describe().capabilities).toEqual({
      graphical: true,
      pty: false,
      snapshots: false,
      takeover: false,
      persistentHome: true,
      multiScreen: false,
    });
    await expect(
      f.provider.act(
        ref,
        {
          actions: [
            { kind: "clipboard", text: "must not type" },
            { kind: "focus", application: "browser" },
          ],
        },
        context,
      ),
    ).rejects.toThrow("does not support");
    await expect(f.provider.snapshot(ref, context)).rejects.toThrow("does not support");
    await expect(f.provider.connectScreen(ref, { view: "stream" }, context)).rejects.toThrow(
      "does not support",
    );
    await expect(
      f.provider.sendInput(
        ref,
        { kind: "key", key: "a" },
        { holder: "user", leaseId: "test", fence: 1 },
        context,
      ),
    ).rejects.toThrow("does not support");
    await expect(
      events(f.provider.execute(ref, { argv: ["sh"], pty: true }, context)),
    ).rejects.toThrow("PTY");
    expect(f.calls).toHaveLength(0);
  });
});
