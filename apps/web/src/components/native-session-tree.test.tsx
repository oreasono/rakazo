import { buildNativeSessionTrees } from "@rakazo/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NativeSessionTrees } from "./native-session-tree.js";

describe("native session tree presentation", () => {
  it("renders real IDs and hierarchy with read-only node states", () => {
    const trees = buildNativeSessionTrees([
      {
        id: "stored",
        seq: 2,
        blocks: [
          {
            kind: "subagent",
            agentId: "native-child",
            runtime: "codex",
            rootThreadId: "native-root",
            parentThreadId: "native-root",
            threadId: "native-child",
            name: "Research",
            task: "Browse",
            status: "completed",
            nativeStatus: "idle",
          },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<NativeSessionTrees trees={trees} />);
    expect(html).toContain('data-testid="native-session-panel"');
    expect(html).toContain("max-h-44");
    expect(html).toContain("overflow-y-auto");
    expect(html).toContain("<details open");
    expect(html).toContain('data-native-thread-id="native-root"');
    expect(html).toContain('data-root-thread-id="native-root"');
    expect(html).toContain('data-native-thread-id="native-child"');
    expect(html).toContain('data-parent-thread-id="native-root"');
    expect(html).toContain('data-depth="1"');
    expect(html).toContain('data-status="completed"');
    expect(html).toContain("idle");
    expect(html).not.toContain("href=");
    expect(html).not.toContain("onClick");
    expect(html).not.toContain("Browse");
  });

  it("adds no empty chrome for legacy-only transcripts", () => {
    expect(renderToStaticMarkup(<NativeSessionTrees trees={[]} />)).toBe("");
  });
});
