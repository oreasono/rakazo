import { spawn } from "node:child_process";
import type { ProcessEvent } from "@rakazo/adapter-kit";

/** All host execution is argv-based. Only the SSH transport quotes a remote command. */
export interface IncusProcessRequest {
  argv: readonly string[];
  input?: string;
  /** Exec's guest supervisor treats EOF as cancellation; keep stdin open until exit. */
  keepStdinOpen?: boolean;
  timeoutMs: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export type IncusProcessRunner = (request: IncusProcessRequest) => AsyncIterable<ProcessEvent>;

/** Injectable so adapter tests never need Incus, SSH, a VM, or credentials. */
export const runIncusProcess: IncusProcessRunner = async function* (request) {
  request.signal.throwIfAborted();
  const [command, ...args] = request.argv;
  if (!command) throw new Error("Incus transport requires an executable");
  const child = spawn(command, args, {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  const queue: ProcessEvent[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  let failure: Error | undefined;
  let outputBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const signalGroup = (signal: NodeJS.Signals) => {
    if (closed) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      // It may have exited between the state check and kill.
    }
  };
  const stop = () => {
    // Close the guest supervisor's liveness channel before tearing down the transport.
    child.stdin.end();
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), 1_000);
    killTimer.unref();
  };
  const fail = (error: Error) => {
    failure ??= error;
    stop();
    wake?.();
  };
  const append = (type: "stdout" | "stderr", data: string) => {
    outputBytes += Buffer.byteLength(data);
    if (outputBytes > request.maxOutputBytes) {
      fail(new Error("Incus transport output limit exceeded"));
      return;
    }
    if (!failure) queue.push({ type, data });
    wake?.();
  };
  child.stdout.setEncoding("utf8").on("data", (data: string) => append("stdout", data));
  child.stderr.setEncoding("utf8").on("data", (data: string) => append("stderr", data));
  child.once("error", (error) => fail(error));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    // A guest rejecting input can close its pipe before the exit status arrives.
    if (error.code !== "EPIPE") fail(error);
  });
  child.once("close", (code, signal) => {
    closed = true;
    queue.push({ type: "exit", code: code ?? (signal === "SIGTERM" ? 143 : 137) });
    wake?.();
  });
  const abort = () => fail(new Error("Incus operation aborted"));
  request.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new Error("Incus transport timed out")), request.timeoutMs);
  timer.unref();
  if (request.signal.aborted) abort();
  if (!failure) {
    if (request.keepStdinOpen) child.stdin.write(request.input ?? "");
    else child.stdin.end(request.input ?? "");
  }
  try {
    while (true) {
      if (failure) throw failure;
      const event = queue.shift();
      if (event) yield event;
      else if (closed) return;
      else
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
    }
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", abort);
    if (!closed) stop();
    else if (killTimer) clearTimeout(killTimer);
  }
};
