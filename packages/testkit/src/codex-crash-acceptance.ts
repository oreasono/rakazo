/** Opt-in product crash gate. This module performs no direct runtime calls or DB writes. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { chromium } from "@playwright/test";
import { createDb } from "@rakazo/db";
import type { CrashControl, CrashHit, CrashSnapshot } from "./codex-crash-proof.js";
import {
  appendTask,
  crashBoundary,
  requireAppendCount,
  requireCrashHit,
  requireCrashRecovery,
  requireCrashTree,
  requirePendingChildAppend,
} from "./codex-crash-proof.js";
import { assertTerminalRuns } from "./codex-incus-attempt.js";
import { captureNativeTree } from "./codex-incus-browser.js";
import { expandReadbackArgv } from "./codex-incus-proof.js";

type State = {
  kind: string;
  directory: string;
  repo: string;
  node: string;
  mode: string;
  config: string;
  env: Record<string, string>;
  services: Record<string, { pid: number; generation: string }>;
};
type Seed = {
  cookie: string;
  email: string;
  password: string;
  botId: string;
  threadId: string;
  spaceId: string;
};
type Config = {
  readbackCommand: string[];
  inventoryCommand: string[];
  provisionReceipt: string;
  chromiumExecutable?: string;
  phaseTimeoutMs?: number;
};
type Worker = { pid: number; wrapperPid: number; generation: string; started: string };
type Journal = {
  version: number;
  runId: string;
  executionId: string;
  name: string;
  args: Record<string, unknown>;
  fingerprint: string;
  status: "prepared" | "dispatched" | "completed";
  result?: unknown;
};
type Session = {
  owner: string;
  rootThreadId: string;
  runs: Record<string, { status: string }>;
  nodes: Record<string, { nativeRevision?: number; status: string; nativeStatus?: string }>;
};
const load = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const exec = promisify(execFile);

async function independent(argv: string[], timeout = 30_000) {
  assert(Array.isArray(argv) && argv.length && argv.every((v) => typeof v === "string"));
  try {
    return (
      await exec(argv[0]!, argv.slice(1), { encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 })
    ).stdout;
  } catch {
    throw new Error("Independent command failed; output suppressed");
  }
}

async function main() {
  assert(process.argv.includes("--allow-live"), "Crash gate requires explicit --allow-live");
  const directory = process.env.RAKAZO_ACCEPTANCE_STATE;
  assert(directory, "Run through the private-state launcher");
  const state = load<State>(path.join(directory, "state.json"));
  assert.equal(state.kind, "rakazo-codex-incus-acceptance");
  assert.equal(state.directory, directory);
  assert.equal(state.mode, "live");
  assert.equal(new URL(state.env.DATABASE_URL!).hostname, "127.0.0.1");
  assert.equal(new URL(state.env.DATABASE_URL!).pathname, "/acceptance");
  assert.equal(state.env.WAKEUP_DRIVER, "graphile");
  assert.equal(state.env.NODE_ENV, "test");
  for (const name of ["api", "web", "worker"])
    assert(state.services[name], `Missing ${name} service`);
  assert.notEqual(state.services.api!.pid, state.services.worker!.pid);
  const boundary = crashBoundary(process.argv.find((v) => v.startsWith("--boundary="))?.slice(11));
  const config = load<Config>(state.config);
  const seed = load<Seed>(path.join(directory, "seed.json"));
  const worker = load<Worker>(path.join(directory, "worker-process.json"));
  assert.equal(
    worker.generation,
    state.services.worker!.generation,
    "Worker identity is stale; restart with current launcher",
  );
  assert.equal(worker.wrapperPid, state.services.worker!.pid);
  for (const name of [
    "run-attempt.json",
    "crash-control.json",
    "crash-kill.json",
    "crash-receipt.json",
  ])
    assert(
      !existsSync(path.join(directory, name)),
      "Use a fresh seeded bot/state for each crash boundary; no automatic retry",
    );
  const save = (name: string, value: unknown) => {
    const target = path.join(directory, name),
      temporary = `${target}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, target);
  };
  const rpc = async <T>(procedure: string, input: unknown = {}): Promise<T> => {
    const response = await fetch(`${state.env.API_URL}/rpc/${procedure}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: state.env.WEB_ORIGIN!,
        cookie: seed.cookie,
      },
      body: JSON.stringify({ json: input }),
      signal: AbortSignal.timeout(30_000),
    });
    assert(response.ok, `RPC ${procedure} failed (HTTP ${response.status})`);
    const body = (await response.json()) as { json: T; error?: unknown };
    assert(!body.error, `RPC ${procedure} returned an error`);
    return body.json;
  };
  const allocation = load<{
    ready: boolean;
    instance?: string;
    vm?: string;
    before?: string[];
    baseline?: string;
  }>(config.provisionReceipt);
  assert.equal(allocation.ready, true, "Provisioning owner has not handed over a ready VM");
  const instance = allocation.instance ?? allocation.vm ?? "";
  assert(/^[a-zA-Z0-9][a-zA-Z0-9-]+$/.test(instance));
  assert(allocation.before || allocation.baseline, "Missing independent pre-allocation inventory");
  const baseline =
    allocation.before ??
    allocation
      .baseline!.split("\n")
      .filter(Boolean)
      .map((line) => line.split(",")[0]!.trim());
  assert(!baseline.includes(instance), "Crash acceptance needs a newly allocated disposable VM");
  const inventory = await independent(config.inventoryCommand);
  const names = inventory.trim().startsWith("[")
    ? (JSON.parse(inventory) as Array<string | { name: string }>).map((v) =>
        typeof v === "string" ? v : v.name,
      )
    : inventory
        .split("\n")
        .filter(Boolean)
        .map((v) => v.split(",")[0]!.trim());
  assert(names.includes(instance), "Owned VM absent from independent inventory");

  const db = createDb(state.env.DATABASE_URL!);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let receipt: Record<string, unknown> | undefined;
  try {
    const priorRuns = await db.prisma.run.findMany({
      where: { threadId: seed.threadId },
      include: { attempts: true },
    });
    assertTerminalRuns(
      priorRuns,
      priorRuns.flatMap((r) => r.attempts),
    );
    // Seeding cancels an intro without starting a worker. Any executed run makes this seed unsuitable.
    assert(
      priorRuns.every((r) => r.status === "cancelled" && r.attempts.length === 0),
      "Seed already executed a product turn",
    );
    assert.equal(
      await db.prisma.event.count({ where: { threadId: seed.threadId, type: "thread.subagent" } }),
      0,
      "Seed has previous native history",
    );
    const nonce = `CRASH_${randomBytes(16).toString("hex")}`;
    const guestPath = `/tmp/rakazo-crash-${randomBytes(16).toString("hex")}.txt`;
    const control: CrashControl = {
      version: 1,
      fixtureId: randomUUID(),
      botId: seed.botId,
      productThreadId: seed.threadId,
      boundary,
      toolName: "shell",
      argumentContains: [nonce, guestPath],
      receiptDirectory: path.join(directory, "crash-gate"),
    };
    mkdirSync(control.receiptDirectory, { mode: 0o700 });
    save("crash-control.json", control);
    receipt = {
      passed: false,
      mode: "real-product-crash",
      boundary,
      fixtureId: control.fixtureId,
      startedAt: new Date().toISOString(),
      vmCleanup: "owned-vm-retained-for-operator-cleanup",
      visualReview: "pending",
    };
    save("crash-receipt.json", receipt);
    const reachedFile = path.join(control.receiptDirectory, "reached.json");
    const gate =
      boundary === "tool_dispatched"
        ? { phase: "disabled" }
        : {
            phase: boundary,
            tool: "shell",
            argumentIncludes: nonce,
            reachedFile,
            releaseFile: path.join(control.receiptDirectory, "release"),
          };
    save("crash-gate.json", gate);
    const readback = () =>
      independent(
        expandReadbackArgv(config.readbackCommand, { computerRef: instance, path: guestPath }),
        10_000,
      );
    // The readback wrapper must return empty bytes only for ENOENT; connectivity/permission errors fail.
    requireAppendCount(await readback(), nonce, 0);
    const consent = await rpc<{
      scope: string;
      version: string;
      recipients: Array<{ key: string; allowed: boolean }>;
    }>("aiConsent/status", { botId: seed.botId, uses: ["model"] });
    const keys = consent.recipients.filter((r) => !r.allowed).map((r) => r.key);
    if (keys.length)
      await rpc("aiConsent/allow", { scope: consent.scope, version: consent.version, keys });
    browser = await chromium.launch({
      headless: true,
      ...(config.chromiumExecutable ? { executablePath: config.chromiumExecutable } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 1200 } });
    const login = await context.request.post(`${state.env.WEB_ORIGIN}/api/auth/sign-in/email`, {
      data: { email: seed.email, password: seed.password },
      headers: { origin: state.env.WEB_ORIGIN! },
    });
    assert(login.ok(), "Browser login failed");
    const page = await context.newPage();
    await page.goto(`${state.env.WEB_ORIGIN}/app/${seed.botId}`);
    const task = appendTask(nonce, guestPath, boundary);
    const sent = await rpc<{ runId: string }>("threads/send", {
      botId: seed.botId,
      text: task.prompt,
      clientNonce: `crash-${control.fixtureId}`,
    });
    assert(sent.runId && !priorRuns.some((r) => r.id === sent.runId));
    receipt.runId = sent.runId;
    save("crash-receipt.json", receipt);
    const run = await db.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
    const owner = JSON.stringify([seed.spaceId, run.userId, seed.threadId, seed.botId]);
    const home = path.join(state.env.DATA_DIR!, "codex-sessions", hash(owner));
    const session = () => {
      const value = load<Session>(path.join(home, "session.json"));
      assert.equal(value.owner, owner);
      return value;
    };
    const journalDir = path.join(home, "operations", hash(sent.runId));
    const journals = () => {
      if (!existsSync(journalDir)) return [];
      return readdirSync(journalDir)
        .filter((name) => name.endsWith(".json") && name !== "manifest.json")
        .map((name) => {
          const file = path.join(journalDir, name),
            bytes = readFileSync(file, "utf8");
          const record = JSON.parse(bytes) as Journal;
          assert.equal(record.version, 1);
          assert.equal(record.runId, sent.runId);
          assert.equal(name, `${hash(record.executionId)}.json`);
          return { file, sha256: hash(bytes), record };
        });
    };
    const snapshot = async (): Promise<CrashSnapshot> => ({
      run: await db.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } }),
      events: await db.prisma.event.findMany({
        where: { runId: sent.runId },
        orderBy: { seq: "asc" },
      }),
      messages: await db.prisma.message.findMany({
        where: { threadId: seed.threadId, runId: sent.runId },
        orderBy: { seq: "asc" },
      }),
    });
    const assertRunPending = async () => {
      const current = await db.prisma.run.findUniqueOrThrow({ where: { id: sent.runId } });
      assert(
        !["completed", "failed", "cancelled", "waiting_input", "recovery_required"].includes(
          current.status,
        ),
        `Run ended before crash: ${current.status}`,
      );
    };
    let matched: ReturnType<typeof journals>[number] | undefined;
    const deadline = Date.now() + (config.phaseTimeoutMs ?? 720_000);
    while (Date.now() < deadline) {
      await assertRunPending();
      const candidates = journals().filter(
        ({ record: r }) => r.name === "shell" && r.args.command === task.command,
      );
      assert(candidates.length <= 1, "Multiple append operations were admitted");
      matched = candidates[0];
      if (matched) {
        if (boundary === "tool_dispatched") {
          assert.notEqual(matched.record.status, "completed", "Missed dispatched crash boundary");
          if (matched.record.status === "dispatched") {
            const bytes = await readback();
            if (bytes !== "") {
              requireAppendCount(bytes, nonce, 1);
              break;
            }
          }
        } else if (existsSync(reachedFile)) {
          const reached = load<{ phase: string; pid: number; executionId: string; at: string }>(
            reachedFile,
          );
          assert.equal(reached.phase, boundary);
          assert.equal(reached.pid, worker.pid);
          assert.equal(reached.executionId, matched.record.executionId);
          assert(
            Number.isFinite(Date.parse(reached.at)) &&
              Date.now() - Date.parse(reached.at) < 110_000,
            "Stale latch receipt",
          );
          break;
        }
      }
      matched = undefined;
      await sleep(200);
    }
    assert(matched, "Crash boundary timeout; no signal was sent");
    const binding = session();
    const hit: CrashHit = {
      version: 1,
      fixtureId: control.fixtureId,
      boundary,
      workerPid: worker.pid,
      botId: seed.botId,
      productThreadId: seed.threadId,
      runId: sent.runId,
      rootThreadId: binding.rootThreadId,
      executionId: matched.record.executionId,
      toolName: matched.record.name,
      journalStatus: matched.record.status,
      journalSha256: matched.sha256,
      recordedAt: new Date().toISOString(),
      ...(matched.record.status === "completed"
        ? { resultSha256: hash(JSON.stringify(matched.record.result)) }
        : {}),
    };
    requireCrashHit(control, hit, sent.runId, worker.pid);
    const before = await snapshot();
    const beforeTree = requireCrashTree(before, hit.rootThreadId);
    assert.equal(journals().length, 1, "This gate permits only the single child append operation");
    const nativeCalls: Array<ReturnType<typeof requirePendingChildAppend>> = [];
    const inspectRollouts = (root: string) => {
      if (!existsSync(root)) return;
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        const file = path.join(root, entry.name);
        if (entry.isDirectory()) {
          inspectRollouts(file);
          continue;
        }
        if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
        const records = readFileSync(file, "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as { type?: string; payload?: Record<string, unknown> }];
            } catch {
              return [];
            } // A still-open rollout may have an unfinished last line.
          });
        const childId = records.find((r) => r.type === "session_meta")?.payload?.id;
        if (typeof childId === "string" && beforeTree.childThreadIds.includes(childId))
          nativeCalls.push(requirePendingChildAppend(records, childId, task.command));
      }
    };
    inspectRollouts(path.join(home, "codex", "sessions"));
    assert.equal(
      nativeCalls.length,
      1,
      "Native child append call missing from actual Codex rollout",
    );
    save("crash-child-call.json", nativeCalls[0]);
    save("crash-before.json", { snapshot: before, session: binding, journal: matched });
    await captureStatus(page, beforeTree, "crash-before", directory, save);
    // Re-read immediately before kill: UI capture must not silently move the test past its boundary.
    const still = journals().find((j) => j.record.executionId === hit.executionId);
    assert.equal(still?.sha256, matched.sha256, "Journal advanced before SIGKILL");
    const beforeBytes = await readback();
    requireAppendCount(beforeBytes, nonce, boundary === "tool_prepared" ? 0 : 1);
    save("crash-prekill-readback.json", {
      bytes: beforeBytes,
      observedAt: new Date().toISOString(),
    });
    save("crash-hit.json", hit);
    const launcher = async (command: string) =>
      independent(
        [
          state.node,
          path.join(state.repo, "scripts/accept-codex-incus.mjs"),
          command,
          `--state=${directory}`,
          "--allow-live",
          `--fixture-id=${control.fixtureId}`,
        ],
        120_000,
      );
    await launcher("crash-worker");
    const kill = load<{ fixtureId: string; observedExit: boolean; signal: string; before: Worker }>(
      path.join(directory, "crash-kill.json"),
    );
    assert.equal(kill.fixtureId, control.fixtureId);
    assert.equal(kill.observedExit, true);
    assert.equal(kill.signal, "SIGKILL");
    assert.equal(kill.before.pid, hit.workerPid);
    // On the dispatched case the VM command is still sleeping. No result can yet be durable.
    const atKill = journals().find((j) => j.record.executionId === hit.executionId);
    assert.equal(
      atKill?.sha256,
      matched.sha256,
      "Crash did not preserve the selected journal boundary",
    );
    save("crash-killed-journal.json", atKill);
    await launcher("crash-restart-worker");
    const restart = load<{ fixtureId: string; after: Worker }>(
      path.join(directory, "crash-restart.json"),
    );
    assert.equal(restart.fixtureId, control.fixtureId);
    let after: CrashSnapshot | undefined;
    const recoveryDeadline = Date.now() + (config.phaseTimeoutMs ?? 720_000);
    while (Date.now() < recoveryDeadline) {
      after = await snapshot();
      save("crash-recovery-latest.json", after);
      if (after.run.status === "completed") break;
      assert(
        !["failed", "cancelled", "waiting_input", "recovery_required"].includes(after.run.status),
        `Same-run recovery stopped: ${after.run.status}`,
      );
      await sleep(500);
    }
    assert(
      after?.run.status === "completed",
      "Same-run recovery timeout; inspect private state before retrying",
    );
    const finalBytes = await readback();
    const tree = requireCrashRecovery({
      hit,
      before,
      after,
      killedPid: kill.before.pid,
      restartedPid: restart.after.pid,
      appendBytes: finalBytes,
      nonce,
    });
    const finalJournal = journals();
    assert.equal(finalJournal.length, 1, "Recovery admitted another tool operation");
    assert.equal(finalJournal[0]!.record.executionId, hit.executionId);
    assert.equal(finalJournal[0]!.record.status, "completed");
    if (hit.resultSha256)
      assert.equal(
        hash(JSON.stringify(finalJournal[0]!.record.result)),
        hit.resultSha256,
        "Stored result changed during recovery",
      );
    const finalSession = session();
    assert.equal(finalSession.rootThreadId, hit.rootThreadId);
    assert.equal(finalSession.runs[sent.runId]?.status, "completed");
    for (const node of tree.nodes) {
      assert.equal(finalSession.nodes[node.threadId]?.nativeRevision, node.nativeRevision);
      assert.equal(finalSession.nodes[node.threadId]?.nativeStatus, node.nativeStatus);
    }
    const currentRuns = await db.prisma.run.findMany({ where: { threadId: seed.threadId } });
    assert.deepEqual(
      currentRuns.map((r) => r.id).sort(),
      [...priorRuns.map((r) => r.id), sent.runId].sort(),
      "Recovery created a replacement product run",
    );
    const bot = await db.prisma.bot.findUniqueOrThrow({
      where: { id: seed.botId },
      include: { computer: true },
    });
    assert.equal(bot.computer?.kind, "incus");
    assert(bot.computer?.providerRef?.endsWith(`:${instance}`), "Product used another VM");
    const apiMessages = await rpc<{ messages: Array<{ runId?: string; blocks: unknown }> }>(
      "threads/messages",
      { botId: seed.botId },
    );
    requireCrashTree(
      { ...after, messages: apiMessages.messages.map((m) => ({ ...m, runId: m.runId ?? null })) },
      hit.rootThreadId,
    );
    save("crash-after.json", {
      snapshot: after,
      session: finalSession,
      journals: finalJournal,
      apiMessages,
      appendBytes: finalBytes,
    });
    await captureStatus(page, tree, "crash-after", directory, save);
    await page.reload();
    await captureStatus(page, tree, "crash-refreshed", directory, save);
    // Read both source and guest again after refresh; a UI-only refresh cannot pass the gate.
    const refreshed = await snapshot();
    const refreshedApi = await rpc<typeof apiMessages>("threads/messages", { botId: seed.botId });
    requireCrashTree(
      {
        ...refreshed,
        messages: refreshedApi.messages.map((m) => ({ ...m, runId: m.runId ?? null })),
      },
      hit.rootThreadId,
    );
    requireAppendCount(await readback(), nonce, 1);
    save("crash-refreshed-source.json", { snapshot: refreshed, apiMessages: refreshedApi });
    Object.assign(receipt, {
      passed: true,
      rootThreadId: tree.rootThreadId,
      childThreadIds: tree.childThreadIds,
      appendCount: 1,
      sameProductRun: true,
      workerSigkill: true,
      recoveryCheckpoints: true,
      browserStatusAndRefresh: true,
      originalInputResubmitted: false,
    });
  } catch (error) {
    if (receipt)
      receipt.failure = error instanceof Error ? error.message : "Crash acceptance failed";
    // Leave evidence and ambiguous operations intact. No stop/replay/lease edit on failure.
    throw error;
  } finally {
    if (receipt) {
      receipt.finishedAt = new Date().toISOString();
      save("crash-receipt.json", receipt);
    }
    await browser?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  console.log(
    "Crash evidence collected; inspect private screenshots before visual acceptance. Owned VM retained.",
  );
}

async function captureStatus(
  page: Page,
  tree: ReturnType<typeof requireCrashTree>,
  name: string,
  directory: string,
  save: (name: string, value: unknown) => void,
) {
  const container = page.locator(
    `[data-testid="native-session-tree"][data-root-thread-id="${tree.rootThreadId}"]`,
  );
  for (const node of tree.nodes) {
    const row = container.locator(
      `[data-native-thread-id="${node.threadId}"][data-status="${node.status}"]${node.nativeStatus ? `[data-native-status="${node.nativeStatus}"]` : ""}`,
    );
    await row.waitFor({ state: "visible", timeout: 30_000 });
    const text = await row.innerText();
    const expectedLabel =
      node.nativeStatus === "interrupted"
        ? "Interrupted"
        : node.nativeStatus === "recovering"
          ? "Recovering"
          : (node.nativeStatus ?? node.status);
    assert(text.includes(expectedLabel), "Native status is not visibly rendered");
  }
  const capture = await captureNativeTree(page, tree, path.join(directory, `${name}.png`));
  save(`${name}-capture.json`, { ...capture, nodes: tree.nodes });
}

await main().catch(() => {
  console.error("Crash acceptance failed; inspect private receipts/logs. No retry was performed.");
  process.exitCode = 1;
});
