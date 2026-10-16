import { buildNativeSessionTrees } from "@rakazo/core";
import { lightTokens } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NativeSessionTrees } from "../components/native-session-tree";

vi.mock("./native", () => ({ useMobileTokens: () => lightTokens }));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  Text: ({ children, selectable }: { children?: ReactNode; selectable?: boolean }) =>
    createElement("span", { "data-selectable": selectable }, children),
  Pressable: ({ children }: { children?: ReactNode }) =>
    createElement("button", { type: "button" }, children),
  ScrollView: ({ children, style }: { children?: ReactNode; style?: { maxHeight: number } }) =>
    createElement("section", { "data-max-height": style?.maxHeight }, children),
  StyleSheet: { create: <T,>(styles: T) => styles },
}));

describe("mobile native sessions", () => {
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
    expect(html).toContain('data-selectable="true">native-root');
    expect(html).toContain('data-selectable="true">native-child');
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
