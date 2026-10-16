/** Opt-in real API -> Graphile worker -> Codex -> preallocated disposable Incus VM.
 * Never provisions a VM. The operator supplies one owned VM and independent readback argv.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createDb } from "@rakazo/db";
import { archivePreviousAttempt, assertTerminalRuns } from "./codex-incus-attempt.js";
import { captureNativeTree } from "./codex-incus-browser.js";
import {
  completedChildToolCalls,
  expandReadbackArgv,
  nonceTaskPrompt,
  requireCompletedCheckpoint,
  requireNativeTree,
  requireReadback,
} from "./codex-incus-proof.js";

type NativeTree = ReturnType<typeof requireNativeTree>;
type State = {
  directory: string;
  kind: string;
  mode: string;
  node: string;
  repo: string;
  config?: string;
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
  modelKeyCommand?: string[];
  modelConnection?: Record<string, unknown>;
  readbackCommand?: string[];
  inventoryCommand?: string[];
  /** Written by the provisioning owner before handing this one VM to the provider. */
  provisionReceipt?: string;
  chromiumExecutable?: string;
  phaseTimeoutMs?: number;
};

const dir =
  process.env.RAKAZO_ACCEPTANCE_STATE ??
  (() => {
    throw new Error("Run through scripts/accept-codex-incus.mjs");
  })();
const load = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;
const state = load<State>(path.join(dir, "state.json"));
assert.equal(state.kind, "rakazo-codex-incus-acceptance");
assert.equal(state.directory, dir);
assert.equal(new URL(state.env.DATABASE_URL!).hostname, "127.0.0.1");
assert.equal(new URL(state.env.DATABASE_URL!).pathname, "/acceptance");
const save = (name: string, value: unknown) =>
  writeFileSync(path.join(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rpc<T>(cookie: string, procedure: string, input: unknown = {}): Promise<T> {
  const response = await fetch(`${state.env.API_URL}/rpc/${procedure}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: state.env.WEB_ORIGIN!, cookie },
    body: JSON.stringify({ json: input }),
    signal: AbortSignal.timeout(30_000),
  });
  // Keep responses private; model credentials can appear in unrelated settings routes.
  if (!response.ok) throw new Error(`RPC ${procedure} returned HTTP ${response.status}`);
  const body = (await response.json()) as { json: T; error?: unknown };
  if (body.error) throw new Error(`RPC ${procedure} failed`);
  return body.json;
}
async function seed() {
  const seedPath = path.join(dir, "seed.json");
  if (existsSync(seedPath)) {
    const existing = load<Seed>(seedPath);
    await rpc(existing.cookie, "bots/get", { botId: existing.botId });
    console.log("Existing isolated API seed verified; no duplicate bot created.");
    return;
  }
  if (state.services.worker)
    throw new Error("Seed before starting the worker to avoid automatic intro/model calls");
  const suffix = randomBytes(8).toString("hex");
  const email = `acceptance-${suffix}@example.test`,
    password = randomBytes(24).toString("hex");
  const response = await fetch(`${state.env.API_URL}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: state.env.WEB_ORIGIN! },
    body: JSON.stringify({ email, password, name: "Acceptance Operator" }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`API signup returned HTTP ${response.status}`);
  const cookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  assert(cookie, "Signup did not issue a session cookie");
  const me = await rpc<{ userId: string; spaceId: string }>(cookie, "me");
  // Offline mode verifies auth only. Never seed a fake-kind computer for later live reuse.
  if (state.mode !== "live") {
    save("offline-auth.json", {
      verified: true,
      mode: "infrastructure-only",
      userId: me.userId,
      spaceId: me.spaceId,
    });
    console.log("Real signup/session/me RPC passed; no bot, model call or VM created.");
    return;
  }
  const bot = await rpc<{ id: string; threadId: string }>(cookie, "bots/create", {
    name: "Codex Acceptance",
    title: "Disposable desktop verification",
    description: "Synthetic acceptance only",
    instructions:
      "Use native Codex subagents. Computer tools target the assigned remote VM. Do not create product bots, modify other computers, send external messages or change secrets.",
    notifyOnFinish: false,
    computerMode: "dedicated",
  });
  await rpc(cookie, "threads/stop", { botId: bot.id });
  const result: Seed = {
    cookie,
    email,
    password,
    botId: bot.id,
    threadId: bot.threadId,
    spaceId: me.spaceId,
  };
  save("seed.json", result);
  const db = createDb(state.env.DATABASE_URL!);
  try {
    const row = await db.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { computer: true },
    });
    assert.equal(row.computer?.kind, "incus");
    assert.equal(row.computer?.providerRef, null, "Seed unexpectedly acquired a VM");
    save("binding-request.json", {
      spaceId: me.spaceId,
      botId: bot.id,
      productThreadId: bot.threadId,
      computerId: row.computer?.id,
      homeKey: row.computer?.homeKey,
      instructions:
        "Bind exactly one new disposable VM to this spaceId and homeKey. Do not duplicate provisioning.",
    });
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  console.log(
    "Live-mode API seed ready; private binding-request.json identifies the computer home key. No worker/model/VM action started.",
  );
}

function independent(argv: string[]): string {
  assert(argv.length && argv.every((v) => typeof v === "string"));
  try {
    return execFileSync(argv[0]!, argv.slice(1), {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    throw new Error("Independent VM command failed (output suppressed)");
  }
}

async function connectModel() {
  assert.equal(state.mode, "live");
  assert(!state.services.worker, "Connect the test model before starting the worker");
  assert(state.config);
  const config = load<Config>(state.config),
    seed = load<Seed>(path.join(dir, "seed.json"));
  assert(
    config.modelKeyCommand && config.modelConnection,
    "Supply modelKeyCommand and modelConnection in the private config",
  );
  const apiKey = independent(config.modelKeyCommand).trim();
  assert(apiKey, "Credential source returned no value");
  await rpc(seed.cookie, "models/connect", { ...config.modelConnection, apiKey });
  save("model-connection.json", {
    configuredThroughProductApi: true,
    credentialPrinted: false,
    configuredAt: new Date().toISOString(),
  });
  console.log(
    "Model connection saved through the real product API in the isolated database; credential output suppressed.",
  );
}

/** Native rollout identity and matched MCP call/output prove the child actually used tools. */
function childToolProof(sessionRoot: string, children: string[], nonce: string, guestPath: string) {
  const matched: Array<{ threadId: string; tools: string[] }> = [];
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      let id: string | undefined;
      const records: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        let event: { type?: string; payload?: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        const p = event.payload;
        if (event.type === "session_meta" && typeof p?.id === "string") id = p.id;
        records.push(event);
      }
      if (id && children.includes(id)) {
        const proof = completedChildToolCalls(records, nonce, guestPath);
        if (proof.wroteNonce) matched.push({ threadId: id, tools: proof.tools });
      }
    }
  };
  visit(sessionRoot);
  assert(
    matched.length,
    "Native child rollout contains no successful Rakazo MCP call/output carrying the file path and nonce",
  );
  return matched;
}

async function run() {
  assert.equal(state.mode, "live");
  assert(
    state.services.api && state.services.web && state.services.worker,
    "Run needs separate API/web/worker processes",
  );
  assert.notEqual(state.services.api.pid, state.services.worker.pid);
  assert.equal(state.env.WAKEUP_DRIVER, "graphile");
  assert(state.config, "Missing live configuration");
  const config = load<Config>(state.config);
  assert(
    config.readbackCommand && config.inventoryCommand && config.provisionReceipt,
    "Supply independent readback/inventory and the provisioning owner's receipt before running",
  );
  const allocation = load<{
    instance?: string;
    vm?: string;
    before?: string[];
    baseline?: string;
    ready: boolean;
  }>(config.provisionReceipt);
  assert.equal(
    allocation.ready,
    true,
    "The provisioning owner has not marked the disposable VM ready",
  );
  const provision = {
    instance: allocation.instance ?? allocation.vm ?? "",
    before:
      allocation.before ??
      (allocation.baseline ?? "")
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(",")[0]!.trim()),
  };
  assert(
    allocation.before || allocation.baseline,
    "Allocation receipt lacks an external pre-creation inventory",
  );
  assert(/^[a-zA-Z0-9][a-zA-Z0-9-]+$/.test(provision.instance));
  assert(
    Array.isArray(provision.before) && !provision.before.includes(provision.instance),
    "VM must be new in the provisioning owner's baseline",
  );
  const inventoryOutput = independent(config.inventoryCommand);
  const inventory = inventoryOutput.trim().startsWith("[")
    ? (JSON.parse(inventoryOutput) as Array<string | { name: string }>).map((item) =>
        typeof item === "string" ? item : item.name,
      )
    : inventoryOutput
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(",")[0]!.trim());
  assert(
    Array.isArray(inventory) && inventory.includes(provision.instance),
    "Disposable VM is not present in external inventory",
  );
  const seed = load<Seed>(path.join(dir, "seed.json"));
  const db = createDb(state.env.DATABASE_URL!);
  const sessionRoot = path.join(state.env.DATA_DIR!, "codex-sessions");
  let receipt:
    | { passed: boolean; checks: Record<string, boolean>; [key: string]: unknown }
    | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const runs = await db.prisma.run.findMany({
      where: { threadId: seed.threadId },
      orderBy: { createdAt: "asc" },
    });
    const attempts = await db.prisma.attempt.findMany({
      where: { runId: { in: runs.map((r) => r.id) } },
    });
    const events = await db.prisma.event.findMany({
      where: { threadId: seed.threadId },
      orderBy: { seq: "asc" },
    });
    const messages = await db.prisma.message.findMany({
      where: { threadId: seed.threadId },
      orderBy: { seq: "asc" },
    });
    if (existsSync(path.join(dir, "run-attempt.json"))) {
      const prior = load<{ instance: string; botId?: string; threadId?: string }>(
        path.join(dir, "run-attempt.json"),
      );
      assert.equal(prior.instance, provision.instance, "New attempt must reuse the allocated VM");
      if (prior.botId) assert.equal(prior.botId, seed.botId, "New attempt must reuse the seed");
      if (prior.threadId)
        assert.equal(prior.threadId, seed.threadId, "New attempt must reuse the product thread");
    }
    const previousArchive = archivePreviousAttempt({
      directory: dir,
      sessionRoot,
      newAttempt: process.argv.includes("--new-attempt"),
      runs,
      attempts,
      databaseSnapshot: { capturedAt: new Date().toISOString(), runs, attempts, events, messages },
    });
    const nonce = `RAKAZO_${randomBytes(16).toString("hex")}`;
    const guestPath = `/tmp/rakazo-acceptance-${randomBytes(8).toString("hex")}.txt`;
    const marker = {
      startedAt: new Date().toISOString(),
      nonce,
      guestPath,
      instance: provision.instance,
      botId: seed.botId,
      threadId: seed.threadId,
      previousArchive,
      runIds: [] as string[],
    };
    save("run-attempt.json", marker);
    receipt = {
      passed: false,
      mode: "real-product",
      startedAt: marker.startedAt,
      vm: provision.instance,
      vmCleanup: "owned-vm-retained-for-operator-cleanup",
      previousArchive,
      runIds: marker.runIds,
      checks: {},
    };
    save("receipt.json", receipt);
    const recordRun = (runId: string) => {
      marker.runIds.push(runId);
      save("run-attempt.json", marker);
      save("receipt.json", receipt);
    };
    browser = await chromium.launch({
      headless: true,
      ...(config.chromiumExecutable ? { executablePath: config.chromiumExecutable } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    // Log in through the browser's real cookie jar, not a mocked product state.
    const login = await context.request.post(`${state.env.WEB_ORIGIN}/api/auth/sign-in/email`, {
      data: { email: seed.email, password: seed.password },
      headers: { origin: state.env.WEB_ORIGIN! },
    });
    assert(login.ok(), "Browser login failed");
    const page = await context.newPage();
    await page.goto(`${state.env.WEB_ORIGIN}/app/${seed.botId}`);
    const consent = await rpc<{
      scope: string;
      version: string;
      recipients: Array<{ key: string; allowed: boolean }>;
    }>(seed.cookie, "aiConsent/status", { botId: seed.botId, uses: ["model"] });
    const keys = consent.recipients.filter((r) => !r.allowed).map((r) => r.key);
    if (keys.length)
      await rpc(seed.cookie, "aiConsent/allow", {
        scope: consent.scope,
        version: consent.version,
        keys,
      });
    const waitRun = async (runId: string) => {
      const deadline = Date.now() + (config.phaseTimeoutMs ?? 600_000);
      while (Date.now() < deadline) {
        const run = await db.prisma.run.findUniqueOrThrow({ where: { id: runId } });
        if (run.status === "completed") return run;
        if (["failed", "cancelled", "waiting_input"].includes(run.status))
          throw new Error(`Run ended or requires operator attention: ${run.status}`);
        await sleep(400);
      }
      throw new Error("Run timeout; inspect durable state before any retry");
    };
    const capture = async (
      name: string,
      runId: string,
      expectedRoot?: string,
      resumed?: boolean,
    ) => {
      const events = await db.prisma.event.findMany({ where: { runId }, orderBy: { seq: "asc" } });
      const messages = await db.prisma.message.findMany({
        where: { threadId: seed.threadId },
        orderBy: { seq: "asc" },
      });
      save(`${name}-events.json`, events);
      save(`${name}-messages.json`, messages);
      const apiMessages = await rpc<{ messages: Array<{ blocks: unknown }> }>(
        seed.cookie,
        "threads/messages",
        { botId: seed.botId },
      );
      save(`${name}-api-messages.json`, apiMessages);
      const tree = requireNativeTree({ events, messages, expectedRoot });
      requireNativeTree({
        events,
        messages: apiMessages.messages,
        expectedRoot: tree.rootThreadId,
      });
      const run = await db.prisma.run.findUniqueOrThrow({
        where: { id: runId },
        include: { attempts: true },
      });
      save(`${name}-run.json`, run);
      const owner = JSON.stringify([seed.spaceId, run.userId, seed.threadId, seed.botId]);
      const session = load<{
        owner: string;
        rootThreadId: string;
        runs: Record<string, { status: string }>;
      }>(path.join(sessionRoot, createHash("sha256").update(owner).digest("hex"), "session.json"));
      assert.equal(session.owner, owner, "Codex session belongs to a different product owner");
      save(`${name}-session.json`, session);
      const checkpoint = requireCompletedCheckpoint({
        events,
        session,
        runId,
        expectedRoot: tree.rootThreadId,
        resumed,
      });
      save(`${name}-checkpoint-proof.json`, checkpoint);
      return tree;
    };
    const treeVisible = async (tree: NativeTree, name: string) => {
      save(
        `${name}-capture.json`,
        await captureNativeTree(page, tree, path.join(dir, `${name}.png`)),
      );
    };
    const first = await rpc<{ runId: string }>(seed.cookie, "threads/send", {
      botId: seed.botId,
      text: nonceTaskPrompt(nonce, guestPath),
      clientNonce: `acceptance-${randomBytes(12).toString("hex")}`,
    });
    recordRun(first.runId);
    await waitRun(first.runId);
    const firstTree = await capture("delegation", first.runId);
    receipt.rootThreadId = firstTree.rootThreadId;
    receipt.childThreadIds = firstTree.childThreadIds;
    receipt.checks.api_worker_durable_native_tree = true;
    receipt.checks.durable_checkpoint_and_session_binding = true;
    receipt.childToolProof = childToolProof(
      sessionRoot,
      firstTree.childThreadIds,
      nonce,
      guestPath,
    );
    receipt.checks.child_completed_mcp_calls = true;
    const bot = await db.prisma.bot.findUniqueOrThrow({
      where: { id: seed.botId },
      include: { computer: true },
    });
    assert.equal(bot.computer?.kind, "incus");
    assert(
      bot.computer?.providerRef?.endsWith(`:${provision.instance}`),
      "Product did not use the allocated VM",
    );
    const readback = () =>
      independent(
        expandReadbackArgv(config.readbackCommand, {
          computerRef: provision.instance,
          path: guestPath,
        }),
      );
    requireReadback(readback(), nonce);
    receipt.checks.external_nonce_readback = true;
    await treeVisible(firstTree, "tree-live");
    await page.reload();
    await treeVisible(firstTree, "tree-refreshed");
    receipt.checks.browser_tree_and_refresh = true;
    execFileSync(
      state.node,
      [path.join(state.repo, "scripts/accept-codex-incus.mjs"), "restart-worker", `--state=${dir}`],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 90_000 },
    );
    const restart = load<{
      before: { pid: number; generation: string };
      after: { pid: number; generation: string };
    }>(path.join(dir, "worker-restart.json"));
    assert(
      restart.before &&
        restart.after &&
        restart.before.pid !== restart.after.pid &&
        restart.before.generation !== restart.after.generation,
    );
    receipt.workerRestart = restart;
    receipt.checks.worker_process_restarted = true;
    const second = await rpc<{ runId: string }>(seed.cookie, "threads/send", {
      botId: seed.botId,
      text: "Continue the same Codex conversation. Recall the exact nonce and file path from the preceding task; do not invent new values or rewrite the file. Read that file with the remote computer tools and report the original nonce, then take a screenshot. Reply RAKAZO_RESUMED_OK when verified.",
      clientNonce: `acceptance-${randomBytes(12).toString("hex")}`,
    });
    recordRun(second.runId);
    await waitRun(second.runId);
    const restored = await capture("restored", second.runId, firstTree.rootThreadId, true);
    requireReadback(readback(), nonce);
    const finalMessages = await db.prisma.message.findMany({
      where: { runId: second.runId, role: "bot" },
    });
    const text = JSON.stringify(finalMessages.map((m) => m.blocks));
    assert(
      text.includes(nonce) && text.includes("RAKAZO_RESUMED_OK"),
      "Restored run did not recall and verify the nonce",
    );
    await page.reload();
    await treeVisible(restored, "tree-after-worker-restart");
    receipt.checks.same_native_thread_after_restart = true;
    receipt.checks.browser_tree_after_restart = true;
    receipt.passed = true;
  } catch (error) {
    if (receipt) {
      receipt.failure = error instanceof Error ? error.message : "Acceptance failed";
      // Stop through the real API; never auto-answer an unexpected approval or replay a turn.
      await rpc(seed.cookie, "threads/stop", { botId: seed.botId }).catch(() => undefined);
    }
    throw error;
  } finally {
    if (receipt) {
      receipt.finishedAt = new Date().toISOString();
      save("receipt.json", receipt);
    }
    await browser?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
  console.log(
    "Real API/worker/native-child/VM/browser/restart checks passed. The owned VM is retained for coordinated cleanup.",
  );
}

/** Post-run browser evidence only: no threads/send, model, worker restart, or VM operation. */
async function captureTreeOnly() {
  assert.equal(state.mode, "live");
  assert(
    state.services.api && state.services.web && state.config,
    "Capture needs existing API/web services",
  );
  const receipt = load<{ finishedAt?: string; rootThreadId?: string; runIds?: string[] }>(
    path.join(dir, "receipt.json"),
  );
  assert(
    receipt.finishedAt && receipt.rootThreadId && receipt.runIds?.length,
    "Wait for the current acceptance run to finish before recapture",
  );
  const config = load<Config>(state.config);
  const seed = load<Seed>(path.join(dir, "seed.json"));
  const db = createDb(state.env.DATABASE_URL!);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const runs = await db.prisma.run.findMany({
      where: { threadId: seed.threadId },
      include: { attempts: true },
    });
    assertTerminalRuns(
      runs,
      runs.flatMap((run) => run.attempts),
    );
    const events = await db.prisma.event.findMany({
      where: { threadId: seed.threadId, runId: { in: receipt.runIds } },
      orderBy: { seq: "asc" },
    });
    const messages = await db.prisma.message.findMany({
      where: { threadId: seed.threadId },
      orderBy: { seq: "asc" },
    });
    const tree = requireNativeTree({ events, messages, expectedRoot: receipt.rootThreadId });
    const apiMessages = await rpc<{ messages: Array<{ blocks: unknown }> }>(
      seed.cookie,
      "threads/messages",
      { botId: seed.botId },
    );
    requireNativeTree({ events, messages: apiMessages.messages, expectedRoot: tree.rootThreadId });
    const captureDir = path.join(
      dir,
      "browser-recaptures",
      `${new Date().toISOString().replaceAll(":", "-")}-${randomBytes(4).toString("hex")}`,
    );
    mkdirSync(captureDir, { recursive: true, mode: 0o700 });
    const store = (name: string, value: unknown) =>
      writeFileSync(path.join(captureDir, name), `${JSON.stringify(value, null, 2)}\n`, {
        mode: 0o600,
      });
    store("events.json", events);
    store("api-messages.json", apiMessages);
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
    const initial = await captureNativeTree(page, tree, path.join(captureDir, "tree.png"));
    await page.reload();
    const refreshed = await captureNativeTree(
      page,
      tree,
      path.join(captureDir, "tree-refreshed.png"),
    );
    store("receipt.json", {
      passed: true,
      scope: "browser-recapture-only",
      capturedAt: new Date().toISOString(),
      sourceRunIds: receipt.runIds,
      modelCalls: 0,
      originalReceiptUnchanged: true,
      initial,
      refreshed,
    });
    console.log(`Browser tree evidence saved: ${captureDir}`);
  } finally {
    await browser?.close();
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}

const command = process.argv[2];
if (command === "seed") await seed();
else if (command === "connect-model") await connectModel();
else if (command === "run") await run();
else if (command === "capture-tree") await captureTreeOnly();
else throw new Error("Expected seed, connect-model, run or capture-tree");
