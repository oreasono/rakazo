import { buildNativeSessionTrees } from "@rakazo/core";
import { lightTokens } from "@rakazo/ui-tokens";
import type { CSSProperties, ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NativeSessionTrees } from "../components/native-session-tree";

vi.mock("./native", () => ({ useMobileTokens: () => lightTokens }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({
    children,
    selectable,
    style,
  }: {
    children?: ReactNode;
    selectable?: boolean;
    style?: CSSProperties | CSSProperties[];
  }) =>
    createElement(
      "span",
      {
        "data-selectable": selectable,
        style: Array.isArray(style) ? Object.assign({}, ...style) : style,
      },
      children,
    ),
  Pressable: ({ children }: { children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  ScrollView: ({ children, style }: { children?: ReactNode; style?: { maxHeight: number } }) =>
    createElement("section", { "data-max-height": style?.maxHeight }, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));

describe("mobile native sessions", () => {
  it.each([
    ["recovering", "Recovering", "warning"],
    ["interrupted", "Interrupted", "destructive"],
    ["recovery_required", "Needs review", "destructive"],
  ] as const)("renders %s without a success color", (nativeStatus, label, tone) => {
    const html = renderToStaticMarkup(
      <NativeSessionTrees
        trees={[
          {
            runtime: "codex",
            rootThreadId: "root",
            nodes: [
              { threadId: "root", depth: 0, status: "failed", nativeStatus },
              {
                threadId: "child",
                parentThreadId: "root",
                depth: 1,
                status: "completed",
                nativeStatus,
              },
            ],
          },
        ]}
      />,
    );
    expect(html.match(new RegExp(`>${label}</span>`, "g"))).toHaveLength(2);
    expect(html.match(new RegExp(`color:${lightTokens[tone]}`, "g"))).toHaveLength(2);
    expect(html).toContain(">child</span>");
    expect(html).not.toContain(`color:${lightTokens.success}`);
  });

  it("shows root and child IDs by default in a bounded panel without repeating task content", () => {
    const trees = buildNativeSessionTrees([
      {
        id: "persisted",
        seq: 1,
        blocks: [
          {
            kind: "subagent",
            runtime: "codex",
            rootThreadId: "native-root",
            threadId: "native-root",
            agentId: "native-root",
            parentThreadId: null,
            name: "Main",
            task: "",
            status: "running",
          },
          {
            kind: "subagent",
            runtime: "codex",
            rootThreadId: "native-root",
            threadId: "native-child",
            agentId: "native-child",
            parentThreadId: "native-root",
            name: "Research",
            task: "Internal task prompt",
            status: "completed",
            result: "Internal result",
          },
        ],
      },
    ]);
    const html = renderToStaticMarkup(<NativeSessionTrees trees={trees} />);
    expect(html).toMatch(/data-selectable="true"[^>]*>native-root/);
    expect(html).toMatch(/data-selectable="true"[^>]*>native-child/);
    expect(html).toContain('data-max-height="176"');
    expect(html).toContain("running");
    expect(html).not.toContain("Internal task prompt");
    expect(html).not.toContain("Internal result");
    expect(html).not.toContain("href=");
  });

  it("does not show Codex chrome for a legacy-only transcript", () => {
    const trees = buildNativeSessionTrees([
      {
        id: "stored",
        blocks: [
          {
            kind: "subagent",
            agentId: "short-task",
            name: "Research",
            task: "Search",
            status: "completed",
          },
        ],
      },
    ]);
    expect(renderToStaticMarkup(<NativeSessionTrees trees={trees} />)).toBe("");
  });
});
