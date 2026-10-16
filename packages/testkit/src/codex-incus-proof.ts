/** Strict evidence checks: text claiming delegation never counts as a native session. */
export interface NativeIdentity {
  runtime: "codex";
  agentId: string;
  threadId: string;
  rootThreadId: string;
  parentThreadId: string | null;
  status: string;
  nativeRevision?: number;
}

export function nativeIdentity(value: unknown): NativeIdentity | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (
    v.runtime !== "codex" ||
    typeof v.threadId !== "string" ||
    !v.threadId ||
    v.agentId !== v.threadId ||
    typeof v.rootThreadId !== "string" ||
    !v.rootThreadId ||
    typeof v.status !== "string"
  )
    return;
  if (
    v.threadId === v.rootThreadId
      ? v.parentThreadId !== null
      : typeof v.parentThreadId !== "string" || !v.parentThreadId || v.parentThreadId === v.threadId
  )
    return;
  if (
    v.nativeRevision !== undefined &&
    (typeof v.nativeRevision !== "number" ||
      !Number.isSafeInteger(v.nativeRevision) ||
      v.nativeRevision < 0)
  )
    return;
  return v as unknown as NativeIdentity;
}

/** Independent evidence ordering: DB messages and events use unrelated seq counters. */
function latestNativeNodes(nodes: NativeIdentity[]): NativeIdentity[] {
  const latest = new Map<string, NativeIdentity>();
  for (const node of nodes) {
    const key = JSON.stringify([node.rootThreadId, node.threadId]);
    const previous = latest.get(key);
    if (
      previous?.nativeRevision !== undefined &&
      (node.nativeRevision === undefined || node.nativeRevision < previous.nativeRevision)
    )
      continue;
    latest.set(key, node);
  }
  return [...latest.values()];
}

function persistedRevision(durable: NativeIdentity, event: NativeIdentity): boolean {
  return (
    event.nativeRevision === undefined ||
    (durable.nativeRevision !== undefined && durable.nativeRevision >= event.nativeRevision)
  );
}

export function requireNativeTree(input: {
  events: Array<{ type: string; payload: unknown }>;
  messages: Array<{ blocks: unknown }>;
  expectedRoot?: string;
}) {
  const events = latestNativeNodes(
    input.events
      .filter((e) => e.type === "thread.subagent")
      .map((e) => nativeIdentity(e.payload))
      .filter((e): e is NativeIdentity => Boolean(e)),
  );
  const messages = latestNativeNodes(
    input.messages
      .flatMap((m) => (Array.isArray(m.blocks) ? m.blocks : []))
      .filter((b) => b?.kind === "subagent")
      .map(nativeIdentity)
      .filter((e): e is NativeIdentity => Boolean(e)),
  );
  const roots = events.filter((e) => e.threadId === e.rootThreadId && e.parentThreadId === null);
  const rootIds = [...new Set(roots.map((e) => e.threadId))];
  if (rootIds.length !== 1)
    throw new Error("Expected exactly one explicit native Codex root in product events");
  const root = rootIds[0]!;
  if (input.expectedRoot && root !== input.expectedRoot)
    throw new Error("Worker restart changed the native Codex root thread");
  const rootEvent = roots.find((e) => e.threadId === root)!;
  if (
    !messages.some(
      (m) => m.threadId === root && m.parentThreadId === null && persistedRevision(m, rootEvent),
    )
  )
    throw new Error("Native root missing from durable messages");
  const children = events.filter(
    (e) =>
      e.rootThreadId === root &&
      e.parentThreadId === root &&
      e.threadId !== root &&
      e.status === "completed",
  );
  if (!children.length) throw new Error("No completed native child in product events");
  for (const child of children) {
    if (
      !messages.some(
        (m) =>
          m.threadId === child.threadId &&
          m.rootThreadId === root &&
          m.parentThreadId === root &&
          m.status === "completed" &&
          persistedRevision(m, child),
      )
    )
      throw new Error("Native child identity/completion missing from durable messages");
  }
  return { rootThreadId: root, childThreadIds: [...new Set(children.map((c) => c.threadId))] };
}

export function requireReadback(actual: string, nonce: string) {
  if (actual !== nonce) throw new Error("Independent VM readback did not match exact nonce bytes");
}

export function nonceTaskPrompt(nonce: string, guestPath: string): string {
  return `Use your native Codex spawn/wait tools to delegate one child. The child must use the inherited Rakazo MCP tools on the assigned remote Incus computer to write exactly the ASCII nonce ${nonce} to ${guestPath}, with no quotes, no trailing newline and no other bytes, then read it back. If using a guest shell, printf %s writes those exact bytes. Do not create another Rakazo bot. Do not use the controller shell. Wait for the child, verify its result and report the nonce.`;
}

/** Codex 0.147 records the namespace separately; other versions flatten it into name. */
export function rakazoMcpName(call: Record<string, unknown>): string | undefined {
  if (call.type !== "function_call" || typeof call.name !== "string") return;
  if (
    (call.namespace === undefined || call.namespace === "mcp__rakazo") &&
    /^mcp__rakazo__[a-zA-Z0-9_-]+$/.test(call.name)
  )
    return call.name;
  if (call.namespace === "mcp__rakazo" && /^[a-zA-Z0-9_-]+$/.test(call.name))
    return `mcp__rakazo__${call.name}`;
}

function containsFailure(value: unknown): boolean {
  if (typeof value === "string")
    return /user rejected.*tool call|requested tool failed|tool request unavailable|waiting for (?:the user|takeover)|(?:^|\n)(?:error|failed|denied|rejected|cancelled|canceled|timed out)\b/i.test(
      value,
    );
  if (Array.isArray(value)) return value.some(containsFailure);
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (
    v.isError === true ||
    v.ok === false ||
    v.success === false ||
    v.cancelled === true ||
    v.denied === true ||
    (v.error !== undefined && v.error !== null && v.error !== false && v.error !== "")
  )
    return true;
  if (
    typeof v.status === "string" &&
    /^(?:error|failed|denied|rejected|cancelled|canceled|interrupted|waiting.*|pending|timed.?out)$/.test(
      v.status,
    )
  )
    return true;
  if ([v.exitCode, v.exit_code].some((code) => typeof code === "number" && code !== 0)) return true;
  if (
    (typeof v.stdout === "string" || typeof v.stderr === "string") &&
    typeof v.code === "number" &&
    v.code !== 0
  )
    return true;
  return Object.values(v).some(containsFailure);
}

/** Exact observationToolResult notes plus a valid captured frame, never arbitrary prose. */
function successfulObservationText(text: string): boolean {
  const match =
    /^(computer observed|completed ([1-9]\d*) computer actions?)([^\n]*)\n([\s\S]+)$/.exec(text);
  if (!match || (match[2] && Number(match[2]) > 24)) return false;
  if (match[1]!.endsWith(" computer action") && match[2] !== "1") return false;
  let frame: Record<string, unknown>;
  try {
    frame = JSON.parse(match[4]!) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (
    !frame ||
    typeof frame !== "object" ||
    containsFailure(frame) ||
    typeof frame.frameId !== "string" ||
    !frame.frameId.trim() ||
    typeof frame.capturedAt !== "string" ||
    !Number.isFinite(Date.parse(frame.capturedAt)) ||
    !Number.isSafeInteger(frame.width) ||
    Number(frame.width) <= 0 ||
    !Number.isSafeInteger(frame.height) ||
    Number(frame.height) <= 0
  )
    return false;
  if (!match[3]) return frame.screenUnchanged !== true && frame.screenshotOmitted !== true;
  if (
    frame.screenUnchanged !== true ||
    frame.screenshotOmitted !== true ||
    frame.previousScreenshotValid !== true
  )
    return false;
  let suffix =
    " (screen unchanged). The previous screenshot remains valid; this identical frame was omitted.";
  if (frame.unchangedVisualLoop === true) {
    if (!Number.isSafeInteger(frame.unchangedVisualCount) || Number(frame.unchangedVisualCount) < 3)
      return false;
    suffix += ` The same visual action has left the screen unchanged ${frame.unchangedVisualCount} times. Stop repeating it and use browser_snapshot or a different action.`;
  }
  return match[3] === suffix;
}

/** Require structured, nonempty MCP content/result. A matching call_id is not success. */
export function successfulMcpOutput(output: unknown): boolean {
  if (containsFailure(output)) return false;
  if (typeof output === "string") {
    // Codex 0.147 wraps MCP JSON in this exact timing envelope. Do not strip arbitrary prose.
    const envelope = /^Wall time: (?:0|[1-9]\d*)(?:\.\d+)? seconds\r?\nOutput:\r?\n([\s\S]+)$/.exec(
      output,
    );
    try {
      return successfulMcpOutput(JSON.parse(envelope ? envelope[1]! : output));
    } catch {
      return false;
    }
  }
  if (Array.isArray(output)) {
    const header = output[0];
    if (
      header?.type === "input_text" &&
      typeof header.text === "string" &&
      /^Wall time: (?:0|[1-9]\d*)(?:\.\d+)? seconds\r?\nOutput:$/.test(header.text)
    ) {
      const content = output.slice(1);
      return (
        content.some(
          (part) =>
            part?.type === "input_text" &&
            typeof part.text === "string" &&
            successfulObservationText(part.text),
        ) &&
        content.some(
          (part) =>
            part?.type === "input_image" &&
            typeof part.image_url === "string" &&
            /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url),
        ) &&
        content.every(successfulMcpOutput)
      );
    }
    return output.length > 0 && output.every(successfulMcpOutput);
  }
  if (!output || typeof output !== "object") return false;
  const value = output as Record<string, unknown>;
  if ("content" in value) return successfulMcpOutput(value.content);
  if (value.type === "text" || value.type === "input_text")
    return (
      (typeof value.text === "string" && successfulObservationText(value.text)) ||
      successfulMcpOutput(value.text)
    );
  if (value.type === "image" || value.type === "input_image")
    return (
      typeof (value.data ?? value.image_url) === "string" && Boolean(value.data ?? value.image_url)
    );
  // Guest tool results are JSON objects, including action batches, file metadata and exitCode.
  return Object.keys(value).some((key) => key !== "isError");
}

export function completedChildToolCalls(
  records: Array<{ type?: string; payload?: Record<string, unknown> }>,
  nonce: string,
  guestPath: string,
) {
  const calls = new Map<string, { tool: string; writesNonce: boolean }>();
  const success = new Map<string, boolean>();
  for (const record of records) {
    if (record.type !== "response_item" || !record.payload) continue;
    const p = record.payload;
    if (typeof p.call_id !== "string") continue;
    const tool = rakazoMcpName(p);
    if (tool) {
      const args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments);
      calls.set(p.call_id, {
        tool,
        writesNonce: Boolean(args?.includes(nonce) && args.includes(guestPath)),
      });
    }
    if (p.type === "function_call_output") success.set(p.call_id, successfulMcpOutput(p.output));
  }
  const completed = [...calls].filter(([id]) => success.get(id) === true).map(([, value]) => value);
  return {
    tools: completed.map((value) => value.tool),
    wroteNonce: completed.some((value) => value.writesNonce),
  };
}

export function requireCompletedCheckpoint(input: {
  events: Array<{ type: string; payload: unknown }>;
  session: { rootThreadId?: string; runs?: Record<string, { status?: string }> };
  runId: string;
  expectedRoot: string;
  resumed?: boolean;
}) {
  const checkpoints = input.events
    .filter((event) => event.type === "run.checkpointed")
    .map((event) => event.payload as Record<string, unknown>);
  if (
    !checkpoints.length ||
    checkpoints.some((v) => v?.runtime !== "codex" || v.threadId !== input.expectedRoot)
  )
    throw new Error("Durable Codex checkpoint event missing or has a different native root");
  const checkpoint = checkpoints.at(-1)!;
  if (input.resumed !== undefined && checkpoint.resumed !== input.resumed)
    throw new Error("Durable checkpoint does not confirm native thread resume");
  if (
    input.session.rootThreadId !== input.expectedRoot ||
    input.session.runs?.[input.runId]?.status !== "completed"
  )
    throw new Error(
      "Persistent Codex session binding does not confirm this completed run and root",
    );
  return { threadId: input.expectedRoot, resumed: checkpoint.resumed === true };
}

/** argv placeholders only; no shell evaluation of provider identifiers or file paths. */
export function expandReadbackArgv(argv: unknown, values: { computerRef: string; path: string }) {
  if (!Array.isArray(argv) || !argv.length || !argv.every((s) => typeof s === "string"))
    throw new Error("readbackCommand must be a nonempty argv array");
  if (!argv.some((s) => s.includes("{computerRef}")) || !argv.some((s) => s.includes("{path}")))
    throw new Error("Readback must reference this run's VM and file");
  return argv.map((s: string) =>
    s.replaceAll("{computerRef}", values.computerRef).replaceAll("{path}", values.path),
  );
}
