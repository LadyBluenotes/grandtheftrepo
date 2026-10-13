import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";

import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsSection } from "../settings/components/SettingsSection";
import { boardEntryVisible } from "./boardGroups";
import { kanbanActive } from "./state";

/**
 * A Board row for each checkout whose server runs the kanban plugin; with none, nothing renders.
 * A project open on two servers has two boards, so its rows say which server they belong to.
 */
export function KanbanBoardEntries(props: {
  readonly members: readonly EnvironmentProject[];
  readonly environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }[];
}) {
  const named = props.members.length > 1;
  return props.members.map((member) => (
    <KanbanBoardEntry
      key={`${member.environmentId}:${member.id}`}
      member={member}
      environmentLabel={
        named
          ? (props.environments.find((entry) => entry.environmentId === member.environmentId)
              ?.label ?? null)
          : null
      }
    />
  ));
}

function KanbanBoardEntry(props: {
  readonly member: EnvironmentProject;
  readonly environmentLabel: string | null;
}) {
  const { environmentId, id: projectId } = props.member;
  const navigation = useNavigation();
  const active = useAtomValue(kanbanActive(environmentId));
  if (!boardEntryVisible(active)) return null;
  return (
    <SettingsSection>
      <SettingsRow
        icon="square.split.2x1"
        label="Board"
        {...(props.environmentLabel === null ? {} : { value: props.environmentLabel })}
        valuePosition="below"
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: { screen: "SettingsKanbanBoard", params: { environmentId, projectId } },
          })
        }
      />
    </SettingsSection>
  );
}
