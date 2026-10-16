import type { NativeSessionTree } from "@rakazo/core";
import { nativeSessionStatus } from "@rakazo/core";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useMobileTokens } from "../lib/native";

/** Read-only until native thread navigation is supported; never open a Codex ID as a bot ID. */
export function NativeSessionTrees({ trees }: { trees: NativeSessionTree[] }) {
  if (!trees.length) return null;
  return (
    <ScrollView
      testID="native-session-panel"
      style={styles.panel}
      contentContainerStyle={styles.panelContent}
      nestedScrollEnabled
    >
      {trees.map((tree) => (
        <SessionTree key={tree.rootThreadId} tree={tree} />
      ))}
    </ScrollView>
  );
}

function SessionTree({ tree }: { tree: NativeSessionTree }) {
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState(true);
  return (
    <View
      testID="native-session-tree"
      style={[styles.card, { backgroundColor: tokens.card, borderColor: tokens.border }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
      >
        <Text style={[styles.title, { color: tokens.foreground }]}>
          Codex · {tree.nodes.length}
        </Text>
      </Pressable>
      {expanded
        ? tree.nodes.map((node) => {
            const status = nativeSessionStatus(node);
            return (
              <View
                key={node.threadId}
                style={[
                  styles.node,
                  { marginLeft: Math.min(node.depth, 4) * 12, borderColor: tokens.border },
                ]}
              >
                <View style={styles.heading}>
                  <Text numberOfLines={1} style={[styles.name, { color: tokens.foreground }]}>
                    {node.name || "Codex"}
                  </Text>
                  {status ? (
                    <Text
                      style={{
                        fontSize: 12,
                        color: tokens[status.tone],
                      }}
                    >
                      {status.label}
                    </Text>
                  ) : null}
                </View>
                <Text selectable style={[styles.id, { color: tokens.mutedForeground }]}>
                  {node.threadId}
                </Text>
                {node.unresolvedParent || node.depth > 4 ? (
                  <Text selectable style={[styles.id, { color: tokens.mutedForeground }]}>
                    ↑ {node.parentThreadId}
                  </Text>
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { maxHeight: 176, flexGrow: 0, flexShrink: 0 },
  panelContent: { gap: 8, paddingBottom: 8 },
  card: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  title: { fontSize: 14, fontWeight: "600", paddingVertical: 2 },
  node: { borderLeftWidth: 1, paddingLeft: 8, marginTop: 4 },
  heading: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  name: { fontSize: 13, flexShrink: 1 },
  id: { fontSize: 11, marginTop: 2 },
});
