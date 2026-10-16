import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { appendTask, requireAppendCount } from "./codex-crash-proof.js";

// Local shell/fixture regression only. No service, model, runtime, database or VM is started.
it.skipIf(process.platform === "win32")(
  "the actual generated shell command appends one LF and exposes a duplicate execution",
  () => {
    const nonce = `CRASH_${randomBytes(16).toString("hex")}`;
    const file = `/tmp/rakazo-crash-${randomBytes(16).toString("hex")}.txt`;
    const task = appendTask(nonce, file, "tool_prepared");
    writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    try {
      requireAppendCount(readFileSync(file, "utf8"), nonce, 0);
      execFileSync("/bin/bash", ["-c", task.command], { stdio: "ignore", timeout: 5_000 });
      const bytes = readFileSync(file);
      expect(bytes.length).toBe(nonce.length + 1);
      expect(bytes.at(-1)).toBe(10);
      requireAppendCount(bytes.toString("utf8"), nonce, 1);
      expect(task.prompt).toContain(`${task.command}\nDo not`);
      execFileSync("/bin/bash", ["-c", task.command], { stdio: "ignore", timeout: 5_000 });
      expect(readFileSync(file, "utf8")).toBe(`${nonce}\n${nonce}\n`);
      expect(() => requireAppendCount(readFileSync(file, "utf8"), nonce, 1)).toThrow();
    } finally {
      unlinkSync(file);
    }
  },
);
