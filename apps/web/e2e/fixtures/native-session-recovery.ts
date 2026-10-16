import type { MessageBlock, ThreadSnapshot } from "@rakazo/contracts";

export const ROOT_THREAD_ID = "codex-fixture-root";
export const CHILD_THREAD_ID = "codex-fixture-child";
export const RECOVERY_RUN_ID = "run-native-recovery-fixture";
export const RECOVERY_PROMPT = "Check the release notes with a native subagent.";

export const recoveryStages = [
  { nativeStatus: "recovering", label: "Recovering", tone: "warning" },
  { nativeStatus: "interrupted", label: "Interrupted", tone: "destructive" },
  { nativeStatus: "recovery_required", label: "Needs review", tone: "destructive" },
] as const;

type RecoveryStatus = (typeof recoveryStages)[number]["nativeStatus"];
const createdAt = "2026-01-01T12:00:00.000Z";

/** Wire snapshots only: the real Shell builds and renders the shared native tree. */
export function nativeRecoverySnapshot(
  base: ThreadSnapshot,
  nativeStatus: RecoveryStatus,
): ThreadSnapshot {
  const stage = recoveryStages.findIndex((entry) => entry.nativeStatus === nativeStatus);
  const recovering = nativeStatus === "recovering";
  const rootStatus = nativeStatus === "interrupted" ? "completed" : nativeStatus;
  const block = (
    threadId: string,
    state: string,
    nativeRevision: number,
  ): Extract<MessageBlock, { kind: "subagent" }> => ({
    kind: "subagent",
    runtime: "codex",
    rootThreadId: ROOT_THREAD_ID,
    parentThreadId: threadId === ROOT_THREAD_ID ? null : ROOT_THREAD_ID,
    threadId,
    agentId: threadId,
    name: threadId === ROOT_THREAD_ID ? "Release coordinator" : "Release reviewer",
    task: "Review release notes",
    status: state === "recovering" ? "running" : state === "completed" ? "completed" : "failed",
    nativeStatus: state,
    nativeRevision,
  });
  return {
    ...base,
    cursor: base.cursor + 100 + stage,
    olderCursor: null,
    activeRuns: [],
    run: {
      id: RECOVERY_RUN_ID,
      botId: base.botId!,
      threadId: base.threadId,
      taskId: "task-native-recovery-fixture",
      status: recovering ? "running" : nativeStatus === "interrupted" ? "completed" : "failed",
      trigger: "user",
      routineId: null,
      modelProvider: null,
      modelId: null,
      error: nativeStatus === "recovery_required" ? "Tool outcome needs review." : null,
      startedAt: createdAt,
      completedAt: recovering ? null : createdAt,
      createdAt,
    },
    messages: [
      {
        id: "native-recovery-prompt",
        threadId: base.threadId,
        runId: RECOVERY_RUN_ID,
        seq: 1,
        role: "user",
        blocks: [{ kind: "text", text: RECOVERY_PROMPT }],
        createdAt,
      },
      ...[
        block(ROOT_THREAD_ID, rootStatus, 10 + stage * 2),
        block(CHILD_THREAD_ID, nativeStatus, 11 + stage * 2),
        // A higher Message.seq cannot overwrite the newer native recovery revision.
        block(CHILD_THREAD_ID, "completed", 1),
      ].map((native, index) => ({
        id: `native-recovery-node-${index}`,
        threadId: base.threadId,
        runId: RECOVERY_RUN_ID,
        seq: index + 2,
        role: "bot" as const,
        blocks: [native],
        createdAt,
      })),
    ],
  };
}
