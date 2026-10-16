import assert from "node:assert/strict";
import type { NativeIdentity } from "./codex-incus-proof.js";
import { nativeIdentity, rakazoMcpName } from "./codex-incus-proof.js";

export const crashBoundaries = ["tool_prepared", "tool_dispatched", "tool_result_stored"] as const;
export type CrashBoundary = (typeof crashBoundaries)[number];
type CrashNode = NativeIdentity & { nativeStatus?: string };

/** Private, server-owned fixture. Never accepted from a model/tool argument. */
export interface CrashControl {
  version: 1;
  fixtureId: string;
  botId: string;
  productThreadId: string;
  boundary: CrashBoundary;
  toolName: "shell";
  argumentContains: [string, string];
  receiptDirectory: string;
}

export interface CrashHit {
  version: 1;
  fixtureId: string;
  boundary: CrashBoundary;
  workerPid: number;
  botId: string;
  productThreadId: string;
  runId: string;
  rootThreadId: string;
  executionId: string;
  toolName: string;
  journalStatus: "prepared" | "dispatched" | "completed";
  journalSha256: string;
  /** SHA-256 of the serialized durable completed result; absent before completion. */
  resultSha256?: string;
  recordedAt: string;
}

export interface CrashSnapshot {
  run: { id: string; threadId: string; botId: string; status: string };
  events: Array<{ type: string; payload: unknown; runId: string | null; seq: number }>;
  messages: Array<{ runId: string | null; blocks: unknown }>;
}

export function crashBoundary(value: unknown): CrashBoundary {
  assert(crashBoundaries.includes(value as CrashBoundary), "Choose an exact crash boundary");
  return value as CrashBoundary;
}

export function requireCrashHit(control: CrashControl, hit: CrashHit, runId: string, pid: number) {
  for (const key of [
    "version",
    "fixtureId",
    "boundary",
    "botId",
    "productThreadId",
    "toolName",
  ] as const)
    assert.equal(hit[key], control[key], `Crash hit ${key} does not match the armed fixture`);
  assert.equal(hit.runId, runId, "Crash hit belongs to another product run");
  assert.equal(hit.workerPid, pid, "Crash hit does not belong to the owned worker PID");
  assert(Number.isSafeInteger(pid) && pid > 1, "Invalid worker PID");
  assert(hit.rootThreadId && hit.executionId, "Crash hit lacks native/tool identity");
  const status = {
    tool_prepared: "prepared",
    tool_dispatched: "dispatched",
    tool_result_stored: "completed",
  };
  assert.equal(hit.journalStatus, status[control.boundary], "Wrong durable tool boundary");
  assert(/^[a-f0-9]{64}$/.test(hit.journalSha256), "Missing durable journal digest");
  assert(Number.isFinite(Date.parse(hit.recordedAt)), "Invalid hit timestamp");
  if (control.boundary === "tool_result_stored")
    assert(/^[a-f0-9]{64}$/.test(hit.resultSha256 ?? ""), "Stored result digest missing");
  else
    assert.equal(
      hit.resultSha256,
      undefined,
      "Tool result already stored before the crash boundary",
    );
}

/** Inspect exact bytes: no wc parsing, whitespace normalization, or model-supplied count. */
export function requireAppendCount(bytes: string, nonce: string, expected: 0 | 1) {
  assert.equal(bytes, `${nonce}\n`.repeat(expected), "Independent VM append bytes/count mismatch");
  return expected;
}

function latest(nodes: CrashNode[]) {
  const result = new Map<string, CrashNode>();
  for (const node of nodes) {
    assert(Number.isSafeInteger(node.nativeRevision), "Native node revision is required");
    const old = result.get(node.threadId);
    if (!old || node.nativeRevision! >= old.nativeRevision!) result.set(node.threadId, node);
  }
  return result;
}

export function requireCrashTree(snapshot: CrashSnapshot, root: string) {
  const nodes = latest(
    snapshot.events
      .filter((e) => e.runId === snapshot.run.id && e.type === "thread.subagent")
      .map((e) => nativeIdentity(e.payload))
      .filter((n): n is NativeIdentity => Boolean(n)),
  );
  const durable = latest(
    snapshot.messages
      .filter((m) => m.runId === snapshot.run.id)
      .flatMap((m) => (Array.isArray(m.blocks) ? m.blocks : []))
      .filter((b) => b?.kind === "subagent")
      .map(nativeIdentity)
      .filter((n): n is NativeIdentity => Boolean(n)),
  );
  assert(nodes.size >= 2, "Current run needs explicit native root and child");
  assert.equal(nodes.get(root)?.parentThreadId, null, "Explicit native root missing");
  for (const node of nodes.values()) {
    assert.equal(node.rootThreadId, root, "Current run changed native root");
    if (node.threadId !== root)
      assert.equal(node.parentThreadId, root, "Expected one-level native children");
    const saved = durable.get(node.threadId);
    assert(saved, "Native node missing from this run's durable messages");
    assert.equal(
      saved.nativeRevision,
      node.nativeRevision,
      "Native event/message revision disagreement",
    );
    assert.equal(saved.status, node.status, "Native event/message status disagreement");
    assert.equal(
      saved.nativeStatus,
      node.nativeStatus,
      "Native event/message native status disagreement",
    );
    assert.equal(saved.rootThreadId, root);
    assert.equal(saved.parentThreadId, node.parentThreadId);
  }
  return {
    rootThreadId: root,
    childThreadIds: [...nodes.keys()].filter((id) => id !== root),
    nodes: [...nodes.values()],
  };
}

/** A new turn, a checkpoint, or an unscoped recovery log is not same-run recovery proof. */
export function requireCrashRecovery(input: {
  hit: CrashHit;
  before: CrashSnapshot;
  after: CrashSnapshot;
  killedPid: number;
  restartedPid: number;
  appendBytes: string;
  nonce: string;
}) {
  const { hit, before, after } = input;
  assert.equal(before.run.id, hit.runId);
  assert.equal(after.run.id, hit.runId, "Recovery created another product run");
  assert.equal(before.run.threadId, hit.productThreadId);
  assert.equal(after.run.threadId, hit.productThreadId);
  assert.equal(before.run.botId, hit.botId);
  assert.equal(after.run.botId, hit.botId);
  assert.equal(before.run.status, "running", "Crash must occur mid-run");
  assert.equal(after.run.status, "completed", "Same product run did not finish");
  assert.equal(input.killedPid, hit.workerPid);
  assert(Number.isSafeInteger(input.restartedPid) && input.restartedPid > 1);
  assert.notEqual(input.restartedPid, input.killedPid, "Actual worker was not replaced");
  requireAppendCount(input.appendBytes, input.nonce, 1);
  const oldTree = requireCrashTree(before, hit.rootThreadId);
  const tree = requireCrashTree(after, hit.rootThreadId);
  assert.equal(oldTree.childThreadIds.length, 1, "This gate requires exactly one native child");
  assert.deepEqual(
    [...tree.childThreadIds].sort(),
    [...oldTree.childThreadIds].sort(),
    "Recovery created or replaced a native child",
  );
  for (const old of oldTree.nodes) {
    const current = tree.nodes.find((n) => n.threadId === old.threadId);
    assert(current, "Recovery lost an existing native node");
    assert(current.nativeRevision! >= old.nativeRevision!, "Recovery regressed native revision");
    if (current.threadId === hit.rootThreadId) assert.equal(current.status, "completed");
    else {
      assert.equal(old.status, "running", "Child was not active at crash");
      assert.equal(
        current.status,
        "failed",
        "Interrupted child reasoning must not be painted completed",
      );
      assert.equal(current.nativeStatus, "interrupted", "Child interruption must remain visible");
    }
  }
  assert(
    tree.nodes.some(
      (n) =>
        n.nativeRevision! >
        (oldTree.nodes.find((old) => old.threadId === n.threadId)?.nativeRevision ?? Infinity),
    ),
    "No fresh native revision after recovery",
  );
  const lastSeq = Math.max(0, ...before.events.map((e) => e.seq));
  assert(
    after.events.some(
      (e) =>
        e.runId === hit.runId &&
        e.seq > lastSeq &&
        e.type === "run.checkpointed" &&
        (e.payload as Record<string, unknown>)?.runtime === "codex" &&
        (e.payload as Record<string, unknown>)?.threadId === hit.rootThreadId &&
        (e.payload as Record<string, unknown>)?.recovery === "reconciling",
    ),
    "Durable reconciliation start is missing",
  );
  const recovered = after.events
    .filter((e) => e.type === "run.checkpointed" && e.runId === hit.runId && e.seq > lastSeq)
    .map((e) => e.payload as Record<string, unknown>)
    .find(
      (p) =>
        p.runtime === "codex" &&
        p.threadId === hit.rootThreadId &&
        p.recovery === "reconciled" &&
        p.mutationAdmission === "closed",
    );
  assert(recovered, "Fresh durable same-root recovery with mutation admission closed is missing");
  const command = after.events
    .filter(
      (e) =>
        e.runId === hit.runId &&
        e.type === "computer.command" &&
        (e.payload as Record<string, unknown> | null)?.executionId === hit.executionId,
    )
    .sort((a, b) => b.seq - a.seq)[0]?.payload as Record<string, unknown> | undefined;
  assert(command, "Recovered command activity is missing for the crashed execution");
  assert.equal(command.status, "done", "Latest recovered command activity is not done");
  assert.equal(command.exitCode, 0, "Latest recovered command activity did not exit successfully");
  return tree;
}

export function appendTask(nonce: string, guestPath: string, boundary: CrashBoundary) {
  assert(/^CRASH_[a-f0-9]{32}$/.test(nonce));
  assert(/^\/tmp\/rakazo-crash-[a-f0-9]{32}\.txt$/.test(guestPath));
  // This command deliberately has no idempotency guard. Re-execution appends twice.
  const command = `printf '%s\\n' '${nonce}' >> '${guestPath}'; sleep ${boundary === "tool_dispatched" ? 90 : 1}; cat '${guestPath}'`;
  return {
    command,
    prompt: `Delegate exactly one native Codex child with spawn/wait. The child must invoke the inherited Rakazo shell tool once on the assigned remote Incus computer, with this exact command: ${command}\nDo not use the controller shell, create bots, truncate the file, add deduplication guards, or repeat this command. Wait for the child and report its verified result. If interrupted, use verified recovery results and summarize; do not repeat any mutation.`,
  };
}

/** The native child must have actually issued the append, with no tool reply before the kill. */
export function requirePendingChildAppend(
  records: Array<{ type?: string; payload?: Record<string, unknown> }>,
  childId: string,
  command: string,
) {
  assert(
    records.some((r) => r.type === "session_meta" && r.payload?.id === childId),
    "Wrong native child rollout",
  );
  const calls = records.filter((r) => {
    if (
      r.type !== "response_item" ||
      !r.payload ||
      rakazoMcpName(r.payload) !== "mcp__rakazo__shell"
    )
      return false;
    let args = r.payload.arguments;
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        return false;
      }
    }
    return (args as Record<string, unknown>)?.command === command;
  });
  assert.equal(calls.length, 1, "Native child must issue exactly one append call");
  const callId = calls[0]!.payload!.call_id;
  assert(typeof callId === "string" && callId, "Native call identity missing");
  assert(
    !records.some(
      (r) =>
        r.type === "response_item" &&
        r.payload?.type === "function_call_output" &&
        r.payload.call_id === callId,
    ),
    "Model already received the tool result before crash",
  );
  return { threadId: childId, callId, tool: "mcp__rakazo__shell" };
}
