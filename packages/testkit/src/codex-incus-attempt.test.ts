import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archivePreviousAttempt, assertTerminalRuns } from "./codex-incus-attempt.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "codex-incus-archive-test-"));
  directories.push(directory);
  const sessionRoot = path.join(directory, "data", "codex-sessions");
  mkdirSync(path.join(sessionRoot, "owner", "codex", "sessions"), { recursive: true });
  for (const [name, content] of Object.entries({
    "run-attempt.json": '{"nonce":"old-nonce","instance":"test-vm"}',
    "receipt.json": '{"passed":false,"failure":"retained failure"}',
    "seed.json": '{"botId":"same-bot"}',
    "state.json": '{"kind":"test-fixture"}',
    "delegation-events.json": '[{"type":"run.checkpointed"}]',
    "worker-restart.json": '{"before":{"pid":1},"after":{"pid":2}}',
    "run.log": "previous private attempt log\n",
    "tree-live.png": "synthetic-image-bytes",
  }))
    writeFileSync(path.join(directory, name), content, { mode: 0o600 });
  writeFileSync(path.join(sessionRoot, "owner", "session.json"), '{"rootThreadId":"same-root"}');
  writeFileSync(
    path.join(sessionRoot, "owner", "codex", "sessions", "rollout-test.jsonl"),
    '{"type":"session_meta"}\n',
  );
  return {
    directory,
    sessionRoot,
    newAttempt: true,
    runs: [{ status: "completed" }],
    attempts: [{ status: "completed" }],
    databaseSnapshot: {
      runs: [{ id: "old-run", checkpoint: null }],
      events: [{ type: "run.checkpointed" }],
    },
  };
}

describe("explicit live attempt archive (offline)", () => {
  it("copies prior evidence before clearing projections and leaves the seed/runtime state intact", () => {
    const f = fixture();
    const priorReceipt = readFileSync(path.join(f.directory, "receipt.json"), "utf8");
    const archive = archivePreviousAttempt(f)!;
    expect(readFileSync(path.join(archive, "receipt.json"), "utf8")).toBe(priorReceipt);
    expect(JSON.parse(readFileSync(path.join(archive, "database-snapshot.json"), "utf8"))).toEqual(
      f.databaseSnapshot,
    );
    expect(
      readFileSync(path.join(archive, "codex-sessions", "owner", "session.json"), "utf8"),
    ).toContain("same-root");
    expect(
      readFileSync(
        path.join(archive, "codex-sessions", "owner", "codex", "sessions", "rollout-test.jsonl"),
        "utf8",
      ),
    ).toContain("session_meta");
    for (const file of [
      "run-attempt.json",
      "receipt.json",
      "delegation-events.json",
      "worker-restart.json",
      "tree-live.png",
    ]) {
      expect(existsSync(path.join(archive, file))).toBe(true);
      expect(existsSync(path.join(f.directory, file))).toBe(false);
    }
    for (const file of ["seed.json", "state.json", "run.log"])
      expect(readFileSync(path.join(f.directory, file))).toEqual(
        readFileSync(path.join(archive, file)),
      );
    expect(readFileSync(path.join(f.sessionRoot, "owner", "session.json"), "utf8")).toContain(
      "same-root",
    );
    const manifest = JSON.parse(readFileSync(path.join(archive, "archive-manifest.json"), "utf8"));
    expect(manifest.complete).toBe(true);
    expect(manifest.hashes["receipt.json"]).toBe(
      createHash("sha256").update(priorReceipt).digest("hex"),
    );
  });

  it("refuses nonterminal product work without altering prior evidence", () => {
    const f = fixture();
    const before = readdirSync(f.directory);
    for (const status of ["running", "pending", "queued", "waiting_input", "unknown"]) {
      expect(() => archivePreviousAttempt({ ...f, runs: [{ status }] })).toThrow("not terminal");
    }
    expect(() => archivePreviousAttempt({ ...f, attempts: [{ status: "running" }] })).toThrow(
      "not terminal",
    );
    expect(readdirSync(f.directory)).toEqual(before);
    expect(readFileSync(path.join(f.directory, "receipt.json"), "utf8")).toContain(
      "retained failure",
    );
  });

  it("requires explicit --new-attempt for old markers and refuses the flag without a marker", () => {
    const f = fixture();
    expect(() => archivePreviousAttempt({ ...f, newAttempt: false })).toThrow("--new-attempt");
    rmSync(path.join(f.directory, "run-attempt.json"));
    expect(() => archivePreviousAttempt(f)).toThrow("requires an existing attempt");
    expect(archivePreviousAttempt({ ...f, newAttempt: false })).toBeUndefined();
    expect(existsSync(path.join(f.directory, "attempts"))).toBe(false);
  });

  it("allows terminal failures and cancellations without replaying their run IDs", () => {
    expect(() =>
      assertTerminalRuns([{ status: "completed" }, { status: "failed" }, { status: "cancelled" }]),
    ).not.toThrow();
    const f = fixture();
    const archive = archivePreviousAttempt({ ...f, runs: [{ status: "failed" }] })!;
    expect(
      JSON.parse(readFileSync(path.join(archive, "database-snapshot.json"), "utf8")).runs[0].id,
    ).toBe("old-run");
  });

  it("preserves original evidence if an archive fails and keeps the partial archive on retry", () => {
    const f = fixture();
    const evidence = [
      "run-attempt.json",
      "receipt.json",
      "delegation-events.json",
      "tree-live.png",
    ];
    const originals = evidence.map((file) => readFileSync(path.join(f.directory, file)));
    expect(() =>
      archivePreviousAttempt({
        ...f,
        databaseSnapshot: {
          toJSON() {
            throw new Error("Synthetic snapshot failure");
          },
        },
      }),
    ).toThrow("Synthetic snapshot failure");
    evidence.forEach((file, index) => {
      expect(readFileSync(path.join(f.directory, file))).toEqual(originals[index]);
    });
    const archives = path.join(f.directory, "attempts");
    const partial = path.join(archives, readdirSync(archives)[0]!);
    expect(existsSync(path.join(partial, "archive-manifest.json"))).toBe(false);
    expect(readFileSync(path.join(partial, "receipt.json"))).toEqual(originals[1]);
    const complete = archivePreviousAttempt(f)!;
    expect(complete).not.toBe(partial);
    expect(readdirSync(archives)).toHaveLength(2);
    expect(readFileSync(path.join(partial, "receipt.json"))).toEqual(originals[1]);
    expect(
      JSON.parse(readFileSync(path.join(complete, "archive-manifest.json"), "utf8")).complete,
    ).toBe(true);
  });
});
