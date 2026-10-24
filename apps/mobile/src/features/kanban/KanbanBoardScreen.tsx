import { useAtomValue } from "@effect/atom-react";
import { LegendList } from "@legendapp/list/react-native";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, KanbanBoard, ProjectId, ThreadId } from "@t3tools/contracts";
import { memo, useCallback, useMemo, useState } from "react";
import { Platform, RefreshControl, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { RowPressable } from "../../components/ui/RowPressable";
import { AppBar } from "../../components/ui/AppBar";
import { useThreadShells } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { SettingsScreenContent } from "../settings/components/SettingsScreen";
import { AttentionStrip } from "./AttentionStrip";
import { boardState, boardThread, type BoardRow, type BoardState } from "./boardGroups";
import { kanbanActive, kanbanBoard } from "./state";
import { useSnoozeWake } from "./useSnoozeWake";

type ListItem =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | {
      readonly kind: "row";
      readonly key: string;
      readonly row: BoardRow;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    };

function listItems(state: BoardState): ReadonlyArray<ListItem> {
  if (state.kind !== "groups") return [];
  return state.groups.flatMap((group) => [
    {
      kind: "header" as const,
      key: group.status,
      label: group.label,
      count: group.rows.length,
    },
    ...group.rows.map((row, index) => ({
      kind: "row" as const,
      key: row.id,
      row,
      isFirst: index === 0,
      isLast: index === group.rows.length - 1,
    })),
  ]);
}

/**
 * A project's tickets grouped by column, under the strip of what waits on you. Read-only: tapping a
 * ticket or a strip row about a thread opens that thread.
 */
export function KanbanBoardScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>) {
  // Key the pull state to the board even when navigation reuses this screen.
  return (
    <BoardList
      key={`${route.params.environmentId}:${route.params.projectId}`}
      environmentId={route.params.environmentId}
      projectId={route.params.projectId}
    />
  );
}

function BoardList(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const { environmentId, projectId } = props;
  const navigation = useNavigation();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const active = useAtomValue(kanbanActive(environmentId));
  // The board is a live subscription: the server pushes a snapshot after every change to the
  // tickets, so nothing here polls and the refresh below only resubscribes.
  const board = useEnvironmentQuery(
    active === true ? kanbanBoard({ environmentId, input: { projectId } }) : null,
  );
  const shells = useThreadShells();
  // A snooze ending emits no event, so the rows are computed again when the earliest one does.
  const [snoozeWakeTick, setSnoozeWakeTick] = useState(0);
  const threads = useMemo(() => {
    const now = new Date().toISOString();
    const byId = new Map<ThreadId, EnvironmentThreadShell>();
    for (const shell of shells) {
      if (shell.environmentId === environmentId) byId.set(shell.id, shell);
    }
    return {
      byId,
      threadOf: (id: ThreadId) => {
        const shell = byId.get(id);
        return shell === undefined ? undefined : boardThread(shell, now);
      },
    };
  }, [environmentId, shells, snoozeWakeTick]);
  const state = useMemo(
    () => boardState({ active, board: board.data, error: board.error, threadOf: threads.threadOf }),
    [active, board.data, board.error, threads],
  );
  useSnoozeWake(
    state.kind === "groups" ? state.nextWakeAt : null,
    snoozeWakeTick,
    setSnoozeWakeTick,
  );
  const items = useMemo(() => listItems(state), [state]);

  // A live subscription never settles, so a pull ends when the next snapshot (a new object) or
  // a failure arrives.
  const [pulledFrom, setPulledFrom] = useState<{ readonly board: KanbanBoard | null } | null>(null);
  const refreshing = pulledFrom !== null && pulledFrom.board === board.data && board.error === null;
  const { refresh } = board;
  const onRefresh = useCallback(() => {
    setPulledFrom({ board: board.data });
    refresh();
  }, [board.data, refresh]);

  const openThread = useCallback(
    (threadId: ThreadId) => {
      const shell = threads.byId.get(threadId);
      if (shell !== undefined) selectThread(shell);
    },
    [selectThread, threads],
  );
  // Where the plugin runs, what waits on the person sits above the groups, tickets or not.
  const attentionStrip = useMemo(
    () =>
      active === true ? (
        <AttentionStrip
          environmentId={environmentId}
          projectId={projectId}
          onOpenThread={openThread}
        />
      ) : undefined,
    [active, environmentId, projectId, openThread],
  );
  const renderItem = useCallback(
    ({ item }: { readonly item: ListItem }) =>
      item.kind === "header" ? (
        <GroupHeader label={item.label} count={item.count} />
      ) : (
        <BoardRowView
          row={item.row}
          isFirst={item.isFirst}
          isLast={item.isLast}
          onOpen={openThread}
        />
      ),
    [openThread],
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar title="Board" sidebar={false} onBack={() => navigation.goBack()} />
      <SettingsScreenContent>
        {state.kind === "unavailable" ? (
          <View className="px-4 pt-4">
            <EmptyState title="Board unavailable" detail={state.message} />
          </View>
        ) : (
          <LegendList
            className="flex-1"
            contentContainerStyle={{ paddingBottom: 32, paddingHorizontal: 16, paddingTop: 4 }}
            contentInsetAdjustmentBehavior="automatic"
            data={items}
            estimatedItemSize={64}
            getItemType={(item) => item.kind}
            keyExtractor={(item) => item.key}
            ListEmptyComponent={<BoardMessage state={state} onRetry={onRefresh} />}
            ListHeaderComponent={attentionStrip}
            refreshControl={
              <RefreshControl
                onRefresh={onRefresh}
                refreshing={refreshing}
                tintColorClassName={String("accent-icon")}
              />
            }
            renderItem={renderItem}
            showsVerticalScrollIndicator={false}
          />
        )}
      </SettingsScreenContent>
    </View>
  );
}

function BoardMessage(props: { readonly state: BoardState; readonly onRetry: () => void }) {
  switch (props.state.kind) {
    case "loading":
      return (
        <View className="items-center py-16">
          <AppActivityIndicator colorClassName="accent-icon" />
          <Text className="mt-3 text-sm text-foreground-muted">Loading board...</Text>
        </View>
      );
    case "failed":
      return (
        <EmptyState
          title="Could not load the board"
          detail={props.state.message}
          actionLabel="Try again"
          onAction={props.onRetry}
        />
      );
    case "empty":
      return (
        <EmptyState title={props.state.message} detail="Tickets filed on the board show up here." />
      );
    case "unavailable":
    case "groups":
      return null;
  }
}

function GroupHeader(props: { readonly label: string; readonly count: number }) {
  return (
    <View className="flex-row items-center gap-2 px-1 pt-4 pb-2">
      <Text
        className="flex-1 text-xs font-t3-medium tracking-[0.5px] uppercase text-foreground-muted"
        numberOfLines={1}
      >
        {props.label}
      </Text>
      <Text className="text-xs tabular-nums text-foreground-tertiary">{props.count}</Text>
    </View>
  );
}

const ROW_RADIUS = 20;

const BoardRowView = memo(function BoardRowView(props: {
  readonly row: BoardRow;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
}) {
  const { row, onOpen } = props;
  const threadId = row.threadId;
  return (
    <RowPressable
      accessibilityRole={threadId === null ? "text" : "button"}
      accessibilityLabel={[row.title, ...row.labels].join(", ")}
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
        <Text className="text-base font-t3-bold leading-snug text-foreground" numberOfLines={2}>
          {row.title}
        </Text>
        {row.labels.length > 0 ? (
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {row.labels.join(" · ")}
          </Text>
        ) : null}
      </View>
    </RowPressable>
  );
});
