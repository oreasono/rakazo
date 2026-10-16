import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type CodexObject = Record<string, unknown>;
export interface CodexNotification {
  method: string;
  params: CodexObject;
}

export class CodexQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: Error;

  push(value: T) {
    if (this.ended) return;
    this.values.push(value);
    this.wake?.();
  }

  end(error?: Error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) yield this.values.shift()!;
      else if (this.ended) {
        if (this.error) throw this.error;
        return;
      } else
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
    }
  }
}

export interface CodexConnection {
  request(method: string, params: CodexObject): Promise<CodexObject>;
  notify(method: string, params: CodexObject): void;
  close(): Promise<void>;
}

export interface CodexConnectionOptions {
  binary: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification: (event: CodexNotification) => void;
  onRequest: (method: string, params: CodexObject) => Promise<unknown>;
  onExit: (error: Error) => void;
}

/** One isolated app-server process; notifications from native children remain intact. */
export class CodexAppServer implements CodexConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: CodexObject) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private seq = 0;
  private stopped = false;
  private closing = false;
  private readonly exited: Promise<void>;

  constructor(private readonly options: CodexConnectionOptions) {
    this.child = spawn(options.binary, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume(); // Runtime diagnostics may contain credentials or private paths.
    this.exited = new Promise((resolve) => {
      this.child.once("exit", () => {
        this.fail();
        resolve();
      });
      this.child.once("error", () => {
        this.fail();
        resolve();
      });
    });
    this.child.stdin.on("error", () => this.fail());
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      try {
        if (line.length > 16 * 1024 * 1024) throw new Error("Oversized message");
        const message = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: CodexObject;
          result?: CodexObject;
          error?: { code?: number };
        };
        if (message.method) {
          if (message.id !== undefined) {
            void options.onRequest(message.method, message.params ?? {}).then(
              (result) => this.send({ id: message.id, result }),
              () =>
                this.send({
                  id: message.id,
                  error: { code: -32603, message: "Request not permitted" },
                }),
            );
          } else options.onNotification({ method: message.method, params: message.params ?? {} });
          return;
        }
        const entry = typeof message.id === "number" ? this.pending.get(message.id) : undefined;
        if (!entry) return;
        this.pending.delete(message.id as number);
        clearTimeout(entry.timer);
        if (message.error)
          entry.reject(new Error(`Codex request rejected (${message.error.code ?? "unknown"})`));
        else entry.resolve(message.result ?? {});
      } catch {
        this.fail();
        this.child.kill();
      }
    });
  }

  private fail() {
    if (this.stopped) return;
    this.stopped = true;
    const error = new Error("Codex app-server connection closed");
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (!this.closing) this.options.onExit(error);
  }

  private send(message: unknown) {
    if (!this.stopped) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: CodexObject) {
    this.send({ method, params });
  }

  request(method: string, params: CodexObject): Promise<CodexObject> {
    if (this.stopped) return Promise.reject(new Error("Codex app-server connection closed"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  async close() {
    this.closing = true;
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 3_000);
    this.child.kill("SIGTERM");
    await this.exited;
    clearTimeout(timer);
  }
}
