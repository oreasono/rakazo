#!/usr/bin/env node
/** Isolated product acceptance. No shared .env, database, runtime home or VM is reused. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "..");
const [command = "help", ...args] = process.argv.slice(2);
const arg = (name) => args.find((v) => v.startsWith(`--${name}=`))?.slice(name.length + 3);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = (file) => JSON.parse(readFileSync(file, "utf8"));
const save = (file, value) =>
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const bareEnv = () =>
  Object.fromEntries(
    ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SYSTEMROOT"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
const secret = () => randomBytes(32).toString("hex");
const port = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const p = server.address().port;
      server.close(() => resolve(p));
    });
  });
function state() {
  if (!arg("state")) throw new Error("Pass --state=<private acceptance directory>");
  const dir = path.resolve(arg("state"));
  const result = json(path.join(dir, "state.json"));
  if (result.kind !== "rakazo-codex-incus-acceptance" || result.directory !== dir)
    throw new Error("Not an owned acceptance directory");
  const db = new URL(result.env.DATABASE_URL);
  if (db.hostname !== "127.0.0.1" || db.pathname !== "/acceptance")
    throw new Error("Refusing a non-isolated database");
  return result;
}
function privateLog(s, name, executable, argv, env = s.env, timeout = 120_000) {
  const fd = openSync(path.join(s.directory, `${name}.log`), "a", 0o600);
  try {
    return execFileSync(executable, argv, { cwd: repo, env, stdio: ["ignore", fd, fd], timeout });
  } catch {
    throw new Error(`${name} failed; inspect its private log`);
  } finally {
    closeSync(fd);
  }
}
function liveEnv(s) {
  const config = s.config ? json(s.config) : {};
  const extra = config.env ?? {};
  // Connection, isolation, auth and queue ownership are set only by this launcher.
  for (const key of Object.keys(extra)) {
    if (
      /^(DATABASE_URL|REALTIME_DATABASE_URL|DATA_DIR|CODEX_HOME|HOME|NODE_OPTIONS|NODE_ENV|WAKEUP_DRIVER|API_|WEB_|BETTER_AUTH_|ENCRYPTION_KEY|SCREEN_PROXY_SECRET|AGENT_RUNTIME|SANDBOX_PROVIDER)/.test(
        key,
      )
    )
      throw new Error(`Reserved configuration key: ${key}`);
    if (typeof extra[key] !== "string") throw new Error("Config env values must be strings");
  }
  const env = {
    ...s.env,
    ...extra,
    // This gate tests turn-boundary recovery; idle workspace backup/sleep is a separate gate.
    // Apply after private config so existing state directories also keep the VM awake.
    SANDBOX_IDLE_MS: "0",
    AGENT_RUNTIME: s.mode === "live" ? "codex" : "scripted",
    SANDBOX_PROVIDER: s.mode === "live" ? "incus" : "fake",
  };
  if (s.mode === "live" && config.modelKeyCommand && config.modelKeyEnv) {
    if (
      !Array.isArray(config.modelKeyCommand) ||
      !config.modelKeyCommand.length ||
      !config.modelKeyCommand.every((v) => typeof v === "string")
    )
      throw new Error("modelKeyCommand must be an argv array");
    let key;
    try {
      key = execFileSync(config.modelKeyCommand[0], config.modelKeyCommand.slice(1), {
        env: bareEnv(),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 15_000,
      }).trim();
    } catch {
      throw new Error("Model credential retrieval failed (output suppressed)");
    }
    if (!key) throw new Error("Model credential retrieval returned no value");
    const keyEnv = config.modelKeyEnv ?? "MODEL_API_KEY";
    if (!/^[A-Z][A-Z0-9_]*KEY$/.test(keyEnv)) throw new Error("Invalid modelKeyEnv");
    env[keyEnv] = key;
  }
  return env;
}
function persist(s) {
  save(path.join(s.directory, "state.json"), s);
}
async function prepare() {
  if (arg("state"))
    throw new Error("prepare always creates a new private directory; do not supply --state");
  const directory = mkdtempSync(path.join(tmpdir(), "rakazo-codex-incus-"));
  const pgBin =
    arg("pg-bin") ?? path.dirname(execFileSync("which", ["initdb"], { encoding: "utf8" }).trim());
  const [pgPort, apiPort, webPort] = await Promise.all([port(), port(), port()]);
  const pgPassword = secret();
  const env = {
    ...bareEnv(),
    NODE_ENV: "test",
    CI: "1",
    NO_COLOR: "1",
    NODE_OPTIONS: "--conditions=development",
    DATABASE_URL: `postgres://acceptance:${pgPassword}@127.0.0.1:${pgPort}/acceptance`,
    REALTIME_DATABASE_URL: `postgres://acceptance:${pgPassword}@127.0.0.1:${pgPort}/acceptance`,
    DATA_DIR: path.join(directory, "data"),
    CODEX_HOME: path.join(directory, "codex-home"),
    BETTER_AUTH_SECRET: secret(),
    ENCRYPTION_KEY: secret(),
    SCREEN_PROXY_SECRET: secret(),
    BETTER_AUTH_URL: `http://127.0.0.1:${webPort}`,
    WEB_ORIGIN: `http://127.0.0.1:${webPort}`,
    API_HOST: "127.0.0.1",
    API_PORT: String(apiPort),
    API_URL: `http://127.0.0.1:${apiPort}`,
    API_PROXY_TARGET: `http://127.0.0.1:${apiPort}`,
    WEB_PORT: String(webPort),
    VITE_DEFAULT_UI_LOCALE: "en",
    WAKEUP_DRIVER: "graphile",
    SANDBOX_IDLE_MS: "0",
    CLOUD_AGENT_PROVIDER: "none",
    SECRET_STORE: "encrypted",
    EMAIL_EMULATOR: "true",
    SIGNUPS_ENABLED: "true",
    SIGNUP_ALLOWLIST: "",
    AUTH_PASSWORD_ENABLED: "true",
    DB_POOL_MAX: "8",
  };
  const s = {
    kind: "rakazo-codex-incus-acceptance",
    id: randomUUID(),
    directory,
    pgBin,
    node: process.execPath,
    repo,
    mode: "offline",
    env,
    services: {},
    createdAt: new Date().toISOString(),
  };
  persist(s);
  for (const dir of ["data", "codex-home", "socket"])
    mkdirSync(path.join(directory, dir), { mode: 0o700 });
  const pwfile = path.join(directory, "pg-password");
  writeFileSync(pwfile, pgPassword, { mode: 0o600 });
  try {
    privateLog(s, "initdb", path.join(pgBin, "initdb"), [
      "-D",
      path.join(directory, "pg"),
      "-U",
      "acceptance",
      "--auth=scram-sha-256",
      `--pwfile=${pwfile}`,
      "--encoding=UTF8",
      "--locale=C",
    ]);
  } finally {
    unlinkSync(pwfile);
  }
  const socket = path.join(directory, "socket").replaceAll("'", "''");
  writeFileSync(
    path.join(directory, "pg", "postgresql.conf"),
    `\nlisten_addresses = '127.0.0.1'\nport = ${pgPort}\nunix_socket_directories = '${socket}'\nmax_connections = 50\n`,
    { flag: "a" },
  );
  privateLog(s, "pg-start", path.join(pgBin, "pg_ctl"), [
    "-D",
    path.join(directory, "pg"),
    "-l",
    path.join(directory, "postgres.log"),
    "-w",
    "start",
  ]);
  privateLog(
    s,
    "createdb",
    path.join(pgBin, "createdb"),
    ["-h", "127.0.0.1", "-p", String(pgPort), "-U", "acceptance", "acceptance"],
    { ...env, PGPASSWORD: pgPassword },
  );
  console.log(
    JSON.stringify({
      state: directory,
      pg: "ready",
      api: env.API_URL,
      web: env.WEB_ORIGIN,
      liveExecution: false,
    }),
  );
}
function ownedProcess(s, info) {
  if (!info) return false;
  try {
    const argv = execFileSync("ps", ["-p", String(info.pid), "-o", "command="], {
      encoding: "utf8",
    });
    return (
      argv.includes(script) && argv.includes(`--state=${s.directory}`) && argv.includes(" service ")
    );
  } catch {
    return false;
  }
}
async function stopService(s, name) {
  const info = s.services[name];
  if (!info) return;
  if (ownedProcess(s, info)) {
    process.kill(-info.pid, "SIGTERM");
    for (let i = 0; i < 150 && ownedProcess(s, info); i++) await sleep(200);
    if (ownedProcess(s, info))
      throw new Error(`${name} did not shut down; left intact for inspection`);
  }
  delete s.services[name];
  persist(s);
}
async function startService(s, name) {
  if (!["api", "worker", "web"].includes(name)) throw new Error("Unknown service");
  if (ownedProcess(s, s.services[name])) throw new Error(`${name} is already running`);
  const fd = openSync(path.join(s.directory, `${name}.log`), "a", 0o600);
  const proc = spawn(s.node, [script, "service", `--state=${s.directory}`, `--name=${name}`], {
    cwd: repo,
    detached: true,
    env: bareEnv(),
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  proc.unref();
  s.services[name] = {
    pid: proc.pid,
    generation: randomUUID(),
    startedAt: new Date().toISOString(),
  };
  persist(s);
  const url =
    name === "api" ? `${s.env.API_URL}/health` : name === "web" ? `${s.env.WEB_ORIGIN}/` : null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await sleep(300);
    if (!ownedProcess(s, s.services[name]))
      throw new Error(`${name} exited; inspect its private log`);
    if (
      !url ||
      (await fetch(url, { signal: AbortSignal.timeout(2000) })
        .then((r) => r.ok)
        .catch(() => false))
    )
      return;
  }
  throw new Error(`${name} health timeout; inspect its private log`);
}
async function service() {
  const s = state(),
    name = arg("name"),
    env = liveEnv(s);
  const entry =
    name === "web"
      ? path.join(repo, "apps/web/node_modules/vite/bin/vite.js")
      : path.join(repo, `apps/${name}/src/index.ts`);
  const argv =
    name === "web"
      ? [entry, "--host", "127.0.0.1", "--port", s.env.WEB_PORT, "--strictPort"]
      : ["--import", path.join(repo, "node_modules/tsx/dist/loader.mjs"), entry];
  const child = spawn(s.node, argv, {
    cwd: path.join(repo, `apps/${name}`),
    env,
    stdio: "inherit",
  });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  child.once("error", () => process.exit(1));
  child.once("exit", (code) => process.exit(code ?? 1));
}
async function main() {
  if (command === "prepare") return prepare();
  if (command === "service") return service();
  if (command === "help") {
    console.log(
      "prepare [--pg-bin=<bin>] | migrate | start [--offline | --allow-live --config=<private.json>] [--services=api,web] | seed | connect-model --allow-live | run --allow-live [--new-attempt] | capture-tree --allow-live | restart-worker | status | stop; all but prepare require --state=<private dir>. See accept-codex-incus.md.",
    );
    return;
  }
  const s = state();
  s.node = process.execPath;
  s.env.PATH = `${path.dirname(process.execPath)}${path.delimiter}${s.env.PATH}`;
  persist(s);
  if (command === "migrate") {
    privateLog(s, "generate", "pnpm", ["--filter", "@rakazo/db", "generate"]);
    privateLog(s, "migrate", "pnpm", [
      "--filter",
      "@rakazo/db",
      "exec",
      "prisma",
      "migrate",
      "deploy",
    ]);
    console.log("Isolated database generated and migrated.");
    return;
  }
  if (command === "start") {
    if (!args.includes("--offline") && !args.includes("--allow-live"))
      throw new Error("Choose --offline or explicitly opt in with --allow-live");
    if (Object.keys(s.services).some((name) => ownedProcess(s, s.services[name])))
      throw new Error("Stop existing services before changing their mode/config");
    s.mode = args.includes("--offline") ? "offline" : "live";
    s.config = s.mode === "live" ? path.resolve(arg("config") ?? "") : undefined;
    if (s.mode === "live" && (!arg("config") || !existsSync(s.config)))
      throw new Error("Live start requires --config=<private JSON>");
    persist(s);
    try {
      for (const name of (arg("services") ?? "api,web").split(",")) await startService(s, name);
    } catch (err) {
      for (const name of Object.keys(s.services).reverse()) await stopService(s, name);
      throw err;
    }
    console.log(
      JSON.stringify({
        mode: s.mode,
        api: s.env.API_URL,
        web: s.env.WEB_ORIGIN,
        services: Object.keys(s.services),
        liveAcceptance: "not-run",
      }),
    );
    return;
  }
  if (command === "restart-worker") {
    if (s.mode !== "live") throw new Error("Worker restart acceptance requires live mode");
    const before = s.services.worker;
    await stopService(s, "worker");
    await startService(s, "worker");
    save(path.join(s.directory, "worker-restart.json"), { before, after: s.services.worker });
    console.log("Acceptance worker restarted; private restart receipt saved.");
    return;
  }
  if (["seed", "connect-model", "run", "capture-tree"].includes(command)) {
    if (command !== "seed" && (s.mode !== "live" || !args.includes("--allow-live")))
      throw new Error("Real acceptance needs live services and --allow-live");
    privateLog(
      s,
      command,
      s.node,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, "packages/testkit/src/codex-incus-acceptance.ts"),
        command,
        `--state=${s.directory}`,
        ...(command === "run" && args.includes("--new-attempt") ? ["--new-attempt"] : []),
      ],
      { ...s.env, RAKAZO_ACCEPTANCE_STATE: s.directory },
      1_800_000,
    );
    console.log(`${command} completed; private receipt saved.`);
    return;
  }
  if (command === "status") {
    console.log(
      JSON.stringify({
        mode: s.mode,
        api: s.env.API_URL,
        web: s.env.WEB_ORIGIN,
        services: Object.fromEntries(
          Object.entries(s.services).map(([name, info]) => [
            name,
            { ...info, alive: ownedProcess(s, info) },
          ]),
        ),
      }),
    );
    return;
  }
  if (command === "stop") {
    for (const name of ["worker", "web", "api"]) await stopService(s, name);
    if (!args.includes("--keep-pg"))
      privateLog(s, "pg-stop", path.join(s.pgBin, "pg_ctl"), [
        "-D",
        path.join(s.directory, "pg"),
        "-m",
        "fast",
        "-w",
        "stop",
      ]);
    console.log(
      "Owned services stopped; private data retained. VM cleanup is separate and must be verified.",
    );
    return;
  }
  throw new Error("Unknown command; use help");
}
await main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
