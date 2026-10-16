import type { MessageBlock, NativeSubagentMetadata } from "@rakazo/contracts";

type SubagentBlock = Extract<MessageBlock, { kind: "subagent" }>;
type SessionMessage = { id: string; seq?: number; blocks: MessageBlock[] };

/** No identity inference from names, run IDs, or Pi's short-lived task IDs. */
export function nativeSubagentMetadata(
  value: Record<string, unknown>,
): NativeSubagentMetadata | undefined {
  const { runtime, rootThreadId, parentThreadId, threadId, agentId, nativeStatus, nativeRevision } =
    value;
  if (
    runtime !== "codex" ||
    typeof rootThreadId !== "string" ||
    !rootThreadId.trim() ||
    typeof threadId !== "string" ||
    !threadId.trim() ||
    agentId !== threadId ||
    (threadId === rootThreadId
      ? parentThreadId !== null
      : typeof parentThreadId !== "string" || !parentThreadId.trim() || parentThreadId === threadId)
  )
    return undefined;
  return {
    runtime,
    rootThreadId,
    parentThreadId: parentThreadId as string | null,
    threadId,
    ...(typeof nativeStatus === "string" ? { nativeStatus } : {}),
    ...(typeof nativeRevision === "number" &&
    Number.isSafeInteger(nativeRevision) &&
    nativeRevision >= 0
      ? { nativeRevision }
      : {}),
  };
}

/** Native nodes live in the session tree, not as repeated task/result cards in the transcript.
 * Keep mixed message content and legacy/invalid subagents; build the tree from the originals. */
export function withoutNativeSessionBlocks<T extends SessionMessage>(messages: readonly T[]): T[] {
  return messages.flatMap((message) => {
    const blocks = message.blocks.filter(
      (block) => block.kind !== "subagent" || !nativeSubagentMetadata(block),
    );
    if (blocks.length === message.blocks.length) return [message];
    return blocks.length ? [{ ...message, blocks }] : [];
  });
}

export interface NativeSessionNode {
  threadId: string;
  parentThreadId?: string | null;
  nativeStatus?: string;
  nativeRevision?: number;
  depth: number;
  /** Root status is deliberately unknown without an explicit native root event. */
  status?: SubagentBlock["status"];
  name?: string;
  task?: string;
  progress?: string;
  result?: string;
  /** Missing history or malformed ancestry: show the declared parent, never invent one. */
  unresolvedParent?: boolean;
}

export interface NativeSessionTree {
  runtime: "codex";
  rootThreadId: string;
  nodes: NativeSessionNode[];
}

/** Recovery describes the native session, independently of the legacy task status. */
export function nativeSessionStatus(
  node: Pick<NativeSessionNode, "status" | "nativeStatus">,
): { label: string; tone: "warning" | "destructive" | "success" } | undefined {
  switch (node.nativeStatus) {
    case "recovering":
      return { label: "Recovering", tone: "warning" };
    case "interrupted":
      return { label: "Interrupted", tone: "destructive" };
    case "recovery_required":
      return { label: "Needs review", tone: "destructive" };
  }
  if (!node.status) return undefined;
  return {
    label: node.nativeStatus || node.status,
    tone:
      node.status === "failed" ? "destructive" : node.status === "running" ? "warning" : "success",
  };
}

/** Rebuild solely from persisted messages plus optional live overlays, without client storage.
 * Native revision wins across durable messages and live events: their seq counters differ.
 * Unversioned legacy data uses seq; at an equal revision a durable block wins. */
export function buildNativeSessionTrees(messages: readonly SessionMessage[]): NativeSessionTree[] {
  const roots = new Map<
    string,
    Map<string, { block: SubagentBlock; seq: number; durable: boolean }>
  >();
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.kind !== "subagent") continue;
      const native = nativeSubagentMetadata(block);
      if (!native) continue;
      let children = roots.get(native.rootThreadId);
      if (!children) {
        children = new Map();
        roots.set(native.rootThreadId, children);
      }
      const previous = children.get(native.threadId);
      const seq = message.seq ?? -1;
      const durable = !message.id.startsWith("subagent:");
      if (previous && compareNativeVersions(previous, { block, seq, durable }) > 0) continue;
      children.set(native.threadId, { block, seq, durable });
    }
  }
  return [...roots]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([rootThreadId, children]) => {
      const nodes: NativeSessionNode[] = [];
      const visited = new Set<string>();
      const byParent = new Map<string, string[]>();
      for (const [threadId, { block }] of children) {
        if (threadId === rootThreadId) continue;
        const parent = block.parentThreadId as string;
        const siblings = byParent.get(parent) ?? [];
        siblings.push(threadId);
        byParent.set(parent, siblings);
      }
      for (const siblings of byParent.values()) siblings.sort();
      const append = (threadId: string, depth: number, unresolvedParent = false) => {
        const block = children.get(threadId)?.block;
        if (!block || visited.has(threadId)) return;
        visited.add(threadId);
        nodes.push({
          threadId,
          parentThreadId: block.parentThreadId,
          depth,
          name: block.name,
          status: block.status,
          nativeStatus: block.nativeStatus,
          nativeRevision: block.nativeRevision,
          task: block.task,
          progress: block.progress,
          result: block.result,
          ...(unresolvedParent ? { unresolvedParent: true } : {}),
        });
      };
      if (children.has(rootThreadId)) append(rootThreadId, 0);
      else {
        nodes.push({ threadId: rootThreadId, depth: 0 });
        visited.add(rootThreadId);
      }
      // Iterative traversal also handles unusually deep trees without a render-stack overflow.
      const stack = (byParent.get(rootThreadId) ?? [])
        .slice()
        .reverse()
        .map((id) => ({ id, depth: 1 }));
      while (stack.length) {
        const next = stack.pop();
        if (!next || visited.has(next.id)) continue;
        append(next.id, next.depth);
        for (const id of (byParent.get(next.id) ?? []).slice().reverse())
          stack.push({ id, depth: next.depth + 1 });
      }
      // Orphans and cycles stay visible, with their declared parent ID, outside the known hierarchy.
      for (const threadId of [...children.keys()].sort()) {
        if (!visited.has(threadId)) append(threadId, 1, true);
      }
      return { runtime: "codex", rootThreadId, nodes };
    });
}

/** Apply a native update to the existing durable card when possible. A resumed child can run
 * again after completion; revision, never terminal status, determines freshness. */
export function upsertNativeSubagentMessage<T extends SessionMessage>(messages: T[], next: T): T[] {
  const block = next.blocks.find((candidate) => candidate.kind === "subagent");
  const native = block && nativeSubagentMetadata(block);
  if (!native) return messages;
  const matches = (candidate: MessageBlock) =>
    candidate.kind === "subagent" &&
    candidate.runtime === "codex" &&
    candidate.rootThreadId === native.rootThreadId &&
    candidate.threadId === native.threadId &&
    candidate.agentId === native.threadId;
  const incoming = { block, seq: next.seq ?? -1, durable: !next.id.startsWith("subagent:") };
  const known = messages
    .flatMap((message) =>
      message.blocks.filter(matches).map((candidate) => ({
        message,
        block: candidate as SubagentBlock,
        seq: message.seq ?? -1,
        durable: !message.id.startsWith("subagent:"),
      })),
    )
    .sort((a, b) => compareNativeVersions(b, a));
  if (known[0] && compareNativeVersions(incoming, known[0]) <= 0) return messages;
  const durable = known.find((candidate) => candidate.durable)?.message;
  const withoutLive = messages.filter((message) => message.id !== next.id);
  if (!durable) return [...withoutLive, next];
  return withoutLive.map((message) =>
    message.id === durable.id
      ? {
          ...message,
          // Keep the durable timeline position when a native revision carries freshness.
          seq: native.nativeRevision === undefined ? next.seq : message.seq,
          blocks: message.blocks.map((candidate) => (matches(candidate) ? block : candidate)),
        }
      : message,
  );
}

type NativeVersion = { block: SubagentBlock; seq: number; durable: boolean };

function compareNativeVersions(a: NativeVersion, b: NativeVersion): number {
  const ar = nativeSubagentMetadata(a.block)?.nativeRevision;
  const br = nativeSubagentMetadata(b.block)?.nativeRevision;
  if (ar !== undefined || br !== undefined) {
    if (ar === undefined) return -1;
    if (br === undefined) return 1;
    return ar - br || Number(a.durable) - Number(b.durable);
  }
  return a.seq - b.seq || Number(a.durable) - Number(b.durable);
}

/** A late durable event must not erase a newer live revision when it replaces the live card. */
export function preserveNativeSubagentRevisions<T extends SessionMessage>(
  messages: readonly SessionMessage[],
  next: T,
): T {
  return {
    ...next,
    blocks: next.blocks.map((block) => {
      if (block.kind !== "subagent") return block;
      const native = nativeSubagentMetadata(block);
      if (!native) return block;
      let best = { block, seq: next.seq ?? -1, durable: !next.id.startsWith("subagent:") };
      for (const message of messages)
        for (const candidate of message.blocks) {
          if (
            candidate.kind !== "subagent" ||
            candidate.runtime !== "codex" ||
            candidate.rootThreadId !== native.rootThreadId ||
            candidate.threadId !== native.threadId ||
            candidate.agentId !== native.threadId
          )
            continue;
          const version = {
            block: candidate,
            seq: message.seq ?? -1,
            durable: !message.id.startsWith("subagent:"),
          };
          // Do not reinterpret legacy seq across counters on this durable-message path.
          if (
            native.nativeRevision === undefined &&
            nativeSubagentMetadata(candidate)?.nativeRevision === undefined
          )
            continue;
          if (compareNativeVersions(version, best) > 0) best = version;
        }
      return best.block;
    }),
  };
}

/** A refresh cursor can advance before native persistence catches up. Keep the newest
 * revisions and omitted children of roots still present in the refresh, without carrying
 * old transcript/progress blocks. An empty refresh or different root does not revive a tree. */
export function preserveNativeSessionMessages<T extends SessionMessage>(
  previous: readonly T[],
  recent: T[],
): T[] {
  const roots = new Set(
    recent.flatMap((message) =>
      message.blocks.flatMap((block) => {
        const native = block.kind === "subagent" && nativeSubagentMetadata(block);
        return native ? [native.rootThreadId] : [];
      }),
    ),
  );
  if (!roots.size) return recent;
  let messages = recent.map((message) => preserveNativeSubagentRevisions(previous, message));
  for (const message of previous)
    for (const block of message.blocks) {
      const native = block.kind === "subagent" && nativeSubagentMetadata(block);
      if (!native || native.nativeRevision === undefined || !roots.has(native.rootThreadId))
        continue;
      messages = upsertNativeSubagentMessage(messages, {
        ...message,
        id: `subagent:${native.threadId}`,
        blocks: [block],
      });
    }
  return messages;
}
