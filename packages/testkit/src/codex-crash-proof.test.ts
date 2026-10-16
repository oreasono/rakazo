import { describe, expect, it } from "vitest";
import type { CrashControl, CrashHit, CrashSnapshot } from "./codex-crash-proof.js";
import {
  appendTask,
  crashBoundaries,
  crashBoundary,
  requireAppendCount,
  requireCrashHit,
  requireCrashRecovery,
  requireCrashTree,
  requirePendingChildAppend,
} from "./codex-crash-proof.js";

const nonce = `CRASH_${"a".repeat(32)}`;
const guestPath = `/tmp/rakazo-crash-${"b".repeat(32)}.txt`;
const control: CrashControl = {
  version: 1,
  fixtureId: "synthetic-fixture",
  boundary: "tool_prepared",
  botId: "bot",
  productThreadId: "product-thread",
  toolName: "shell",
  argumentContains: [nonce, guestPath],
  receiptDirectory: "/private/fixture",
};
const hit: CrashHit = {
  ...control,
  workerPid: 321,
  runId: "run",
  rootThreadId: "root",
  executionId: "execution",
  journalStatus: "prepared",
  journalSha256: "a".repeat(64),
  recordedAt: "2026-01-01T00:00:00Z",
};

function snapshot(recovered: boolean): CrashSnapshot {
  const root = {
    runtime: "codex",
    kind: "subagent",
    agentId: "root",
    threadId: "root",
    rootThreadId: "root",
    parentThreadId: null,
    nativeRevision: recovered ? 5 : 1,
    status: recovered ? "completed" : "running",
    nativeStatus: recovered ? "completed" : "running",
  };
  const child = {
    ...root,
    agentId: "child",
    threadId: "child",
    parentThreadId: "root",
    nativeRevision: recovered ? 6 : 2,
    status: recovered ? "failed" : "running",
    nativeStatus: recovered ? "interrupted" : "running",
  };
  const events: CrashSnapshot["events"] = [root, child].map((payload, index) => ({
    runId: "run",
    type: "thread.subagent",
    payload,
    seq: (recovered ? 10 : 1) + index,
  }));
  events.push({
    runId: "run",
    type: "computer.command",
    seq: recovered ? 12 : 3,
    payload: {
      executionId: "execution",
      status: recovered ? "done" : "running",
      exitCode: recovered ? 0 : null,
    },
  });
  if (recovered)
    events.push(
      ...["reconciling", "reconciled"].map((recovery, index) => ({
        runId: "run",
        type: "run.checkpointed",
        seq: 5 + index,
        payload: { runtime: "codex", threadId: "root", recovery, mutationAdmission: "closed" },
      })),
    );
  return {
    run: {
      id: "run",
      threadId: "product-thread",
      botId: "bot",
      status: recovered ? "completed" : "running",
    },
    events,
    messages: [{ runId: "run", blocks: structuredClone([root, child]) }],
  };
}
function input() {
  return {
    hit: structuredClone(hit),
    before: snapshot(false),
    after: snapshot(true),
    killedPid: 321,
    restartedPid: 654,
    appendBytes: `${nonce}\n`,
    nonce,
  };
}
function mutateNode(state: CrashSnapshot, id: string, fields: Record<string, unknown>) {
  for (const e of state.events)
    if ((e.payload as Record<string, unknown>).threadId === id && e.type === "thread.subagent")
      Object.assign(e.payload as object, fields);
  for (const m of state.messages)
    for (const block of m.blocks as Array<Record<string, unknown>>)
      if (block.threadId === id) Object.assign(block, fields);
}

describe("crash boundary evidence (offline, not product acceptance)", () => {
  it.each(crashBoundaries)(
    "recognizes only the exact %s boundary and durable state",
    (boundary) => {
      expect(crashBoundary(boundary)).toBe(boundary);
      const journalStatus = {
        tool_prepared: "prepared",
        tool_dispatched: "dispatched",
        tool_result_stored: "completed",
      } as const;
      expect(() =>
        requireCrashHit(
          { ...control, boundary },
          {
            ...hit,
            boundary,
            journalStatus: journalStatus[boundary],
            ...(boundary === "tool_result_stored" ? { resultSha256: "b".repeat(64) } : {}),
          },
          "run",
          321,
        ),
      ).not.toThrow();
    },
  );
  it.each([undefined, "", "completed", "tool_completed"])("rejects inexact boundary %s", (value) =>
    expect(() => crashBoundary(value)).toThrow(),
  );
  it.each([
    { workerPid: 999 },
    { runId: "other" },
    { fixtureId: "stale" },
    { botId: "other" },
    { executionId: "" },
    { rootThreadId: "" },
    { journalStatus: "completed" },
    { journalSha256: "" },
    { resultSha256: "a".repeat(64) },
  ])("rejects wrong or stale hit evidence %j", (change) => {
    expect(() => requireCrashHit(control, { ...hit, ...change } as CrashHit, "run", 321)).toThrow();
  });
  it("requires the stored result digest at the pre-response boundary", () => {
    expect(() =>
      requireCrashHit(
        { ...control, boundary: "tool_result_stored" },
        { ...hit, boundary: "tool_result_stored", journalStatus: "completed" },
        "run",
        321,
      ),
    ).toThrow(/digest/);
  });
  it("accepts exact independently read append bytes", () => {
    expect(requireAppendCount("", nonce, 0)).toBe(0);
    expect(requireAppendCount(`${nonce}\n`, nonce, 1)).toBe(1);
  });
  it.each(["", nonce, `${nonce}\n${nonce}\n`, `${nonce}\r\n`, "count=1", `${nonce}\nextra`])(
    "rejects missing, duplicate, normalized or claimed counter %j",
    (bytes) => expect(() => requireAppendCount(bytes, nonce, 1)).toThrow(),
  );
  it("uses an unguarded append and an explicit dispatched window", () => {
    const task = appendTask(nonce, guestPath, "tool_dispatched");
    expect(task.command).toContain(">>");
    expect(task.command).toContain("sleep 90");
    expect(task.command).not.toMatch(/test |\[|flock|grep|touch|&&/);
    expect(() => appendTask("unsafe'", guestPath, "tool_prepared")).toThrow();
    expect(() => appendTask(nonce, "/tmp/unsafe;command", "tool_prepared")).toThrow();
  });
});

describe("native child pending-call evidence", () => {
  const command = appendTask(nonce, guestPath, "tool_prepared").command;
  const records = (flattened = false) => [
    { type: "session_meta", payload: { id: "child" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call",
        name: flattened ? "mcp__rakazo__shell" : "shell",
        ...(flattened ? {} : { namespace: "mcp__rakazo" }),
        arguments: JSON.stringify({ command }),
      },
    },
  ];
  it.each([true, false])("accepts a real pending native call (flattened=%s)", (flattened) => {
    expect(requirePendingChildAppend(records(flattened), "child", command).callId).toBe("call");
  });
  it("rejects a root call, a changed command, or duplicated invocation", () => {
    expect(() => requirePendingChildAppend(records(), "root", command)).toThrow(
      /Wrong native child/,
    );
    expect(() => requirePendingChildAppend(records(), "child", `${command}; true`)).toThrow(
      /exactly one/,
    );
    expect(() =>
      requirePendingChildAppend([...records(), records()[1]!], "child", command),
    ).toThrow(/exactly one/);
  });
  it("rejects a result already returned to the model even if it reports failure", () => {
    const returned = [
      ...records(),
      {
        type: "response_item",
        payload: { type: "function_call_output", call_id: "call", output: "error" },
      },
    ];
    expect(() => requirePendingChildAppend(returned, "child", command)).toThrow(/already received/);
  });
});

describe("same product run recovery proof", () => {
  it("uses the latest matching command by durable seq, not input order", () => {
    const value = input();
    value.after.events.push({
      runId: "run",
      type: "computer.command",
      seq: 4,
      payload: { executionId: "execution", status: "running", exitCode: null },
    });
    expect(() => requireCrashRecovery(value)).not.toThrow();
  });
  it("accepts an already-durable done command at the stored-result boundary", () => {
    const value = input();
    value.hit.boundary = "tool_result_stored";
    value.hit.journalStatus = "completed";
    value.hit.resultSha256 = "b".repeat(64);
    const event = value.after.events.find((e) => e.type === "computer.command")!;
    event.seq = 3;
    value.before.events[value.before.events.findIndex((e) => e.type === "computer.command")] =
      structuredClone(event);
    expect(() => requireCrashRecovery(value)).not.toThrow();
  });
  it.each([
    { status: "running", exitCode: null },
    { status: "done", exitCode: 1 },
    { status: "done", exitCode: null },
    { status: "done", exitCode: "0" },
  ])(
    "rejects a newer unsuccessful or pending command despite an older successful row: %j",
    (payload) => {
      const value = input();
      value.after.events.unshift({
        runId: "run",
        type: "computer.command",
        seq: 20,
        payload: { executionId: "execution", ...payload },
      });
      expect(() => requireCrashRecovery(value)).toThrow(/Latest recovered command activity/);
    },
  );
  it.each(["missing", "other-run", "other-execution"])(
    "rejects unrelated command success: %s",
    (variant) => {
      const value = input();
      const event = value.after.events.find((e) => e.type === "computer.command")!;
      if (variant === "missing") value.after.events = value.after.events.filter((e) => e !== event);
      if (variant === "other-run") event.runId = "other-run";
      if (variant === "other-execution")
        (event.payload as Record<string, unknown>).executionId = "other-execution";
      expect(() => requireCrashRecovery(value)).toThrow(/activity is missing/);
    },
  );
  it("accepts completed root and truthfully interrupted child with advanced revisions", () => {
    expect(requireCrashRecovery(input()).childThreadIds).toEqual(["child"]);
  });
  it("rejects completed-turn restart substituted for a mid-turn kill", () => {
    const value = input();
    value.before.run.status = "completed";
    expect(() => requireCrashRecovery(value)).toThrow(/mid-run/);
  });
  it("rejects a new run or an unchanged worker", () => {
    const value = input();
    value.after.run.id = "new-run";
    expect(() => requireCrashRecovery(value)).toThrow(/another product run/);
    const same = input();
    same.restartedPid = same.killedPid;
    expect(() => requireCrashRecovery(same)).toThrow(/not replaced/);
  });
  it("rejects a different native root", () => {
    const value = input();
    mutateNode(value.after, "child", { rootThreadId: "new-root" });
    expect(() => requireCrashRecovery(value)).toThrow(/changed native root/);
  });
  it("rejects root/child prose and prior-run durable messages", () => {
    const value = input();
    value.after.messages[0]!.runId = "prior-run";
    expect(() => requireCrashRecovery(value)).toThrow(/this run/);
    value.after.messages = [
      { runId: "run", blocks: [{ kind: "text", text: "root child completed" }] },
    ];
    expect(() => requireCrashRecovery(value)).toThrow();
  });
  it("rejects stale, missing or inconsistent revisions", () => {
    for (const revision of [0, undefined]) {
      const value = input();
      mutateNode(value.after, "child", { nativeRevision: revision });
      expect(() => requireCrashRecovery(value)).toThrow();
    }
    const value = input();
    (value.after.messages[0]!.blocks as Array<Record<string, unknown>>)[0]!.nativeRevision = 99;
    expect(() => requireCrashRecovery(value)).toThrow(/revision disagreement/);
  });
  it("rejects duplicate side effects", () => {
    const value = input();
    value.appendBytes += `${nonce}\n`;
    expect(() => requireCrashRecovery(value)).toThrow(/count mismatch/);
  });
  it("rejects painting interrupted child reasoning green", () => {
    const value = input();
    mutateNode(value.after, "child", { status: "completed", nativeStatus: "completed" });
    expect(() => requireCrashRecovery(value)).toThrow(/painted completed/);
  });
  it("rejects unknown GUI outcome as successful recovery", () => {
    const value = input();
    value.after.run.status = "recovery_required";
    mutateNode(value.after, "child", { status: "failed", nativeStatus: "recovery_required" });
    expect(() => requireCrashRecovery(value)).toThrow(/did not finish/);
  });
  it.each(["checkpoint-only", "old-event", "other-run", "mutations-open"])(
    "rejects unproven recovery: %s",
    (variant) => {
      const value = input();
      const e = value.after.events.at(-1)!;
      if (variant === "checkpoint-only")
        (e.payload as Record<string, unknown>).recovery = undefined;
      if (variant === "old-event") e.seq = 1;
      if (variant === "other-run") e.runId = "other-run";
      if (variant === "mutations-open")
        (e.payload as Record<string, unknown>).mutationAdmission = "open";
      expect(() => requireCrashRecovery(value)).toThrow(/recovery with mutation admission/);
    },
  );
  it("rejects disagreement between visible native status and durable source", () => {
    const value = snapshot(true);
    (value.messages[0]!.blocks as Array<Record<string, unknown>>)[1]!.nativeStatus = "completed";
    expect(() => requireCrashTree(value, "root")).toThrow(/native status disagreement/);
  });
});
