import { useFocusEffect } from "@react-navigation/native";
import {
  kanbanAttentionStripRows,
  type KanbanAttentionStripRow,
} from "@t3tools/client-runtime/plugins/kanban";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useRef } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { RowPressable } from "../../components/RowPressable";
import { useEnvironmentQuery } from "../../state/query";
import { kanbanAttention } from "./state";

const ROW_RADIUS = 20;

/**
 * Everything in the project waiting on a person, above the board's groups, oldest first:
 * questions and permission requests agents are waiting on, and flags other plugins raised. A row
 * about a thread opens it; a row about the project, such as a budget, shows its text only. There
 * is no dismiss: a row leaves once the server stops returning it. Hidden while nothing waits.
 */
export function AttentionStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { data, refresh } = useEnvironmentQuery(
    kanbanAttention({ environmentId: props.environmentId, input: { projectId: props.projectId } }),
  );
  // The first focus is the mount, which already reads; a later one is a return from a thread.
  const seenFocus = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (seenFocus.current) refresh();
      seenFocus.current = true;
    }, [refresh]),
  );
  const rows = useMemo(() => kanbanAttentionStripRows(data ?? []), [data]);
  if (rows.length === 0) return null;

  return (
    <View>
      <View className="flex-row items-center gap-2 px-1 pt-4 pb-2">
        <Text
          accessibilityRole="header"
          className="flex-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted"
          numberOfLines={1}
        >
          Waiting on you
        </Text>
        <Text className="text-xs tabular-nums text-foreground-tertiary">{rows.length}</Text>
      </View>
      {rows.map((row, index) => (
        <AttentionRowView
          key={row.id}
          row={row}
          isFirst={index === 0}
          isLast={index === rows.length - 1}
          onOpen={props.onOpenThread}
        />
      ))}
    </View>
  );
}

const AttentionRowView = memo(function AttentionRowView(props: {
  readonly row: KanbanAttentionStripRow;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { row, onOpen } = props;
  const threadId = row.threadId;
  return (
    <RowPressable
      accessibilityRole={threadId === null ? "text" : "button"}
      accessibilityLabel={`${row.label}, ${row.title}. ${row.text}`}
      disabled={threadId === null}
      onPress={() => {
        if (threadId !== null) onOpen(threadId);
      }}
      className={props.isLast ? "bg-grouped-card" : "border-b border-separator bg-grouped-card"}
      style={{
        borderTopLeftRadius: props.isFirst ? ROW_RADIUS : 0,
        borderTopRightRadius: props.isFirst ? ROW_RADIUS : 0,
        borderBottomLeftRadius: props.isLast ? ROW_RADIUS : 0,
        borderBottomRightRadius: props.isLast ? ROW_RADIUS : 0,
      }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
    >
      <View className="gap-1 px-4 py-3">
        <View className="flex-row items-center gap-2">
          <Text className="text-xs font-t3-bold uppercase text-warning-foreground">
            {row.label}
          </Text>
          <Text
            className="min-w-0 flex-1 text-base font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {row.title}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted" numberOfLines={3}>
          {row.text}
        </Text>
      </View>
    </RowPressable>
  );
});
