import { createHash } from "node:crypto";
import path from "node:path";
import type {
  AdapterContext,
  CommandRequest,
  ComputerAction,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerFileEntry,
  ComputerInput,
  ComputerObservation,
  ComputerRef,
  ControlLeaseRef,
  PortableFile,
  ProcessEvent,
  SandboxProvider,
  ScreenRequest,
  ScreenSession,
  SnapshotRef,
} from "@rakazo/adapter-kit";
import { INCUS_EXEC_SCRIPT, INCUS_FILE_SCRIPT } from "./incus-sandbox-guest.js";
import type { IncusProcessRequest, IncusProcessRunner } from "./incus-sandbox-process.js";
import { runIncusProcess } from "./incus-sandbox-process.js";

export type { IncusProcessRequest, IncusProcessRunner } from "./incus-sandbox-process.js";

export type IncusTransport =
  | { kind: "local"; argv?: readonly string[] }
  | {
      kind: "ssh";
      /** e.g. ["ssh", "-i", "/path/to/key", "vm-host"], with destination last. */
      argv: readonly string[];
      incusArgv?: readonly string[];
    };

/** Trusted deployment configuration, never derived from a model's providerRef. */
export interface IncusInstanceBinding {
  instance: string;
  spaceId: string;
  /** The computer's persisted home key; this MVP allocates one desktop per bot. */
  botId: string;
  /** Product bot allowed to use the desktop. Defaults to botId for current dedicated homes. */
  ownerBotId?: string;
  workspacePath?: string;
  /** External acceptance provisioning can explicitly hand over deletion ownership. */
  owned?: boolean;
}

export interface IncusSandboxOptions {
  project: string;
  instances: readonly IncusInstanceBinding[];
  transport?: IncusTransport;
  /** Optional configured Incus remote. It cannot be overridden by a reference. */
  remote?: string;
  guestUser?: string;
  display?: string;
  computerdArgv?: readonly string[];
  commandTimeoutMs?: number;
  operationTimeoutMs?: number;
  maxFileBytes?: number;
  maxOutputBytes?: number;
  runner?: IncusProcessRunner;
}

type Binding = IncusInstanceBinding & {
  ownerBotId: string;
  workspacePath: string;
  providerRef: string;
};
type Rpc = { op: string; [key: string]: unknown };
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Attach-only Ubuntu provider. The worker must share one instance of this adapter:
 * its per-computer queue serializes GUI batches, shell commands and lifecycle operations.
 * Multiple worker processes still require the product's distributed computer lease.
 * No VM creation, credentials, inbound ports, package installation, or model loop lives here.
 */
export class IncusSandboxProvider implements SandboxProvider {
  private readonly project: string;
  private readonly remote: string;
  private readonly transport: IncusTransport;
  private readonly bindings: Binding[];
  private readonly runner: IncusProcessRunner;
  private readonly guestUser: string;
  private readonly display: string;
  private readonly computerdArgv: string[];
  private readonly commandTimeoutMs: number;
  private readonly operationTimeoutMs: number;
  private readonly maxFileBytes: number;
  private readonly maxOutputBytes: number;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(options: IncusSandboxOptions) {
    this.project = identifier(options.project, "project");
    this.remote = options.remote ? identifier(options.remote, "remote") : "";
    const transport = options.transport ?? { kind: "local" as const };
    this.transport =
      transport.kind === "ssh"
        ? {
            ...transport,
            argv: argv(transport.argv),
            incusArgv: argv(transport.incusArgv ?? ["incus"]),
          }
        : { kind: "local", argv: argv(transport.argv ?? ["incus"]) };
    this.guestUser = identifier(options.guestUser ?? "agent", "guest user");
    this.display = options.display ?? ":1";
    if (!/^:\d+(\.\d+)?$/.test(this.display)) throw new Error("Invalid Incus guest display");
    this.computerdArgv = argv(options.computerdArgv ?? ["pac-computerd"]);
    this.commandTimeoutMs = bounded(
      options.commandTimeoutMs ?? 300_000,
      3_600_000,
      "command timeout",
    );
    this.operationTimeoutMs = bounded(
      options.operationTimeoutMs ?? 60_000,
      600_000,
      "operation timeout",
    );
    this.maxFileBytes = bounded(
      options.maxFileBytes ?? 8 * 1024 * 1024,
      64 * 1024 * 1024,
      "file limit",
    );
    this.maxOutputBytes = bounded(
      options.maxOutputBytes ?? 16 * 1024 * 1024,
      128 * 1024 * 1024,
      "output limit",
    );
    this.runner = options.runner ?? runIncusProcess;
    if (!options.instances.length) throw new Error("Incus requires an explicit instance allowlist");
    this.bindings = options.instances.map((binding) => {
      const instance = identifier(binding.instance, "instance");
      if (!binding.spaceId || !binding.botId)
        throw new Error("Incus binding requires spaceId and botId");
      const ownerBotId = binding.ownerBotId ?? binding.botId;
      if (!ownerBotId) throw new Error("Incus binding requires a non-empty ownerBotId");
      const workspacePath = binding.workspacePath ?? `/home/${this.guestUser}`;
      if (
        !path.posix.isAbsolute(workspacePath) ||
        workspacePath === "/" ||
        workspacePath.includes("\0") ||
        path.posix.normalize(workspacePath) !== workspacePath
      ) {
        throw new Error("Incus workspacePath must be a canonical absolute guest directory");
      }
      return {
        ...binding,
        instance,
        ownerBotId,
        workspacePath,
        providerRef: `incus:${this.project}:${this.remote || "local"}:${instance}`,
      };
    });
    if (
      new Set(this.bindings.map((b) => b.instance)).size !== this.bindings.length ||
      new Set(this.bindings.map((b) => JSON.stringify([b.spaceId, b.botId]))).size !==
        this.bindings.length
    ) {
      throw new Error("Incus requires unique instance and space/bot bindings");
    }
  }

  describe() {
    return {
      id: "incus",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: {
        graphical: true,
        pty: false,
        snapshots: false,
        takeover: false,
        persistentHome: true,
        multiScreen: false,
      },
    };
  }

  async provision(
    request: Parameters<SandboxProvider["provision"]>[0],
    context: AdapterContext,
  ): Promise<ComputerRef> {
    context.signal.throwIfAborted();
    if (request.providerKind && String(request.providerKind) !== "incus")
      throw new Error("Incorrect Incus provider kind");
    const binding = this.bindings.find(
      (b) => b.botId === request.botId && b.spaceId === context.spaceId,
    );
    if (
      !binding ||
      (context.botId !== undefined && context.botId !== binding.ownerBotId) ||
      (request.providerRef !== undefined && request.providerRef !== binding.providerRef)
    ) {
      throw new Error("Incus instance is not authorized for this space and bot");
    }
    // homePath is a host-side checkout; it must never become a guest path or Incus target.
    return this.exclusive(binding, context, async () => {
      const state = await this.state(binding, context);
      let started = false;
      if (state === "Stopped" || state === "Frozen") {
        await this.checked(["start", this.target(binding)], context);
        started = true;
      } else if (state !== "Running") {
        throw new Error(`Configured Incus VM is not attachable (${state})`);
      }
      return {
        id: binding.providerRef,
        providerRef: binding.providerRef,
        botId: binding.botId,
        kind: "incus",
        fresh: false,
        started,
      };
    });
  }

  async isRunning(computer: ComputerRef, context: AdapterContext): Promise<boolean> {
    return (await this.state(this.authorize(computer, context), context)) === "Running";
  }

  async prepare(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const binding = this.authorize(computer, context);
    await this.exclusive(binding, context, async () => {
      // Probes only. The disposable VM's image/provisioner installs and starts the desktop.
      await this.files(binding, { op: "prepare", path: "" }, context);
      await this.screenshot(binding, context);
    });
  }

  async *execute(
    computer: ComputerRef,
    request: CommandRequest,
    context: AdapterContext,
  ): AsyncIterable<ProcessEvent> {
    const binding = this.authorize(computer, context);
    if (request.pty) throw unsupported("PTY");
    const command = argv(request.argv);
    const cwd = this.relative(binding, request.cwd ?? "");
    const timeoutMs = bounded(
      request.timeoutMs ?? this.commandTimeoutMs,
      3_600_000,
      "command timeout",
    );
    for (const key of [...Object.keys(request.env ?? {}), ...(request.unsetEnv ?? [])]) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error("Invalid guest environment name");
    }
    for (const value of Object.values(request.env ?? {})) {
      if (typeof value !== "string" || value.includes("\0"))
        throw new Error("Invalid guest environment value");
    }
    const release = await this.acquire(binding, context);
    try {
      yield* this.stream({
        argv: this.guestArgv(binding, ["python3", "-u", "-c", INCUS_EXEC_SCRIPT]),
        input: `${JSON.stringify({
          argv: command,
          root: binding.workspacePath,
          cwd,
          env: request.env ?? {},
          unsetEnv: request.unsetEnv ?? [],
          timeoutMs,
        })}\n`,
        keepStdinOpen: true,
        timeoutMs: timeoutMs + 10_000,
        maxOutputBytes: this.maxOutputBytes,
        signal: context.signal,
      });
    } finally {
      release();
    }
  }

  async connectScreen(
    computer: ComputerRef,
    request: ScreenRequest,
    context: AdapterContext,
  ): Promise<ScreenSession> {
    this.authorize(computer, context);
    if (request.interactive || request.view !== "snapshot")
      throw unsupported("interactive or streaming screen");
    const observation = await this.observe(computer, context);
    return {
      url: `data:image/png;base64,${Buffer.from(observation.image).toString("base64")}`,
      mimeType: "image/png",
      close: async () => undefined,
    };
  }

  async sendInput(
    computer: ComputerRef,
    _input: ComputerInput,
    _lease: ControlLeaseRef,
    context: AdapterContext,
  ): Promise<void> {
    this.authorize(computer, context);
    throw unsupported("human takeover (no control-lease gateway configured)");
  }

  async observe(computer: ComputerRef, context: AdapterContext): Promise<ComputerObservation> {
    const binding = this.authorize(computer, context);
    return this.exclusive(binding, context, () => this.screenshot(binding, context));
  }

  async act(
    computer: ComputerRef,
    request: ComputerActionRequest,
    context: AdapterContext,
  ): Promise<ComputerActionResult> {
    const binding = this.authorize(computer, context);
    if (request.actions.length > 24) throw new Error("computer action batch exceeds 24 actions");
    // Translate/validate the whole batch before any action so unsupported input has no side effects.
    const operations = request.actions.map((action) => this.action(action, binding));
    const settleMs = request.settleMs ?? 0;
    if (!Number.isFinite(settleMs) || settleMs < 0 || settleMs > 10_000)
      throw new Error("Invalid GUI settle delay");
    return this.exclusive(binding, context, async () => {
      for (const batch of operations)
        for (const operation of batch) await this.rpc(binding, operation, context);
      if (settleMs) await this.rpc(binding, { op: "wait", seconds: settleMs / 1000 }, context);
      return {
        completed: request.actions.length,
        ...(request.observe === false
          ? {}
          : { observation: await this.screenshot(binding, context) }),
      };
    });
  }

  async listFiles(
    computer: ComputerRef,
    directory: string,
    context: AdapterContext,
  ): Promise<ComputerFileEntry[]> {
    const binding = this.authorize(computer, context);
    const relative = this.relative(binding, directory);
    return this.exclusive(binding, context, async () => {
      const result = await this.files(binding, { op: "list", path: relative }, context);
      if (!Array.isArray(result) || result.length > 10_000)
        throw new Error("Invalid Incus file listing");
      return result.map((item) => {
        if (
          !record(item) ||
          typeof item.path !== "string" ||
          this.relative(binding, item.path) !== item.path ||
          path.posix.dirname(item.path) !== (relative || ".") ||
          (item.kind !== "file" && item.kind !== "dir") ||
          typeof item.size !== "number" ||
          !Number.isSafeInteger(item.size) ||
          item.size < 0
        )
          throw new Error("Invalid Incus file entry");
        return {
          path: item.path,
          kind: item.kind,
          size: item.size,
          executable: item.executable === true,
        };
      });
    });
  }

  async readFile(
    computer: ComputerRef,
    filePath: string,
    context: AdapterContext,
    options?: { maxBytes?: number },
  ): Promise<Uint8Array> {
    const binding = this.authorize(computer, context);
    const relative = this.relative(binding, filePath, true);
    const maxBytes =
      options?.maxBytes === undefined
        ? this.maxFileBytes
        : Math.min(nonnegativeInteger(options.maxBytes, "maxBytes"), this.maxFileBytes);
    return this.exclusive(binding, context, async () => {
      const result = await this.files(binding, { op: "read", path: relative, maxBytes }, context);
      if (!record(result)) throw new Error("Invalid Incus file response");
      return decodeBase64(result.base64, maxBytes);
    });
  }

  async writeFile(
    computer: ComputerRef,
    file: PortableFile,
    context: AdapterContext,
  ): Promise<void> {
    const binding = this.authorize(computer, context);
    const relative = this.relative(binding, file.path, true);
    if (file.content.byteLength > this.maxFileBytes) throw new Error("file exceeds maxBytes");
    await this.exclusive(binding, context, async () => {
      await this.files(
        binding,
        {
          op: "write",
          path: relative,
          base64: Buffer.from(file.content).toString("base64"),
          executable: file.executable === true,
          maxBytes: this.maxFileBytes,
        },
        context,
      );
    });
  }

  async *exportWorkspace(
    computer: ComputerRef,
    context: AdapterContext,
  ): AsyncIterable<PortableFile> {
    this.authorize(computer, context);
    const directories = [""];
    let count = 0;
    let bytes = 0;
    while (directories.length) {
      const directory = directories.shift()!;
      for (const entry of await this.listFiles(computer, directory, context)) {
        if (++count > 10_000) throw new Error("Incus workspace export entry limit exceeded");
        if (entry.kind === "dir") directories.push(entry.path);
        else {
          const content = await this.readFile(computer, entry.path, context);
          bytes += content.byteLength;
          if (bytes > 64 * 1024 * 1024)
            throw new Error("Incus workspace export byte limit exceeded");
          yield { path: entry.path, content, executable: entry.executable };
        }
      }
    }
  }

  async importWorkspace(
    computer: ComputerRef,
    files: AsyncIterable<PortableFile>,
    context: AdapterContext,
  ): Promise<void> {
    this.authorize(computer, context);
    for await (const file of files) await this.writeFile(computer, file, context);
  }

  async snapshot(computer: ComputerRef, context: AdapterContext): Promise<SnapshotRef> {
    this.authorize(computer, context);
    throw unsupported("snapshots");
  }

  async stop(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const binding = this.authorize(computer, context);
    await this.exclusive(binding, context, async () => {
      const state = await this.state(binding, context);
      if (state === "Stopped" || state === "Missing") return;
      if (state === "Frozen") await this.checked(["start", this.target(binding)], context);
      else if (state !== "Running") throw new Error(`Cannot stop Incus VM in state ${state}`);
      // No forced fallback for an attached VM. Failure is reported to the lifecycle owner.
      await this.checked(["stop", this.target(binding), "--timeout", "30"], context);
    });
  }

  async destroy(computer: ComputerRef, context: AdapterContext): Promise<void> {
    const binding = this.authorize(computer, context);
    if (!binding.owned) throw new Error("Refusing to destroy an attached, unowned Incus instance");
    await this.exclusive(binding, context, async () => {
      if ((await this.state(binding, context)) !== "Missing") {
        await this.checked(["delete", "--force", this.target(binding)], context);
      }
    });
  }

  private authorize(computer: ComputerRef, context: AdapterContext): Binding {
    context.signal.throwIfAborted();
    const binding = this.bindings.find((b) => b.providerRef === computer.providerRef);
    if (
      !binding ||
      String(computer.kind) !== "incus" ||
      computer.id !== binding.providerRef ||
      computer.botId !== binding.botId ||
      context.spaceId !== binding.spaceId ||
      (context.botId !== undefined && context.botId !== binding.ownerBotId)
    ) {
      throw new Error("Incus instance is not authorized for this space and bot");
    }
    return binding;
  }

  private relative(binding: Binding, value: string, file = false): string {
    if (value.includes("\0") || value.includes("\\"))
      throw new Error("Invalid Incus workspace path");
    let relative = value === "." ? "" : value;
    if (path.posix.isAbsolute(relative)) {
      if (relative === binding.workspacePath) relative = "";
      else if (relative.startsWith(`${binding.workspacePath}/`))
        relative = relative.slice(binding.workspacePath.length + 1);
      else throw new Error("Path escapes the computer workspace");
    }
    if (relative.split("/").some((part) => part === "." || part === ".."))
      throw new Error("Path escapes the computer workspace");
    relative = relative.split("/").filter(Boolean).join("/");
    if (file && !relative) throw new Error("File path is required");
    return relative;
  }

  private target(binding: Binding): string {
    return `${this.remote ? `${this.remote}:` : ""}${binding.instance}`;
  }

  private hostArgv(args: string[]): string[] {
    const suffix = ["--project", this.project, ...args];
    if (this.transport.kind === "local") return [...this.transport.argv!, ...suffix];
    const [ssh, ...sshArgs] = this.transport.argv;
    return [
      ssh!,
      "-T",
      "-o",
      "BatchMode=yes",
      ...sshArgs,
      [...this.transport.incusArgv!, ...suffix].map(shellQuote).join(" "),
    ];
  }

  private guestArgv(binding: Binding, command: string[]): string[] {
    return this.hostArgv([
      "exec",
      this.target(binding),
      "--mode",
      "non-interactive",
      "--",
      "runuser",
      "-u",
      this.guestUser,
      "--",
      "env",
      `DISPLAY=${this.display}`,
      ...command,
    ]);
  }

  private async collect(
    request: IncusProcessRequest,
  ): Promise<{ stdout: string; stderr: string; code: number }> {
    let stdout = "";
    let stderr = "";
    let code = 0;
    for await (const event of this.stream(request)) {
      if (event.type === "exit") code = event.code;
      else if (event.type === "stdout") stdout += event.data;
      else stderr += event.data;
    }
    return { stdout, stderr, code };
  }

  private async *stream(request: IncusProcessRequest): AsyncIterable<ProcessEvent> {
    let code: number | undefined;
    let bytes = 0;
    for await (const event of this.runner(request)) {
      request.signal.throwIfAborted();
      if (code !== undefined) throw new Error("Incus transport emitted data after exit");
      if (event.type === "exit") code = event.code;
      else {
        bytes += Buffer.byteLength(event.data);
        if (bytes > request.maxOutputBytes)
          throw new Error("Incus transport output limit exceeded");
      }
      yield event;
    }
    if (code === undefined) throw new Error("Incus transport ended without exit status");
    if (!Number.isInteger(code)) throw new Error("Incus transport returned an invalid exit status");
  }

  private async checked(args: string[], context: AdapterContext): Promise<string> {
    const result = await this.collect({
      argv: this.hostArgv(args),
      timeoutMs: this.operationTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: context.signal,
    });
    // Do not include argv or raw diagnostics: these may contain payloads or guest secrets.
    if (result.code !== 0) throw new Error(`Incus ${args[0]} failed (exit ${result.code})`);
    return result.stdout;
  }

  private async state(binding: Binding, context: AdapterContext): Promise<string> {
    const output = await this.checked(
      ["list", ...(this.remote ? [`${this.remote}:`] : []), binding.instance, "--format", "json"],
      context,
    );
    const instances: unknown = JSON.parse(output);
    if (!Array.isArray(instances)) throw new Error("Invalid Incus instance listing");
    const instance = instances.find((item) => record(item) && item.name === binding.instance);
    if (!instance) return "Missing";
    if (
      !record(instance) ||
      instance.type !== "virtual-machine" ||
      typeof instance.status !== "string"
    ) {
      throw new Error("Configured Incus instance must be a virtual machine");
    }
    return instance.status;
  }

  private async files(
    binding: Binding,
    payload: Record<string, unknown>,
    context: AdapterContext,
  ): Promise<unknown> {
    const result = await this.collect({
      argv: this.guestArgv(binding, ["python3", "-c", INCUS_FILE_SCRIPT]),
      input: JSON.stringify({ ...payload, root: binding.workspacePath }),
      timeoutMs: this.operationTimeoutMs,
      maxOutputBytes: Math.max(this.maxOutputBytes, Math.ceil((this.maxFileBytes * 4) / 3) + 1024),
      signal: context.signal,
    });
    if (result.code !== 0)
      throw new Error(`Incus workspace ${payload.op} failed (exit ${result.code})`);
    return JSON.parse(result.stdout);
  }

  private async rpc(
    binding: Binding,
    operation: Rpc,
    context: AdapterContext,
  ): Promise<Record<string, unknown>> {
    const result = await this.collect({
      argv: this.guestArgv(binding, this.computerdArgv),
      input: `${JSON.stringify({ ...operation, id: 1 })}\n`,
      timeoutMs: this.operationTimeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      signal: context.signal,
    });
    if (result.code !== 0) throw new Error(`pac-computerd transport failed (exit ${result.code})`);
    const lines = result.stdout.trim().split("\n");
    if (lines.length !== 1) throw new Error("Invalid pac-computerd response framing");
    const response: unknown = JSON.parse(lines[0]!);
    if (
      !record(response) ||
      response.id !== 1 ||
      response.ok !== true ||
      !record(response.result)
    ) {
      throw new Error("pac-computerd operation failed or returned an invalid response");
    }
    if (operation.op === "run" && response.result.code !== 0)
      throw new Error("pac-computerd guest action failed");
    return response.result;
  }

  private async screenshot(
    binding: Binding,
    context: AdapterContext,
  ): Promise<ComputerObservation> {
    const result = await this.rpc(binding, { op: "screenshot" }, context);
    const image = decodeBase64(result.png_b64, this.maxOutputBytes);
    if (
      image.length < 24 ||
      !image.subarray(0, 8).equals(PNG_SIGNATURE) ||
      image.toString("ascii", 12, 16) !== "IHDR"
    )
      throw new Error("Invalid pac-computerd PNG");
    const width = image.readUInt32BE(16);
    const height = image.readUInt32BE(20);
    if (!width || !height || width !== result.width || height !== result.height)
      throw new Error("Invalid pac-computerd screenshot dimensions");
    return {
      image,
      width,
      height,
      mimeType: "image/png",
      capturedAt: new Date().toISOString(),
      frameId: createHash("sha256").update(image).digest("hex"),
    };
  }

  private action(action: ComputerAction, binding: Binding): Rpc[] {
    switch (action.kind) {
      case "key": {
        const keys = [...(action.modifiers ?? []), ...action.key.split("+")].map((key) => {
          const aliases: Record<string, string> = {
            enter: "Return",
            backspace: "BackSpace",
            esc: "Escape",
            escape: "Escape",
            arrowleft: "Left",
            arrowright: "Right",
            arrowup: "Up",
            arrowdown: "Down",
            " ": "space",
          };
          return aliases[key.toLowerCase()] ?? key;
        });
        if (!keys.length || keys.some((key) => !/^[A-Za-z0-9_]+$/.test(key)))
          throw new Error("Invalid desktop key");
        return [{ op: "key", keys }];
      }
      case "clipboard": {
        if (typeof action.text !== "string" || Buffer.byteLength(action.text) > this.maxFileBytes)
          throw new Error("Invalid or oversized desktop text");
        return [{ op: "type", text: action.text }];
      }
      case "pointer": {
        const x = nonnegativeInteger(action.x, "pointer x");
        const y = nonnegativeInteger(action.y, "pointer y");
        const button = action.button ?? "left";
        if (button !== "left" && button !== "right") throw new Error("Invalid pointer button");
        if (action.type === "move") return [{ op: "move", x, y }];
        if (action.type === "click") return [{ op: "click", x, y, button }];
        if (action.type === "down" || action.type === "up")
          return [
            { op: "move", x, y },
            { op: action.type === "down" ? "mouse_down" : "mouse_up", button },
          ];
        throw new Error("Invalid pointer operation");
      }
      case "scroll": {
        if (action.direction !== "up" && action.direction !== "down")
          throw new Error("Invalid scroll direction");
        const amount = bounded(action.amount ?? 3, 100, "scroll amount");
        return [{ op: "scroll", dy: action.direction === "up" ? -amount : amount }];
      }
      case "wait":
        return [
          { op: "wait", seconds: Math.min(nonnegativeInteger(action.ms, "wait"), 10_000) / 1000 },
        ];
      case "open": {
        const relative = this.relative(binding, action.path);
        return [
          {
            op: "run",
            argv: ["xdg-open", path.posix.join(binding.workspacePath, relative)],
            timeout: 15,
          },
        ];
      }
      // Launch/focus needs an application registry and window selector, not arbitrary shell text.
      case "launch":
      case "focus":
        throw unsupported(`desktop ${action.kind}`);
      default:
        throw unsupported("desktop action");
    }
  }

  private async acquire(binding: Binding, context: AdapterContext): Promise<() => void> {
    context.signal.throwIfAborted();
    const previous = this.queues.get(binding.providerRef) ?? Promise.resolve();
    let unlock!: () => void;
    const next = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.queues.set(binding.providerRef, next);
    const release = () => {
      unlock();
      if (this.queues.get(binding.providerRef) === next) this.queues.delete(binding.providerRef);
    };
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(context.signal.reason ?? new Error("Incus operation aborted"));
      context.signal.addEventListener("abort", onAbort, { once: true });
      if (context.signal.aborted) onAbort();
    });
    try {
      await Promise.race([previous, aborted]);
      context.signal.throwIfAborted();
    } catch (error) {
      // Do not let a cancelled waiter open the gate before the current holder exits.
      void previous.then(release);
      throw error;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
    }
    return release;
  }

  private async exclusive<T>(
    binding: Binding,
    context: AdapterContext,
    fn: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquire(binding, context);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function identifier(value: string, name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(value)) throw new Error(`Invalid Incus ${name}`);
  return value;
}
function argv(value: readonly string[]): string[] {
  if (
    !value.length ||
    !value[0] ||
    value.some((part) => typeof part !== "string" || part.includes("\0"))
  )
    throw new Error("Invalid Incus command argv");
  return [...value];
}
function nonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
}
function bounded(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function decodeBase64(value: unknown, maxBytes: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maxBytes / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    throw new Error("Invalid or oversized Incus base64 response");
  const result = Buffer.from(value, "base64");
  if (result.byteLength > maxBytes) throw new Error("file exceeds maxBytes");
  return result;
}
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function unsupported(capability: string): Error {
  return new Error(`Incus provider does not support ${capability}`);
}
