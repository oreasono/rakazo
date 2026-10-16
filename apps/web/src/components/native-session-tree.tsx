import type { NativeSessionTree } from "@rakazo/core";
import { nativeSessionStatus } from "@rakazo/core";

const statusClass = {
  destructive: "text-destructive",
  warning: "text-warning",
  success: "text-success",
};

/** Read-only native identity: these IDs are not Rakazo bot/thread navigation targets. */
export function NativeSessionTrees({ trees }: { trees: NativeSessionTree[] }) {
  if (!trees.length) return null;
  return (
    <div
      data-testid="native-session-panel"
      className="shrink-0 border-b border-border px-4 py-2 md:px-7"
    >
      <div className="rk-scroll max-h-44 space-y-2 overflow-y-auto overscroll-contain">
        {trees.map((tree) => (
          <details
            key={tree.rootThreadId}
            open
            data-testid="native-session-tree"
            data-root-thread-id={tree.rootThreadId}
            className="rounded-lg border border-border bg-card px-3 py-1.5"
          >
            <summary className="cursor-pointer text-sm font-medium text-foreground">
              Codex <span className="text-muted-foreground">· {tree.nodes.length}</span>
            </summary>
            <ul className="mt-1 space-y-1">
              {tree.nodes.map((node) => {
                const status = nativeSessionStatus(node);
                return (
                  <li
                    key={node.threadId}
                    data-native-thread-id={node.threadId}
                    data-parent-thread-id={node.parentThreadId ?? undefined}
                    data-status={node.status}
                    data-native-status={node.nativeStatus}
                    data-depth={node.depth}
                    style={{ marginInlineStart: Math.min(node.depth, 6) * 16 }}
                    className="border-s border-border ps-2 text-xs"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="truncate text-foreground" title={node.name}>
                        {node.name || "Codex"}
                      </span>
                      {status ? (
                        <span className={`shrink-0 ${statusClass[status.tone]}`}>
                          {status.label}
                        </span>
                      ) : null}
                    </div>
                    <code className="block select-text break-all text-xs text-muted-foreground">
                      {node.threadId}
                    </code>
                    {node.unresolvedParent || node.depth > 6 ? (
                      <code className="block break-all text-xs text-muted-foreground">
                        ↑ {node.parentThreadId}
                      </code>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </details>
        ))}
      </div>
    </div>
  );
}
