/** Probe the installed app-server without running a model turn or a voice call. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const binary = process.argv[2] || "codex";
const root = await mkdtemp(join(tmpdir(), "rakazo-codex-probe-"));
const env = Object.fromEntries(
  ["PATH", "SYSTEMROOT", "LANG", "TMPDIR"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, { HOME: root, CODEX_HOME: join(root, "codex") });
const pending = new Map();
let child;
let lines;
let nextId = 0;
let dead = false;

function run(args) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  // Never echo arbitrary subprocess diagnostics or account paths in receipts.
  assert.equal(result.error, undefined, "Could not run Codex probe command");
  assert.equal(result.status, 0, "Codex probe command failed");
  return result.stdout.trim();
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    }
  }
}

async function schema(dir, name) {
  const path = await findFile(dir, `${name}.json`);
  assert.ok(path, `Missing schema: ${name}`);
  return JSON.parse(await readFile(path, "utf8"));
}

function methodNames(value, methods = new Set()) {
  if (!value || typeof value !== "object") return methods;
  for (const name of value.properties?.method?.enum ?? []) methods.add(name);
  for (const nested of Object.values(value)) methodNames(nested, methods);
  return methods;
}

function failPending() {
  dead = true;
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(new Error("App-server connection closed"));
  }
  pending.clear();
}

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  if (dead) return Promise.reject(new Error("App-server connection closed"));
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer, method });
    send({ id, method, params });
  });
}

try {
  await mkdir(env.CODEX_HOME);
  // Empty account/config home and a loopback-only model provider. No turn/start
  // or realtime/start is sent, so no inference, microphone or audio is used.
  await writeFile(
    join(env.CODEX_HOME, "config.toml"),
    'model = "capability-probe"\nmodel_provider = "probe"\n' +
      '[model_providers.probe]\nname = "Offline probe"\n' +
      'base_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n' +
      "requires_openai_auth = false\nsupports_websockets = false\n",
    { mode: 0o600 },
  );
  const versionOutput = run(["--version"]);
  const version = versionOutput.match(/codex-cli\s+([0-9][\w.+-]*)/)?.[1];
  assert.ok(version, "Unrecognized Codex version output");
  const schemaDir = join(root, "schemas");
  run(["app-server", "generate-json-schema", "--experimental", "--out", schemaDir]);
  const methods = methodNames(await schema(schemaDir, "ClientRequest"));
  const notifications = methodNames(await schema(schemaDir, "ServerNotification"));
  const required = [
    "thread/start",
    "thread/resume",
    "thread/fork",
    "turn/start",
    "turn/interrupt",
    "thread/realtime/start",
    "thread/realtime/appendAudio",
    "thread/realtime/appendText",
    "thread/realtime/stop",
    "thread/realtime/listVoices",
  ];
  for (const method of required) assert.ok(methods.has(method), `Missing method: ${method}`);
  const realtime = await schema(schemaDir, "ThreadRealtimeStartParams");
  const transports =
    realtime.definitions?.ThreadRealtimeStartTransport?.oneOf?.flatMap(
      (variant) => variant.properties?.type?.enum ?? [],
    ) ?? [];
  assert.ok(transports.includes("websocket"), "Missing websocket realtime transport");
  assert.ok(transports.includes("webrtc"), "Missing WebRTC realtime transport");

  child = spawn(binary, ["app-server", "--listen", "stdio://"], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "ignore"],
  });
  child.on("error", failPending);
  child.on("exit", failPending);
  child.stdin.on("error", failPending);
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failPending();
      return;
    }
    if (message.method) {
      if (message.id !== undefined) {
        // This probe cannot authorize tools, commands, or approvals.
        send({ id: message.id, error: { code: -32601, message: "Probe does not execute tools" } });
      }
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`Rejected: ${entry.method} (${message.error.code})`));
    else entry.resolve(message.result);
  });
  await request("initialize", {
    clientInfo: { name: "rakazo_codex_probe", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });
  const params = { cwd: root, sandbox: "read-only", approvalPolicy: "untrusted", environments: [] };
  const first = await request("thread/start", params);
  const second = await request("thread/start", params);
  assert.ok(first.thread?.id && second.thread?.id, "Missing thread IDs");
  assert.notEqual(first.thread.id, second.thread.id);
  const voices = await request("thread/realtime/listVoices", {});
  assert.ok(
    voices?.voices?.v1?.length && voices?.voices?.v2?.length,
    "Missing voice catalog entries",
  );
  console.log(
    JSON.stringify(
      {
        version,
        passed: true,
        protocol: {
          methods: required,
          realtimeTransports: transports,
          realtimeNotifications: [...notifications].filter((name) =>
            name.startsWith("thread/realtime/"),
          ),
        },
        exercised: { initialize: true, twoIndependentThreads: true, listVoices: true },
        notExercised: [
          "modelTurn",
          "nativeSubagent",
          "persistedResume",
          "threadFork",
          "browserUse",
          "computerUse",
          "liveVoice",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  lines?.close();
  failPending();
  if (child && child.exitCode === null && child.signalCode === null && child.pid) {
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
  await rm(root, { recursive: true, force: true });
}
