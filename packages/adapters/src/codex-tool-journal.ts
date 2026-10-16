import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentRunRequest, ConnectorTool } from "@rakazo/adapter-kit";

export interface CodexToolRecord {
  version: 1;
  runId: string;
  executionId: string;
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
  status: "prepared" | "dispatched" | "completed";
  result?: unknown;
}

export class CodexRecoveryRequired extends Error {
  constructor() {
    super(
      "An interrupted operation has no confirmed result. Recovery needs review; no operation was repeated.",
    );
  }
}

/** Private write-ahead records. A dispatched record is never permission to dispatch again. */
export class CodexToolJournal {
  private readonly directory: string;
  constructor(
    root: string,
    private readonly request: AgentRunRequest,
    private readonly signal: AbortSignal,
  ) {
    this.directory = join(root, digest(request.runId));
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      await this.records();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if ((await readdir(this.directory)).length) throw new CodexRecoveryRequired();
      await durableJson(join(this.directory, "manifest.json"), {
        version: 1,
        runId: this.request.runId,
      });
    }
  }

  async records(): Promise<CodexToolRecord[]> {
    const manifest = JSON.parse(await readFile(join(this.directory, "manifest.json"), "utf8"));
    if (manifest.version !== 1 || manifest.runId !== this.request.runId)
      throw new CodexRecoveryRequired();
    const records: CodexToolRecord[] = [];
    for (const name of (await readdir(this.directory)).sort()) {
      if (!name.endsWith(".json") || name === "manifest.json") continue;
      const record = JSON.parse(
        await readFile(join(this.directory, name), "utf8"),
      ) as CodexToolRecord;
      if (
        record.version !== 1 ||
        record.runId !== this.request.runId ||
        typeof record.executionId !== "string" ||
        typeof record.name !== "string" ||
        !record.args ||
        typeof record.args !== "object" ||
        Array.isArray(record.args) ||
        record.fingerprint !== fingerprint(record.name, record.args) ||
        name !== `${digest(record.executionId)}.json` ||
        !["prepared", "dispatched", "completed"].includes(record.status)
      )
        throw new Error("Invalid Codex operation journal");
      records.push(record);
    }
    return records;
  }

  async execute(tool: ConnectorTool, args: Record<string, unknown>, executionId: string) {
    this.signal.throwIfAborted();
    const records = await this.records();
    let record = records.find((value) => value.executionId === executionId);
    if (record && record.fingerprint !== fingerprint(tool.name, args))
      throw new Error("Codex operation identity changed");
    if (record?.status === "completed") return record.result;
    if (records.some((value) => value.status === "dispatched")) throw new CodexRecoveryRequired();
    if (!record) {
      record = {
        version: 1,
        runId: this.request.runId,
        executionId,
        name: tool.name,
        args,
        fingerprint: fingerprint(tool.name, args),
        status: "prepared",
      };
      await this.save(record);
    }
    await crashGate("tool_prepared", record, this.signal);
    this.signal.throwIfAborted();
    record.status = "dispatched";
    await this.save(record);
    this.signal.throwIfAborted();
    if (!this.request.executeTool) throw new Error("No tool executor");
    // Any throw after dispatch leaves the operation uncertain, not safely retryable.
    let result: unknown;
    try {
      result = await this.request.executeTool(tool.name, args, executionId, tool.route);
    } catch {
      throw new CodexRecoveryRequired();
    }
    if (unconfirmedResult(result)) throw new CodexRecoveryRequired();
    record.status = "completed";
    record.result = result ?? null;
    await this.save(record);
    await crashGate("tool_result_stored", record, this.signal);
    return result;
  }

  async reconcile(tools: ConnectorTool[]): Promise<CodexToolRecord[]> {
    for (const record of (await this.records()).sort(
      (a, b) => Number(b.status === "dispatched") - Number(a.status === "dispatched"),
    )) {
      this.signal.throwIfAborted();
      if (record.status === "completed") continue;
      const tool = tools.find((value) => value.name === record.name);
      if (!tool) throw new CodexRecoveryRequired();
      if (record.status === "prepared") {
        await this.execute(tool, record.args, record.executionId);
        continue;
      }
      if (!this.request.reconcileTool) throw new CodexRecoveryRequired();
      const deadline = Date.now() + 90_000;
      while (true) {
        this.signal.throwIfAborted();
        const outcome = await this.request.reconcileTool(
          record.name,
          record.args,
          record.executionId,
        );
        if (outcome.status === "completed") {
          if (unconfirmedResult(outcome.result)) throw new CodexRecoveryRequired();
          record.status = "completed";
          record.result = outcome.result ?? null;
          await this.save(record);
          break;
        }
        if (outcome.status === "unknown" || Date.now() >= deadline)
          throw new CodexRecoveryRequired();
        await delay(500, undefined, { signal: this.signal });
      }
    }
    return this.records();
  }

  private async save(record: CodexToolRecord) {
    await durableJson(join(this.directory, `${digest(record.executionId)}.json`), record);
  }
}

export async function durableJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(join(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function unconfirmedResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  return (
    value.uncertain === true ||
    value.running === true ||
    value.status === "uncertain" ||
    (value.kind === "agent_tool_result" && unconfirmedResult(value.details))
  );
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function fingerprint(name: string, args: Record<string, unknown>) {
  return digest(canonical([name, args]));
}

/** Trusted test-only latch. It never kills a process or accepts model-supplied paths. */
async function crashGate(phase: string, record: CodexToolRecord, signal: AbortSignal) {
  const path = process.env.NODE_ENV === "test" ? process.env.RAKAZO_CODEX_CRASH_GATE : undefined;
  if (!path) return;
  const gate = JSON.parse(await readFile(path, "utf8")) as {
    phase: string;
    tool: string;
    argumentIncludes: string;
    reachedFile: string;
    releaseFile: string;
  };
  if (
    gate.phase !== phase ||
    gate.tool !== record.name ||
    !gate.argumentIncludes ||
    !JSON.stringify(record.args).includes(gate.argumentIncludes)
  )
    return;
  try {
    await readFile(gate.reachedFile);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await durableJson(gate.reachedFile, {
    phase,
    pid: process.pid,
    executionId: record.executionId,
    at: new Date().toISOString(),
  });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      await readFile(gate.releaseFile);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(50, undefined, { signal });
  }
  throw new Error("Crash acceptance latch timed out");
}
