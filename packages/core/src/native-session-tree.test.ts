import type { MessageBlock, ThreadMessage } from "@rakazo/contracts";
import { MessageBlock as MessageBlockSchema } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { projectMessages, subagentBlockFromPayload } from "./events.js";
import {
  buildNativeSessionTrees,
  nativeSessionStatus,
  nativeSubagentMetadata,
  preserveNativeSessionMessages,
  upsertNativeSubagentMessage,
  withoutNativeSessionBlocks,
} from "./native-session-tree.js";

function block(
  threadId: string,
  parentThreadId: string | null = "root",
  status: "running" | "completed" | "failed" = "running",
): Extract<MessageBlock, { kind: "subagent" }> {
  return {
    kind: "subagent",
    runtime: "codex",
    rootThreadId: "root",
    parentThreadId,
    threadId,
    agentId: threadId,
    name: threadId,
    task: "Read the screen",
    status,
  };
}
function message(value: MessageBlock, seq = 1, id = `durable-${seq}`): ThreadMessage {
  return {
    id,
    threadId: "product-thread",
    seq,
    role: "bot",
    blocks: [value],
    createdAt: "2026-01-01T00:00:00Z",
  };
}

describe("native session tree", () => {
  it("removes native-only cards while rebuilding root and child from the untouched history", () => {
    const messages = [
      message(block("root", null, "completed")),
      message(block("child", "root", "completed"), 2),
    ];
    expect(withoutNativeSessionBlocks(messages)).toEqual([]);
    expect(buildNativeSessionTrees(messages)[0]?.nodes.map((node) => node.threadId)).toEqual([
      "root",
      "child",
    ]);
    expect(messages.map((value) => value.blocks.length)).toEqual([1, 1]);
  });

  it("preserves mixed text, legacy cards and invalid native identities in their original order", () => {
    const text: MessageBlock = { kind: "text", text: "Visible answer" };
    const legacy: MessageBlock = {
      kind: "subagent",
      agentId: "short-task",
      name: "Research",
      task: "Search",
      status: "completed",
    };
    const invalid = { ...block("child"), agentId: "not-the-native-thread" };
    const mixed = {
      ...message(text),
      blocks: [block("root", null), text, legacy, invalid, block("child")],
    };
    const legacyOnly = message(legacy, 2);
    const filtered = withoutNativeSessionBlocks([mixed, legacyOnly]);
    expect(filtered).toEqual([{ ...mixed, blocks: [text, legacy, invalid] }, legacyOnly]);
    expect(filtered[1]).toBe(legacyOnly);
    expect(mixed.blocks).toHaveLength(5);
    expect(buildNativeSessionTrees([mixed])[0]?.nodes).toHaveLength(2);
  });

  it.each(["idle", "interrupted", "recovering", "recovery_required"])(
    "preserves %s metadata through the public message schema and live projection",
    (nativeStatus) => {
      const value = { ...block("root", null), nativeStatus, nativeRevision: 4 };
      expect(MessageBlockSchema.parse(value)).toEqual(value);
      expect(subagentBlockFromPayload(value)).toMatchObject(value);
    },
  );

  it("shows a root-only thread with observed state", () => {
    expect(
      buildNativeSessionTrees([message(block("root", null, "completed"))])[0]?.nodes,
    ).toMatchObject([{ threadId: "root", parentThreadId: null, depth: 0, status: "completed" }]);
  });

  it("rebuilds a real hierarchy from durable messages after JSON roundtrip, regardless of arrival order", () => {
    const messages = [
      message(block("grandchild", "child", "failed"), 4),
      message(block("child", "root", "completed"), 3),
      message(block("root", null), 2),
    ];
    const trees = buildNativeSessionTrees(JSON.parse(JSON.stringify(messages)));
    expect(
      trees[0]?.nodes.map(({ threadId, parentThreadId, depth, status }) => ({
        threadId,
        parentThreadId,
        depth,
        status,
      })),
    ).toEqual([
      { threadId: "root", parentThreadId: null, depth: 0, status: "running" },
      { threadId: "child", parentThreadId: "root", depth: 1, status: "completed" },
      { threadId: "grandchild", parentThreadId: "child", depth: 2, status: "failed" },
    ]);
  });

  it("never promotes Pi or incomplete/mismatched metadata to a native thread", () => {
    const legacy = {
      kind: "subagent" as const,
      agentId: "short-task",
      name: "Codex",
      task: "Work",
      status: "running" as const,
    };
    expect(
      buildNativeSessionTrees([
        message(legacy),
        message({ ...block("child"), runtime: undefined }),
        message({ ...block("child"), agentId: "short-task" }),
        message({ ...block("child"), parentThreadId: undefined }),
      ]),
    ).toEqual([]);
    expect(MessageBlockSchema.parse(legacy)).toEqual(legacy);
    expect(nativeSubagentMetadata(block("root", "root"))).toBeUndefined();
  });

  it("uses seq instead of page order and permits a newer resumed running state", () => {
    const done = message(block("child", "root", "completed"), 8);
    const stale = message(block("child"), 2, "subagent:child");
    expect(buildNativeSessionTrees([done, stale])[0]?.nodes[1]?.status).toBe("completed");
    expect(
      buildNativeSessionTrees([done, stale, message(block("child"), 9, "subagent:child")])[0]
        ?.nodes[1]?.status,
    ).toBe("running");
    expect(
      buildNativeSessionTrees([done, message(block("child"), 8, "subagent:child")])[0]?.nodes[1]
        ?.status,
    ).toBe("completed");
  });

  it("prefers native revisions across unrelated DB message and event counters", () => {
    const persisted = message(
      { ...block("child", "root", "completed"), nativeRevision: 12 },
      2,
      "stored",
    );
    const oldEvent = message({ ...block("child"), nativeRevision: 11 }, 900, "subagent:child");
    expect(buildNativeSessionTrees([persisted, oldEvent])[0]?.nodes[1]).toMatchObject({
      status: "completed",
      nativeRevision: 12,
    });
    expect(buildNativeSessionTrees([oldEvent, persisted])[0]?.nodes[1]?.status).toBe("completed");
    expect(upsertNativeSubagentMessage([persisted], oldEvent)).toEqual([persisted]);
    const resumed = upsertNativeSubagentMessage(
      [persisted],
      message({ ...block("child"), nativeRevision: 13 }, 901, "subagent:child"),
    );
    expect(resumed[0]?.seq).toBe(2);
    expect(buildNativeSessionTrees(resumed)[0]?.nodes[1]).toMatchObject({
      status: "running",
      nativeRevision: 13,
    });
  });

  it("prefers versioned nodes to legacy events and durable data at equal native revisions", () => {
    const persisted = message(
      { ...block("child", "root", "completed"), nativeRevision: 2 },
      1,
      "stored",
    );
    expect(
      upsertNativeSubagentMessage([persisted], message(block("child"), 999, "subagent:child")),
    ).toEqual([persisted]);
    const sameRevision = message({ ...block("child"), nativeRevision: 2 }, 999, "subagent:child");
    expect(buildNativeSessionTrees([persisted, sameRevision])[0]?.nodes[1]?.status).toBe(
      "completed",
    );
  });

  it("keeps separate roots and does not infer a root status from its children", () => {
    const trees = buildNativeSessionTrees([
      message(block("child")),
      message(
        { ...block("second-child"), rootThreadId: "second-root", parentThreadId: "second-root" },
        2,
      ),
    ]);
    expect(trees).toHaveLength(2);
    expect(trees[0]?.nodes[0]).toEqual({ threadId: "root", depth: 0 });
  });

  it("shows missing parents and cycles explicitly without inventing ancestry or looping", () => {
    const trees = buildNativeSessionTrees([
      message(block("orphan", "not-loaded")),
      message(block("a", "b"), 2),
      message(block("b", "a"), 3),
    ]);
    expect(trees[0]?.nodes.slice(1)).toMatchObject([
      { threadId: "a", parentThreadId: "b", unresolvedParent: true },
      { threadId: "b", parentThreadId: "a", unresolvedParent: true },
      { threadId: "orphan", parentThreadId: "not-loaded", unresolvedParent: true },
    ]);
  });

  it("updates a persisted card on resume while keeping its identity and unrelated blocks", () => {
    const done = message(block("child", "root", "completed"), 8, "stored");
    done.blocks.push({ kind: "text", text: "Keep this" });
    expect(
      upsertNativeSubagentMessage([done], message(block("child"), 7, "subagent:child")),
    ).toEqual([done]);
    const next = upsertNativeSubagentMessage([done], message(block("child"), 9, "subagent:child"));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      id: "stored",
      seq: 9,
      blocks: [{ status: "running" }, { kind: "text", text: "Keep this" }],
    });
    expect(done.blocks[0]).toMatchObject({ status: "completed" });
  });

  it("replays persisted running and terminal updates, then accepts native resume events", () => {
    const base = { threadId: "product-thread", createdAt: "2026-01-01T00:00:00Z" };
    const events = [
      { ...base, id: "e1", seq: 1, type: "thread.subagent", payload: block("child") },
      {
        ...base,
        id: "e2",
        seq: 2,
        type: "thread.message.created",
        payload: { messageId: "stored", blocks: [block("child")] },
      },
      {
        ...base,
        id: "e3",
        seq: 3,
        type: "thread.message.updated",
        payload: { messageId: "stored", blocks: [block("child", "root", "completed")] },
      },
    ];
    const restored = projectMessages(events);
    expect(restored).toHaveLength(1);
    expect(buildNativeSessionTrees(restored)[0]?.nodes[1]?.status).toBe("completed");
    const resumed = projectMessages([
      ...events,
      { ...base, id: "e4", seq: 4, type: "thread.subagent", payload: block("child") },
    ]);
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.id).toBe("stored");
    expect(buildNativeSessionTrees(resumed)[0]?.nodes[1]?.status).toBe("running");
  });
});

describe("durable event projection revision compatibility", () => {
  it("constructs a complete message and preserves a newer live revision on late persistence", () => {
    const base = { threadId: "product-thread", createdAt: "2026-01-01T00:00:00Z", botId: "bot" };
    const messages = projectMessages([
      {
        ...base,
        id: "live",
        seq: 900,
        type: "thread.subagent",
        payload: { ...block("child"), nativeRevision: 4 },
      },
      {
        ...base,
        id: "stored-event",
        seq: 901,
        type: "thread.message.created",
        payload: {
          messageId: "stored",
          role: "bot",
          blocks: [{ ...block("child", "root", "completed"), nativeRevision: 3 }],
        },
      },
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: "stored",
      threadId: "product-thread",
      role: "bot",
      createdAt: base.createdAt,
      botId: "bot",
    });
    expect(
      buildNativeSessionTrees(JSON.parse(JSON.stringify(messages)))[0]?.nodes[1],
    ).toMatchObject({ nativeRevision: 4, status: "running" });
  });

  it("restores parent and child through interruption, recovery and completion with no old progress", () => {
    const base = {
      threadId: "product-thread",
      runId: "run",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const events: Parameters<typeof projectMessages>[0] = [
      { ...base, id: "progress", seq: 1, type: "thread.progress", payload: { text: "Old draft" } },
    ];
    const stages = [
      { nativeStatus: "interrupted", status: "failed", revision: 2 },
      { nativeStatus: "recovering", status: "running", revision: 4 },
      { nativeStatus: "completed", status: "completed", revision: 6 },
    ] as const;
    for (const stage of stages) {
      for (const [index, id] of ["root", "child"].entries()) {
        const nativeRevision = stage.revision + index;
        const value = {
          ...block(id, id === "root" ? null : "root", stage.status),
          nativeStatus: stage.nativeStatus,
          nativeRevision,
        };
        events.push(
          {
            ...base,
            id: `live-${nativeRevision}`,
            seq: events.length + 1,
            type: "thread.subagent",
            payload: value,
          },
          {
            ...base,
            id: `stored-${nativeRevision}`,
            seq: events.length + 2,
            type: "thread.message.updated",
            payload: { messageId: `stored-${id}`, blocks: [value] },
          },
        );
      }
      const restored = JSON.parse(JSON.stringify(projectMessages(events)));
      expect(restored).toHaveLength(2);
      expect(buildNativeSessionTrees(restored)[0]?.nodes).toMatchObject([
        {
          threadId: "root",
          parentThreadId: null,
          status: stage.status,
          nativeStatus: stage.nativeStatus,
          nativeRevision: stage.revision,
        },
        {
          threadId: "child",
          parentThreadId: "root",
          status: stage.status,
          nativeStatus: stage.nativeStatus,
          nativeRevision: stage.revision + 1,
        },
      ]);
      expect(withoutNativeSessionBlocks(restored)).toEqual([]);
      expect(JSON.stringify(restored)).not.toContain("Old draft");
    }
  });
});

describe("native session presentation", () => {
  it.each(["running", "failed", "completed"] as const)(
    "never paints recovery states green even with legacy status %s",
    (status) => {
      expect(nativeSessionStatus({ status, nativeStatus: "recovering" })).toEqual({
        label: "Recovering",
        tone: "warning",
      });
      expect(nativeSessionStatus({ status, nativeStatus: "interrupted" })).toEqual({
        label: "Interrupted",
        tone: "destructive",
      });
      expect(nativeSessionStatus({ status, nativeStatus: "recovery_required" })).toEqual({
        label: "Needs review",
        tone: "destructive",
      });
    },
  );

  it("preserves failure and unknown root semantics without inferring success from native labels", () => {
    expect(nativeSessionStatus({})).toBeUndefined();
    expect(nativeSessionStatus({ status: "failed", nativeStatus: "idle" })?.tone).toBe(
      "destructive",
    );
    expect(nativeSessionStatus({ status: "completed", nativeStatus: "idle" })?.tone).toBe(
      "success",
    );
    expect(nativeSessionStatus({ status: "running" })?.label).toBe("running");
  });
});

describe("native session refresh", () => {
  it("preserves missing descendants and newer revisions without old mixed content or progress", () => {
    const root = { ...block("root", null), nativeStatus: "recovering", nativeRevision: 10 };
    const child = { ...block("child"), nativeStatus: "recovering", nativeRevision: 11 };
    const previous = [
      message(root, 1),
      { ...message(child, 2), blocks: [child, { kind: "text" as const, text: "Old answer" }] },
      message({ kind: "progress", text: "Old draft" }, 900, "progress:run"),
    ];
    const recent = [
      message({ ...root, status: "failed", nativeStatus: "interrupted", nativeRevision: 8 }, 1),
    ];
    const refreshed = preserveNativeSessionMessages(previous, recent);
    expect(buildNativeSessionTrees(refreshed)).toEqual(buildNativeSessionTrees(previous));
    expect(JSON.stringify(refreshed)).not.toContain("Old answer");
    expect(JSON.stringify(refreshed)).not.toContain("Old draft");
    expect(withoutNativeSessionBlocks(refreshed)).toEqual([]);

    const restored = JSON.parse(JSON.stringify(refreshed));
    const completed = preserveNativeSessionMessages(restored, [
      message({ ...root, status: "completed", nativeStatus: "completed", nativeRevision: 12 }),
      message(
        { ...child, status: "failed", nativeStatus: "recovery_required", nativeRevision: 13 },
        2,
      ),
    ]);
    const nodes = buildNativeSessionTrees(completed)[0]?.nodes ?? [];
    expect(nodes.map((node) => node.nativeRevision)).toEqual([12, 13]);
    expect(nodes.map(nativeSessionStatus)).toEqual([
      { label: "completed", tone: "success" },
      { label: "Needs review", tone: "destructive" },
    ]);
    expect(buildNativeSessionTrees(preserveNativeSessionMessages(completed, recent))).toEqual(
      buildNativeSessionTrees(completed),
    );
  });

  it("does not revive a cleared tree or import nodes from another root", () => {
    const previous = [message({ ...block("child"), nativeRevision: 5 })];
    expect(preserveNativeSessionMessages(previous, [])).toEqual([]);
    const recent = [message({ ...block("other", null), rootThreadId: "other", nativeRevision: 1 })];
    expect(preserveNativeSessionMessages(previous, recent)).toEqual(recent);
  });
});
