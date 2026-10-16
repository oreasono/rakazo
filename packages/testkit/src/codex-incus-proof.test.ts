import { ProductEventSchema, ThreadMessageSchema } from "@rakazo/contracts";
import { buildNativeSessionTrees, projectMessages } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  observationToolResult,
  unchangedVisualLoopToolResult,
} from "../../adapters/src/computer-tools.js";
import {
  completedChildToolCalls,
  expandReadbackArgv,
  nativeIdentity,
  nonceTaskPrompt,
  rakazoMcpName,
  requireCompletedCheckpoint,
  requireNativeTree,
  requireReadback,
  successfulMcpOutput,
} from "./codex-incus-proof.js";

const root = {
  runtime: "codex",
  agentId: "root",
  threadId: "root",
  rootThreadId: "root",
  parentThreadId: null,
  status: "completed",
};
const child = { ...root, agentId: "child", threadId: "child", parentThreadId: "root" };
const fixture = () => ({
  events: [root, child].map((payload) => ({ type: "thread.subagent", payload })),
  messages: [{ blocks: [root, child].map((v) => ({ kind: "subagent", ...v })) }],
});

describe("Codex 0.147 MCP output envelope", () => {
  const content = [
    { type: "text", text: JSON.stringify({ exitCode: 0, stdout: "nonce", stderr: "" }) },
  ];
  const envelope = (body: string) => `Wall time: 0.0193 seconds\nOutput:\n${body}`;

  it("unwraps only the exact timing prefix and then validates structured content", () => {
    expect(successfulMcpOutput(envelope(JSON.stringify(content)))).toBe(true);
    expect(successfulMcpOutput(JSON.stringify(content))).toBe(true);
  });

  it("does not turn rejected calls or failing structured results into success", () => {
    for (const body of [
      "user rejected MCP tool call",
      JSON.stringify([{ type: "text", text: "user rejected MCP tool call" }]),
      JSON.stringify({ isError: true, content }),
      JSON.stringify([{ type: "text", text: JSON.stringify({ exitCode: 1, stdout: "" }) }]),
    ])
      expect(successfulMcpOutput(envelope(body))).toBe(false);
  });

  it("rejects prose, malformed JSON and unrecognized prefixes", () => {
    for (const output of [
      envelope("The tool succeeded."),
      envelope(JSON.stringify([{ type: "text", text: "The tool succeeded." }])),
      envelope("[{broken]"),
      `Success!\n${JSON.stringify(content)}`,
      `prefix\n${envelope(JSON.stringify(content))}`,
      `Wall time: unknown seconds\nOutput:\n${JSON.stringify(content)}`,
      `${envelope(JSON.stringify(content))}\nThis worked.`,
    ])
      expect(successfulMcpOutput(output)).toBe(false);
  });
});

describe("shell MCP exit status proof", () => {
  const wrapped = (result: unknown) =>
    `Wall time: 0.0193 seconds\nOutput:\n${JSON.stringify([{ type: "text", text: JSON.stringify(result) }])}`;

  it("accepts code zero in the real shell stdout/stderr shape", () => {
    expect(successfulMcpOutput(wrapped({ stdout: "RAKAZO_TEST", stderr: "", code: 0 }))).toBe(true);
  });

  it("rejects nonzero code when either stdout or stderr identifies a shell result", () => {
    for (const result of [
      { stdout: "", stderr: "", code: 1 },
      { stdout: "RAKAZO_TEST", code: 2 },
      { stderr: "command unavailable", code: 127 },
      { stdout: "partial result", stderr: "", code: -1 },
    ]) {
      expect(successfulMcpOutput(result)).toBe(false);
      expect(successfulMcpOutput(wrapped(result))).toBe(false);
    }
  });

  it("does not interpret an unrelated business code as a shell exit status", () => {
    expect(successfulMcpOutput(wrapped({ code: 200, value: "available" }))).toBe(true);
  });
});

describe("structured GUI observation proof", () => {
  const observation = {
    frameId: "test-frame",
    capturedAt: "2026-01-01T00:00:00.000Z",
    width: 1280,
    height: 800,
    image: Uint8Array.from([1, 2, 3]),
    mimeType: "image/png" as const,
  };
  const wrapped = (content: unknown) =>
    `Wall time: 0.0193 seconds\nOutput:\n${JSON.stringify(content)}`;

  it("accepts actual observe/action formatter output, including image and unchanged-frame variants", () => {
    for (const note of [
      "computer observed",
      "completed 1 computer action",
      "completed 3 computer actions",
    ]) {
      for (const unchanged of [false, true]) {
        const result = observationToolResult(
          observation,
          note,
          unchanged ? observation.frameId : undefined,
        );
        expect(successfulMcpOutput(wrapped(result.content))).toBe(true);
      }
    }
    const loopNotice = observationToolResult(
      observation,
      "completed 3 computer actions",
      observation.frameId,
      { unchangedVisualCount: 3 },
    );
    expect(successfulMcpOutput(wrapped(loopNotice.content))).toBe(true);
  });

  it("rejects malformed/missing frame metadata and arbitrary notes even alongside an image", () => {
    const valid = {
      frameId: observation.frameId,
      capturedAt: observation.capturedAt,
      width: 1280,
      height: 800,
    };
    for (const metadata of [
      {},
      { ...valid, width: 0 },
      { ...valid, height: "800" },
      { ...valid, frameId: "" },
      { ...valid, capturedAt: "invalid" },
      { ...valid, error: "failed" },
    ]) {
      expect(
        successfulMcpOutput(
          wrapped([
            { type: "text", text: `computer observed\n${JSON.stringify(metadata)}` },
            { type: "image", data: "AQID" },
          ]),
        ),
      ).toBe(false);
    }
    for (const note of [
      "it worked",
      "computer observed successfully",
      "completed 3 computer actions but failed",
      "completed 0 computer actions",
      "completed 3 computer action",
    ])
      expect(successfulMcpOutput(wrapped(observationToolResult(observation, note).content))).toBe(
        false,
      );
    expect(
      successfulMcpOutput(wrapped([{ type: "text", text: "computer observed\n{bad json}" }])),
    ).toBe(false);
  });

  it("does not count a visual-loop action that was not executed", () => {
    const blocked = unchangedVisualLoopToolResult({ frameId: observation.frameId, count: 3 });
    expect(successfulMcpOutput(wrapped(blocked.content))).toBe(false);
  });

  it("accepts the exact split timing header only with valid observation metadata and image", () => {
    const header = { type: "input_text", text: "Wall time: 7.0248 seconds\nOutput:" };
    const text = {
      type: "input_text",
      text:
        observationToolResult(observation).content[0]!.type === "text"
          ? (observationToolResult(observation).content[0] as { text: string }).text
          : "",
    };
    const image = { type: "input_image", image_url: "data:image/png;base64,AQID" };
    expect(successfulMcpOutput([header, text, image])).toBe(true);
    expect(successfulMcpOutput(JSON.stringify([header, text, image]))).toBe(true);
    for (const parts of [
      [header],
      [header, text],
      [header, image],
      [text, header, image],
      [{ ...header, text: "Wall time: unknown seconds\nOutput:" }, text, image],
      [header, { type: "input_text", text: "computer observed\n{}" }, image],
      [header, { type: "input_text", text: "The tool succeeded." }, image],
      [header, text, { ...image, image_url: "not-image-data" }],
      [header, text, image, { type: "input_text", text: "user rejected MCP tool call" }],
    ])
      expect(successfulMcpOutput(parts)).toBe(false);
  });
});

describe("Codex/Incus live evidence verifier (offline)", () => {
  it("requests plain nonce bytes without a literal newline escape", () => {
    const prompt = nonceTaskPrompt("RAKAZO_TEST", "/tmp/test-nonce");
    expect(prompt).toContain("RAKAZO_TEST");
    expect(prompt).toContain("/tmp/test-nonce");
    expect(prompt).toContain("no trailing newline");
    expect(prompt).not.toContain("\\n");
  });
  it("requires native identity in events and durable messages", () => {
    expect(requireNativeTree(fixture())).toEqual({
      rootThreadId: "root",
      childThreadIds: ["child"],
    });
  });
  it("does not accept model prose or a Pi-style task ID", () => {
    expect(() =>
      requireNativeTree({
        events: [],
        messages: [{ blocks: [{ kind: "text", text: "I delegated to child" }] }],
      }),
    ).toThrow();
    const f = fixture();
    f.events[1]!.payload = { ...child, agentId: "short-task" };
    expect(() => requireNativeTree(f)).toThrow("No completed native child");
  });
  it("does not accept a transient-only tree or a different root after restart", () => {
    const f = fixture();
    f.messages[0]!.blocks.pop();
    expect(() => requireNativeTree(f)).toThrow("durable messages");
    expect(() => requireNativeTree({ ...fixture(), expectedRoot: "different" })).toThrow("changed");
  });
  it("does not accept self-parenting, a wrong parent, or an inferred root", () => {
    for (const parentThreadId of ["child", "unknown"]) {
      const f = fixture();
      f.events[1]!.payload = { ...child, parentThreadId };
      expect(() => requireNativeTree(f)).toThrow();
    }
    const f = fixture();
    f.events.shift();
    expect(() => requireNativeTree(f)).toThrow("explicit native Codex root");
  });
  it("compares exact bytes and expands argv without evaluating shell syntax", () => {
    expect(() => requireReadback("nonce", "nonce")).not.toThrow();
    expect(() => requireReadback("nonce\n", "nonce")).toThrow();
    expect(
      expandReadbackArgv(["incus", "exec", "{computerRef}", "--", "cat", "{path}"], {
        computerRef: "vm;echo injected",
        path: "/tmp/nonce",
      }),
    ).toEqual(["incus", "exec", "vm;echo injected", "--", "cat", "/tmp/nonce"]);
    expect(() =>
      expandReadbackArgv(["echo", "nonce"], { computerRef: "vm", path: "/tmp/nonce" }),
    ).toThrow();
  });
});

describe("native child MCP provenance", () => {
  const call = (namespace: string | undefined, name: string, callId = "call-1") => ({
    type: "response_item",
    payload: {
      type: "function_call",
      namespace,
      name,
      call_id: callId,
      arguments: JSON.stringify({
        actions: [{ kind: "type", text: "printf %s RAKAZO_TEST > /tmp/test-nonce" }],
      }),
    },
  });
  const result = (output: unknown, callId = "call-1") => ({
    type: "response_item",
    payload: { type: "function_call_output", call_id: callId, output },
  });
  const success = JSON.stringify({
    content: [{ type: "text", text: JSON.stringify({ exitCode: 0, stdout: "" }) }],
  });

  it("recognizes separate or flattened Rakazo namespaces without double-prefixing", () => {
    for (const [namespace, name] of [
      ["mcp__rakazo", "computer_act"],
      [undefined, "mcp__rakazo__computer_act"],
      ["mcp__rakazo", "mcp__rakazo__computer_act"],
    ]) {
      expect(rakazoMcpName(call(namespace, name!).payload)).toBe("mcp__rakazo__computer_act");
      expect(
        completedChildToolCalls(
          [call(namespace, name!), result(success)],
          "RAKAZO_TEST",
          "/tmp/test-nonce",
        ),
      ).toEqual({ tools: ["mcp__rakazo__computer_act"], wroteNonce: true });
    }
  });

  it("requires the successful output to match the exact child call", () => {
    for (const records of [
      [call("mcp__rakazo", "computer_act")],
      [call("mcp__rakazo", "computer_act"), result(success, "other-call")],
      [call("mcp__rakazo", "computer_act"), result("user rejected MCP tool call")],
      [call("multi_agent_v1", "mcp__rakazo__computer_act"), result(success)],
      [call(undefined, "computer_act"), result(success)],
    ])
      expect(completedChildToolCalls(records, "RAKAZO_TEST", "/tmp/test-nonce")).toEqual({
        tools: [],
        wroteNonce: false,
      });
  });

  it("does not infer a nonce write from an unrelated successful call", () => {
    const records = [call("mcp__rakazo", "computer_act"), result(success)];
    expect(completedChildToolCalls(records, "different-nonce", "/tmp/test-nonce").wroteNonce).toBe(
      false,
    );
    expect(completedChildToolCalls(records, "RAKAZO_TEST", "/tmp/different-file").wroteNonce).toBe(
      false,
    );
  });
});

describe("durable completed-run checkpoint proof", () => {
  const proof = () => ({
    events: [
      { type: "run.checkpointed", payload: { runtime: "codex", threadId: "root", resumed: true } },
    ],
    session: { rootThreadId: "root", runs: { run: { status: "completed" } } },
    runId: "run",
    expectedRoot: "root",
    resumed: true,
  });

  it("uses the durable event and session binding without requiring Run.checkpoint", () => {
    expect(requireCompletedCheckpoint(proof())).toEqual({ threadId: "root", resumed: true });
  });

  it("rejects a missing checkpoint, changed root, or unconfirmed resume", () => {
    expect(() => requireCompletedCheckpoint({ ...proof(), events: [] })).toThrow("checkpoint");
    expect(() => requireCompletedCheckpoint({ ...proof(), expectedRoot: "new-root" })).toThrow(
      "root",
    );
    const f = proof();
    f.events[0]!.payload.resumed = false;
    expect(() => requireCompletedCheckpoint(f)).toThrow("resume");
  });

  it("requires the exact run to be complete in the same native session", () => {
    expect(() => requireCompletedCheckpoint({ ...proof(), runId: "unknown-run" })).toThrow(
      "binding",
    );
    const f = proof();
    f.session.runs.run.status = "running";
    expect(() => requireCompletedCheckpoint(f)).toThrow("binding");
    f.session.runs.run.status = "completed";
    f.session.rootThreadId = "different-root";
    expect(() => requireCompletedCheckpoint(f)).toThrow("binding");
  });
});

function versionedFixture() {
  const rootNode = { ...root, nativeRevision: 3 };
  const childNode = { ...child, nativeRevision: 2 };
  return {
    events: [rootNode, childNode].map((payload, seq) => ({
      type: "thread.subagent",
      seq: 900 + seq,
      payload,
    })),
    messages: [
      {
        id: "durable",
        seq: 2,
        blocks: [rootNode, childNode].map((value) => ({ kind: "subagent", ...value })),
      },
    ],
  };
}

describe("native revision evidence compatibility", () => {
  it("accepts a persisted revision despite unrelated message/event counters and stale event replay", () => {
    const f = versionedFixture();
    f.events.push({
      type: "thread.subagent",
      seq: 1000,
      payload: { ...child, status: "running", nativeRevision: 1 },
    });
    expect(requireNativeTree(f)).toEqual({ rootThreadId: "root", childThreadIds: ["child"] });
  });

  it("does not mistake historical completion for a newly resumed child's completion", () => {
    const f = versionedFixture();
    f.events.push({
      type: "thread.subagent",
      seq: 1000,
      payload: { ...child, status: "running", nativeRevision: 4 },
    });
    expect(() => requireNativeTree(f)).toThrow("No completed native child");
  });

  it("requires the newest durable state to be complete, not an older completed message", () => {
    const f = versionedFixture();
    f.messages.push({
      id: "newer-state",
      seq: 3,
      blocks: [{ kind: "subagent", ...child, status: "running", nativeRevision: 4 }],
    });
    expect(() => requireNativeTree(f)).toThrow("durable messages");
  });

  it("rejects persistence that has not caught up with the completed event revision", () => {
    const f = versionedFixture();
    f.events[1]!.payload = { ...child, nativeRevision: 4 };
    expect(() => requireNativeTree(f)).toThrow("durable messages");
  });

  it("requires versioned roots to be durable too, while preserving unversioned fixtures", () => {
    const f = versionedFixture();
    f.events[0]!.payload = { ...root, nativeRevision: 5 };
    expect(() => requireNativeTree(f)).toThrow("root missing");
    expect(requireNativeTree(fixture()).childThreadIds).toEqual(["child"]);
  });

  it("rejects invalid revisions instead of treating them as current evidence", () => {
    for (const nativeRevision of [-1, 0.5, Number.NaN, "3", Number.MAX_SAFE_INTEGER + 1]) {
      expect(nativeIdentity({ ...root, nativeRevision })).toBeUndefined();
    }
  });
});

describe("client and evidence contract conformance", () => {
  it("keeps the same native tree across event replay, wire validation and a durable snapshot with its own seq counter", () => {
    const runningRoot = {
      ...root,
      kind: "subagent",
      name: "Main",
      task: "Delegate",
      status: "running",
      nativeRevision: 1,
    };
    const runningChild = {
      ...child,
      kind: "subagent",
      name: "Helper",
      task: "Read the computer",
      status: "running",
      nativeRevision: 2,
    };
    const completedChild = {
      ...runningChild,
      status: "completed",
      nativeRevision: 3,
      result: "Readback verified",
    };
    const completedRoot = { ...runningRoot, status: "completed", nativeRevision: 4 };
    const event = (seq: number, type: string, payload: Record<string, unknown>) =>
      ProductEventSchema.parse({
        id: `event-${seq}`,
        spaceId: "space",
        botId: "bot",
        threadId: "product-thread",
        runId: "run",
        seq,
        type,
        payload,
        createdAt: "2026-01-01T00:00:00Z",
      });
    const events = [
      event(701, "thread.subagent", runningRoot),
      event(702, "thread.subagent", runningChild),
      event(703, "thread.subagent", completedChild),
      event(704, "thread.subagent", completedRoot),
      event(705, "thread.message.created", { messageId: "stored-child", blocks: [completedChild] }),
      event(706, "thread.message.created", { messageId: "stored-root", blocks: [completedRoot] }),
      event(707, "thread.subagent", runningChild),
    ];
    const projected = projectMessages(events);
    const restored = projected.map((message, index) =>
      ThreadMessageSchema.parse(JSON.parse(JSON.stringify({ ...message, seq: index + 1 }))),
    );
    expect(restored).toHaveLength(2);
    expect(buildNativeSessionTrees(restored)).toEqual(buildNativeSessionTrees(projected));
    expect(buildNativeSessionTrees(restored)[0]?.nodes).toMatchObject([
      { threadId: "root", parentThreadId: null, nativeRevision: 4, status: "completed" },
      { threadId: "child", parentThreadId: "root", nativeRevision: 3, status: "completed" },
    ]);
    expect(requireNativeTree({ events, messages: restored, expectedRoot: "root" })).toEqual({
      rootThreadId: "root",
      childThreadIds: ["child"],
    });
    const resumedEvents = [
      ...events,
      event(708, "thread.subagent", { ...runningChild, nativeRevision: 5 }),
    ];
    expect(buildNativeSessionTrees(projectMessages(resumedEvents))[0]?.nodes[1]).toMatchObject({
      status: "running",
      nativeRevision: 5,
    });
    expect(() => requireNativeTree({ events: resumedEvents, messages: restored })).toThrow(
      "No completed native child",
    );
  });
});
