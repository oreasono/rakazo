import { execFileSync, spawn } from "node:child_process";
import {
  chmod,
  chown,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { IncusSandboxProvider } from "./incus-sandbox.js";
import { INCUS_DURABLE_EXEC_SCRIPT } from "./incus-sandbox-durable.js";
import type { IncusProcessRequest } from "./incus-sandbox-process.js";
import { runIncusProcess } from "./incus-sandbox-process.js";

const python = "/usr/bin/python3";
const identity = {
  project: "test-project",
  remote: "",
  instance: "test-desktop",
  computerId: "incus:test-project:local:test-desktop",
  spaceId: "test-space",
  botId: "test-home",
  ownerBotId: "test-owner",
};
const context: AdapterContext = {
  operationId: "context-is-not-an-execution-id",
  traceId: "test-trace",
  spaceId: identity.spaceId,
  userId: "test-user",
  botId: identity.ownerBotId,
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: identity.computerId,
  providerRef: identity.computerId,
  botId: identity.botId,
  kind: "incus",
};

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0).reverse()) await clean();
});

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 6000;
  while (true) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(value)}`);
    await delay(10);
  }
}

async function exists(file: string): Promise<boolean> {
  return readFile(file).then(
    () => true,
    () => false,
  );
}

async function events(stream: AsyncIterable<ProcessEvent>): Promise<ProcessEvent[]> {
  const result: ProcessEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

async function fixture() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "incus-receipts-")));
  const guest = path.join(base, "guest");
  await chmod(base, 0o755);
  await mkdir(guest, { mode: 0o700 });
  const root = process.getuid!() === 0;
  const account: { username: string; uid: number; gid: number } = root
    ? JSON.parse(
        execFileSync(python, [
          "-I",
          "-c",
          "import json,pwd; p=pwd.getpwnam('nobody'); print(json.dumps(dict(username=p.pw_name,uid=p.pw_uid,gid=p.pw_gid)))",
        ]).toString(),
      )
    : os.userInfo();
  if (root) await chown(guest, account.uid, account.gid);
  // Non-root macOS emulates only the privileged filesystem anchor and initgroups.
  // The journal/locking/fork/fsync/timeout/transport code runs in real processes.
  // Root Linux runs actual credential demotion to nobody. No production bypass exists.
  let script = INCUS_DURABLE_EXEC_SCRIPT.replace("ROOT_UID = 0", `ROOT_UID = ${process.getuid!()}`)
    .replace(
      "fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)",
      `fd = os.open(${JSON.stringify(base)}, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)`,
    )
    .replace("for part in JOURNAL_ROOT.strip('/').split('/'):", "for part in ('journal',):");
  if (!root)
    script = script.replace(
      "os.initgroups(account.pw_name, account.pw_gid)",
      "assert account.pw_uid == os.getuid() and account.pw_gid == os.getgid()",
    );
  const scriptFile = path.join(base, "receiver.py");
  await writeFile(scriptFile, script, { mode: 0o600 });
  const children = new Set<ReturnType<typeof spawn>>();
  const start = (payload: unknown, source = scriptFile, keepOpen = false) => {
    const child = spawn(python, ["-I", "-u", source], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => undefined);
    const done = new Promise<{ stdout: string; stderr: string; code: number | null }>(
      (resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
          children.delete(child);
          resolve({ stdout, stderr, code });
        });
      },
    );
    if (keepOpen) child.stdin.write(`${JSON.stringify(payload)}\n`);
    else child.stdin.end(`${JSON.stringify(payload)}\n`);
    return { child, done };
  };
  const invoke = async (payload: unknown) => {
    const reply = await start(payload).done;
    if (reply.code !== 0) throw new Error(reply.stderr);
    return JSON.parse(reply.stdout);
  };
  const request = (code: string, operationId = "test-operation", overrides = {}) => ({
    op: "execute",
    operationId,
    identity,
    command: {
      argv: [python, "-c", code],
      root: guest,
      cwd: "",
      env: {},
      unsetEnv: [],
      guestUser: account.username,
      display: ":1",
      timeoutMs: 3000,
      maxOutputBytes: 4096,
      ...overrides,
    },
  });
  const query = (operationId = "test-operation", scope = identity) =>
    invoke({ op: "query", operationId, identity: scope });
  const operationDirectory = async () => {
    const journal = path.join(base, "journal");
    const scope = path.join(journal, (await readdir(journal))[0]!);
    return path.join(scope, (await readdir(scope))[0]!);
  };
  const providerCalls: IncusProcessRequest[] = [];
  const provider = (maxOutputBytes = 4096) =>
    new IncusSandboxProvider({
      project: identity.project,
      guestUser: account.username,
      instances: [
        {
          instance: identity.instance,
          spaceId: identity.spaceId,
          botId: identity.botId,
          ownerBotId: identity.ownerBotId,
          workspacePath: guest,
        },
      ],
      maxOutputBytes,
      runner: async function* (call) {
        providerCalls.push(call);
        yield* runIncusProcess({ ...call, argv: [python, "-I", "-u", scriptFile] });
      },
    });
  cleanup.push(async () => {
    for (const child of children) child.kill("SIGKILL");
    await rm(base, { recursive: true, force: true });
  });
  return {
    base,
    guest,
    script,
    scriptFile,
    account,
    start,
    invoke,
    request,
    query,
    operationDirectory,
    provider,
    providerCalls,
  };
}

describe("durable Incus guest execution (real local Python subprocesses)", () => {
  it("replays a completed receipt once, including stderr, Unicode and nonzero exit", async () => {
    const f = await fixture();
    const request = f.request(
      "import sys; open('effects','a').write('once\\n'); print('hello 世界'); print('warning',file=sys.stderr); sys.exit(7)",
    );
    const expected = {
      status: "completed",
      result: { stdout: "hello 世界\n", stderr: "warning\n", code: 7 },
    };
    expect(await f.invoke(request)).toEqual(expected);
    expect(await f.invoke(request)).toEqual(expected);
    expect(await f.query()).toEqual(expected);
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
    const directory = await f.operationDirectory();
    expect((await readdir(directory)).sort()).toEqual(["lock", "result.json", "started.json"]);
  });

  it("redacts only the supplied environment's plain, URL and base64 values before persisting", async () => {
    const f = await fixture();
    const value = "fake-secret:/+ 世界 !~*'()%";
    const request = f.request(
      "import base64,os,sys,time,urllib.parse; value=os.environ['TOKEN']; sys.stdout.write(value[:5]); sys.stdout.flush(); time.sleep(.02); print(value[5:]); print(urllib.parse.quote(value,safe=\"-_.!~*'()\")); print(base64.b64encode(value.encode()).decode(),file=sys.stderr); print('ordinary output',file=sys.stderr)",
      "test-operation",
      { env: { TOKEN: value, EMPTY: "" } },
    );
    const expected = {
      status: "completed",
      result: {
        stdout: "[redacted]\n[redacted]\n",
        stderr: "[redacted]\nordinary output\n",
        code: 0,
      },
    };
    expect(await f.invoke(request)).toEqual(expected);
    expect(await f.query()).toEqual(expected);
    const directory = await f.operationDirectory();
    for (const name of await readdir(directory)) {
      const saved = await readFile(path.join(directory, name), "utf8");
      for (const form of [
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString("base64"),
      ]) {
        expect(saved).not.toContain(form);
        expect(saved).not.toContain(JSON.stringify(form).slice(1, -1));
      }
    }
  });

  it("redacts overlapping values across stdout and stderr without leaking the uncovered suffix", async () => {
    const f = await fixture();
    const request = f.request(
      "import sys; sys.stdout.write('ok:abc'); sys.stderr.write('defghi:done')",
      "test-operation",
      { env: { FIRST: "abcdef", SECOND: "defghi" } },
    );
    expect(await f.invoke(request)).toEqual({
      status: "completed",
      result: { stdout: "ok:[redacted]", stderr: ":done", code: 0 },
    });
  });

  it("keeps both output bounds and the reservation when short-value redactions would expand too far", async () => {
    const f = await fixture();
    const request = f.request(
      "import os; open('effects','a').write('once\\n'); print(os.environ['SHORT'] * 8)",
      "test-operation",
      { env: { SHORT: "x" }, maxOutputBytes: 16 },
    );
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await exists(path.join(await f.operationDirectory(), "result.json"))).toBe(false);
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it("withholds an old unmarked receipt without redispatching its reserved operation", async () => {
    const f = await fixture();
    const request = f.request("open('effects','a').write('once\\n'); print('original')");
    await f.invoke(request);
    const file = path.join(await f.operationDirectory(), "result.json");
    const legacy = JSON.parse(await readFile(file, "utf8"));
    delete legacy.redactionVersion;
    legacy.result.stdout = "fake-old-credential";
    await writeFile(file, JSON.stringify(legacy));
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it("reports inflight duplicates and rejects changed commands without a second execution", async () => {
    const f = await fixture();
    const request = f.request(
      "import os,time; open('effects','a').write('once\\n');\nwhile not os.path.exists('release'): time.sleep(.01)\nprint('done')",
    );
    const running = f.start(request);
    await until(() => exists(path.join(f.guest, "effects")), Boolean);
    expect(await f.query()).toEqual({ status: "pending" });
    expect(await f.invoke(request)).toEqual({ status: "pending" });
    await expect(f.invoke(f.request("print('different')"))).rejects.toThrow("command mismatch");
    await writeFile(path.join(f.guest, "release"), "release");
    expect((await running.done).code).toBe(0);
    expect(await f.invoke(request)).toMatchObject({ status: "completed" });
    await expect(f.invoke(f.request("print('different')"))).rejects.toThrow("command mismatch");
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it("survives controller SIGKILL, eventual pipe EOF and receiver death after the effect", async () => {
    const f = await fixture();
    const oldValue = "fake-credential-before-controller-crash";
    const request = f.request(
      "import os,time; open('effects','a').write('once\\n'); time.sleep(.8); print(os.environ['TOKEN'])",
      "test-operation",
      { env: { TOKEN: oldValue } },
    );
    const controller = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import {spawn} from 'node:child_process';
         import {readFileSync} from 'node:fs';
         const child=spawn(${JSON.stringify(python)}, ['-I','-u',process.argv[1]], {stdio:['pipe','pipe','pipe']});
         child.stdin.write(readFileSync(0));
         process.stdout.write(String(child.pid)+'\\n');
         setInterval(()=>{},1000);`,
        f.scriptFile,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const receiverPid = new Promise<number>((resolve) => {
      controller.stdout.once("data", (data) => resolve(Number(data.toString().trim())));
    });
    const controllerClosed = new Promise<void>((resolve) =>
      controller.once("close", () => resolve()),
    );
    cleanup.push(async () => {
      controller.kill("SIGKILL");
      await controllerClosed;
    });
    controller.stdin.end(`${JSON.stringify(request)}\n`);
    const receiver = await receiverPid;
    await until(() => exists(path.join(f.guest, "effects")), Boolean);
    expect(await f.query()).toEqual({ status: "pending" });
    controller.kill("SIGKILL");
    await controllerClosed;
    // Model the transport receiver being torn down after losing its controller.
    process.kill(receiver, "SIGKILL");
    const receipt = await until(
      () => f.query(),
      (reply) => reply.status === "completed",
    );
    // Query carries no environment: recovery stays redacted even after rotation.
    expect(receipt.result).toEqual({ stdout: "[redacted]\n", stderr: "", code: 0 });
    expect(await f.invoke(request)).toEqual(receipt);
    await expect(
      f.invoke({
        ...request,
        command: { ...request.command, env: { TOKEN: "fake-rotated-value" } },
      }),
    ).rejects.toThrow("command mismatch");
    expect(
      await readFile(path.join(await f.operationDirectory(), "result.json"), "utf8"),
    ).not.toContain(oldValue);
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it("never redispatches a durable start whose receiver died before dispatch", async () => {
    const f = await fixture();
    const fault = path.join(f.base, "before-dispatch.py");
    await writeFile(fault, f.script.replace("child = os.fork()", "os._exit(97)"));
    const request = f.request("open('effects','a').write('must not run')");
    expect((await f.start(request, fault).done).code).toBe(97);
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await exists(path.join(f.guest, "effects"))).toBe(false);
  });

  it("never dispatches if the reservation fsync fails", async () => {
    const f = await fixture();
    const fault = path.join(f.base, "sync-failure.py");
    await writeFile(
      fault,
      f.script.replace("os.fsync(lock)", "raise OSError('test fsync failure')"),
    );
    const request = f.request("open('effects','a').write('must not run')");
    expect((await f.start(request, fault).done).code).toBe(1);
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await exists(path.join(f.guest, "effects"))).toBe(false);
  });

  it("seals a completed receipt after the writer dies between rename and directory fsync", async () => {
    const f = await fixture();
    const fault = path.join(f.base, "after-rename.py");
    await writeFile(
      fault,
      f.script.replace(
        "os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)",
        "os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)\n        if name == 'result.json':\n            os._exit(98)",
      ),
    );
    const request = f.request("open('effects','a').write('once\\n'); print('persisted')");
    expect(JSON.parse((await f.start(request, fault).done).stdout)).toMatchObject({
      status: "completed",
      result: { stdout: "persisted\n" },
    });
    expect(await f.invoke(request)).toMatchObject({ status: "completed" });
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it.each(["before", "after"])(
    "stores only redacted output %s rename and stays pending while locked",
    async (when) => {
      const f = await fixture();
      const fault = path.join(f.base, "before-result-sync.py");
      const renamed = path.join(f.base, "renamed");
      const release = path.join(f.base, "release-sync");
      const rename = "os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)";
      const pause = `if name == 'result.json':
            open(${JSON.stringify(renamed)}, 'w').close()
            while not os.path.exists(${JSON.stringify(release)}):
                time.sleep(.01)`;
      await writeFile(
        fault,
        f.script.replace(
          rename,
          when === "before" ? `${pause}\n        ${rename}` : `${rename}\n        ${pause}`,
        ),
      );
      const value = "fake-credential-for-atomic-output";
      const request = f.request("import os; print(os.environ['TOKEN'])", "test-operation", {
        env: { TOKEN: value },
      });
      const running = f.start(request, fault);
      await until(() => exists(renamed), Boolean);
      expect(await f.query()).toEqual({ status: "pending" });
      expect(await f.invoke(request)).toEqual({ status: "pending" });
      const directory = await f.operationDirectory();
      const name =
        when === "after"
          ? "result.json"
          : (await readdir(directory)).find((name) => name.startsWith(".write-"))!;
      const saved = await readFile(path.join(directory, name), "utf8");
      expect(saved).not.toContain(value);
      expect(JSON.parse(saved)).toMatchObject({
        redactionVersion: 1,
        result: { stdout: "[redacted]\n", stderr: "", code: 0 },
      });
      await writeFile(release, "yes");
      expect(JSON.parse((await running.done).stdout)).toEqual({
        status: "completed",
        result: { stdout: "[redacted]\n", stderr: "", code: 0 },
      });
    },
  );

  it("reports unknown after the supervisor dies after an effect and refuses replay", async () => {
    const f = await fixture();
    const request = f.request(
      "import os,time; open('pids','w').write(str(os.getpid())+' '+str(os.getppid())); open('effects','a').write('once\\n'); time.sleep(2)",
    );
    const running = f.start(request);
    await until(() => exists(path.join(f.guest, "effects")), Boolean);
    const [child, supervisor] = (await readFile(path.join(f.guest, "pids"), "utf8"))
      .split(" ")
      .map(Number);
    process.kill(supervisor!, "SIGKILL");
    process.kill(-child!, "SIGKILL");
    expect(JSON.parse((await running.done).stdout)).toEqual({ status: "unknown" });
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it.each([
    ["timeout", "import time; print('partial',flush=True); time.sleep(1)", { timeoutMs: 100 }],
    ["output overflow", "print('x'*20000)", { maxOutputBytes: 32 }],
    ["signal termination", "import os,signal; os.kill(os.getpid(),signal.SIGTERM)", {}],
  ])("withholds partial receipts on %s and never repeats them", async (_name, code, overrides) => {
    const f = await fixture();
    const request = f.request(
      `open('effects','a').write('once\\n'); ${code}`,
      "test-operation",
      overrides,
    );
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
    expect(await exists(path.join(await f.operationDirectory(), "result.json"))).toBe(false);
  });

  it("kills command descendants on timeout before they can perform a later effect", async () => {
    const f = await fixture();
    const request = f.request(
      "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c',\"import time; time.sleep(.5); open('late-effect','w').write('bad')\"]); print('partial',flush=True); time.sleep(2)",
      "test-operation",
      { timeoutMs: 200 },
    );
    expect(await f.invoke(request)).toEqual({ status: "unknown" });
    await delay(550);
    expect(await exists(path.join(f.guest, "late-effect"))).toBe(false);
  });

  it.each([
    { cwd: "different" },
    { env: { CHANGED: "yes" } },
    { unsetEnv: ["CHANGED"] },
    { timeoutMs: 123 },
    { maxOutputBytes: 123 },
  ])("refuses changed execution parameters %j under a completed ID", async (overrides) => {
    const f = await fixture();
    const code = "open('effects','a').write('once\\n')";
    await f.invoke(f.request(code));
    await expect(f.invoke(f.request(code, "test-operation", overrides))).rejects.toThrow(
      "command mismatch",
    );
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
  });

  it.skipIf(process.getuid!() !== 0)(
    "prevents the actual unprivileged child from forging a root receipt",
    async () => {
      const f = await fixture();
      const request = f.request(
        `import os; os.makedirs(${JSON.stringify(path.join(f.base, "journal", "forged"))})`,
      );
      const reply = await f.invoke(request);
      expect(reply.status).toBe("completed");
      expect(reply.result.code).not.toBe(0);
      expect(reply.result.stderr).toContain("PermissionError");
    },
  );

  it("applies guest credentials, relative cwd, environment overlays and removals only in the child", async () => {
    const f = await fixture();
    await mkdir(path.join(f.guest, "nested"), { mode: 0o755 });
    const request = f.request(
      "import json,os,sys; print(json.dumps(dict(uid=os.getuid(),gid=os.getgid(),cwd=os.getcwd(),keep=os.getenv('KEEP'),removed=os.getenv('REMOVE'),stdin=sys.stdin.read())))",
      "test-operation",
      {
        cwd: "nested",
        env: { KEEP: "fake-kept-command-value", REMOVE: "fake-unset-command-value" },
        unsetEnv: ["REMOVE"],
      },
    );
    const result = await f.invoke(request);
    expect(JSON.parse(result.result.stdout)).toEqual({
      uid: f.account.uid,
      gid: f.account.gid,
      cwd: path.join(f.guest, "nested"),
      keep: "[redacted]",
      removed: null,
      stdin: "",
    });
  });

  it("queries missing operations without creating any journal and scopes receipts to ownership", async () => {
    const f = await fixture();
    const before = await readdir(f.base);
    expect(await f.query()).toEqual({ status: "unknown" });
    expect(await readdir(f.base)).toEqual(before);
    const request = f.request("print('bound')", "../../opaque-operation");
    await f.invoke(request);
    const directory = await f.operationDirectory();
    const saved = await Promise.all(
      ["started.json", "result.json"].map((name) => readFile(path.join(directory, name), "utf8")),
    );
    for (const key of [
      "spaceId",
      "computerId",
      "botId",
      "ownerBotId",
      "instance",
      "project",
    ] as const) {
      expect(await f.query(request.operationId, { ...identity, [key]: "different" })).toEqual({
        status: "unknown",
      });
    }
    expect(await f.query(request.operationId)).toMatchObject({ status: "completed" });
    expect(
      await Promise.all(
        ["started.json", "result.json"].map((name) => readFile(path.join(directory, name), "utf8")),
      ),
    ).toEqual(saved);
  });

  it.each(["started.json", "result.json"])("refuses a guest symlink replacing %s", async (name) => {
    const f = await fixture();
    await f.invoke(f.request("print('trusted')"));
    const file = path.join(await f.operationDirectory(), name);
    const forged = path.join(f.guest, "forged");
    await writeFile(forged, await readFile(file));
    await rm(file);
    await symlink(forged, file);
    await expect(f.query()).rejects.toThrow("journal unavailable");
  });

  it("refuses symlink directories, hard-linked locks and guest-writable journals", async () => {
    const f = await fixture();
    await symlink(f.guest, path.join(f.base, "journal"));
    await expect(f.invoke(f.request("print('never')"))).rejects.toThrow("journal unavailable");
    await rm(path.join(f.base, "journal"));
    const fault = path.join(f.base, "before-dispatch.py");
    await writeFile(fault, f.script.replace("child = os.fork()", "os._exit(97)"));
    await f.start(f.request("print('never')"), fault).done;
    const directory = await f.operationDirectory();
    await link(path.join(directory, "lock"), path.join(f.guest, "linked-lock"));
    await expect(f.query()).rejects.toThrow("journal unavailable");
    await rm(path.join(f.guest, "linked-lock"));
    await chmod(directory, 0o777);
    await expect(f.query()).rejects.toThrow("journal unavailable");
  });

  it.skipIf(process.getuid!() === 0)(
    "requires actual root for the unmodified production script",
    async () => {
      const f = await fixture();
      const production = path.join(f.base, "production.py");
      await writeFile(production, INCUS_DURABLE_EXEC_SCRIPT);
      const reply = await f.start(f.request("print('never')"), production).done;
      expect(reply.code).toBe(1);
      expect(reply.stderr).toContain("journal unavailable");
    },
  );
});

describe("Incus provider durable protocol", () => {
  it("executes through a root receiver and replays after provider recreation", async () => {
    const f = await fixture();
    const request = {
      argv: [python, "-c", "open('effects','a').write('once\\n'); print('a',end='')"],
      operationId: "test-operation",
    };
    expect(await events(f.provider(1).execute(computer, request, context))).toEqual([
      { type: "stdout", data: "a" },
      { type: "exit", code: 0 },
    ]);
    expect(await f.provider(1).reconcileExecution(computer, request.operationId, context)).toEqual({
      status: "completed",
      result: { stdout: "a", stderr: "", code: 0 },
    });
    await events(f.provider(1).execute(computer, request, context));
    expect(await readFile(path.join(f.guest, "effects"), "utf8")).toBe("once\n");
    const call = f.providerCalls[0]!;
    expect(call.argv.slice(0, -1)).toEqual([
      "incus",
      "--project",
      identity.project,
      "exec",
      identity.instance,
      "--mode",
      "non-interactive",
      "--user",
      "0",
      "--group",
      "0",
      "--",
      python,
      "-I",
      "-u",
      "-c",
    ]);
    expect(call.argv.at(-1)).toBe(INCUS_DURABLE_EXEC_SCRIPT);
    expect(call.keepStdinOpen).toBeUndefined();
    expect(JSON.parse(call.input!).identity).toEqual(identity);
    const query = JSON.parse(f.providerCalls[1]!.input!);
    expect(query).toEqual({ op: "query", identity, operationId: request.operationId });
  });

  it("queries an active command immediately without waiting for the provider queue", async () => {
    const f = await fixture();
    const provider = f.provider();
    const request = {
      argv: [
        python,
        "-c",
        "import os,time; open('effect','w').write('yes');\nwhile not os.path.exists('release'): time.sleep(.01)\nprint('done')",
      ],
      operationId: "test-operation",
      timeoutMs: 3000,
    };
    const executing = events(provider.execute(computer, request, context));
    await until(() => exists(path.join(f.guest, "effect")), Boolean);
    expect(await provider.reconcileExecution(computer, request.operationId, context)).toEqual({
      status: "pending",
    });
    await writeFile(path.join(f.guest, "release"), "yes");
    await executing;
  });

  it("rejects unauthorized identities and invalid operation IDs before transport", async () => {
    const f = await fixture();
    const provider = f.provider();
    for (const changed of [{ spaceId: "wrong" }, { botId: "wrong" }]) {
      await expect(
        provider.reconcileExecution(computer, "id", { ...context, ...changed }),
      ).rejects.toThrow("not authorized");
    }
    await expect(
      provider.reconcileExecution({ ...computer, id: "wrong" }, "id", context),
    ).rejects.toThrow("not authorized");
    for (const operationId of ["", "nul\0id", "x".repeat(1025)]) {
      await expect(provider.reconcileExecution(computer, operationId, context)).rejects.toThrow(
        "operationId",
      );
      await expect(
        events(provider.execute(computer, { argv: ["true"], operationId }, context)),
      ).rejects.toThrow("operationId");
    }
    expect(f.providerCalls).toHaveLength(0);
  });
});
