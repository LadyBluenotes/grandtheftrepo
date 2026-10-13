import { Link } from "@tanstack/react-router";
import type { EnvironmentId, ReadinessCheck } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import {
  SettingsRow,
  SettingsSection,
  scrollToSettingsTarget,
} from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "~/components/ui/collapsible";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useProjects } from "~/state/entities";
import { usePluginEnvironmentId } from "../pluginState";
import { pluginRegistry } from "../registry";
import {
  GROUP_BADGE,
  pluginRowId,
  readinessGroups,
  readinessLink,
  usePluginReadiness,
  type ReadinessLink,
} from "./state";

const titleOf = (plugin: string) =>
  pluginRegistry.find((entry) => entry.id === plugin)?.title ?? plugin;
const hasScreen = (plugin: string) =>
  pluginRegistry.some((entry) => entry.id === plugin && entry.Screen !== undefined);

/**
 * What each plugin needs to do its work, above the plugin list: one row per plugin with the
 * checks that need a person and, folded away, the ready ones. The project is the environment's
 * first until a person picks another.
 */
export function ReadinessChecklist() {
  // Project ids belong to one environment, so the selection starts over with it.
  const environmentId = usePluginEnvironmentId();
  return environmentId === null ? null : (
    <Checklist key={environmentId} environmentId={environmentId} />
  );
}

function Checklist({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [projectId, setProjectId] = useState<string | null>(null);
  const selected = projects.find((project) => project.id === projectId) ?? projects[0];
  const report = usePluginReadiness(environmentId, selected?.id ?? null);
  const groups = useMemo(() => readinessGroups(report.data ?? [], titleOf), [report.data]);

  // A failed re-read keeps the last data, so the error is checked first and stale checks never show.
  if (report.error === null && report.data === null) return null;
  const context = { environmentId, projectId: selected?.id ?? null };

  return (
    <SettingsSection
      title="Readiness"
      headerAction={
        projects.length === 0 ? null : (
          <Select<string>
            value={selected?.id ?? null}
            onValueChange={(value) => {
              const next = projects.find((project) => project.id === value);
              if (next !== undefined) setProjectId(next.id);
            }}
          >
            <SelectTrigger size="xs" variant="ghost" aria-label="Project">
              <SelectValue>{selected?.title}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        )
      }
    >
      {report.error !== null ? (
        <SettingsRow title="Could not check readiness" description={report.error} />
      ) : (
        groups.map((group) => {
          const badge = GROUP_BADGE[group.status];
          const linkOf = (check: ReadinessCheck) =>
            readinessLink(check.target, {
              plugin: group.plugin,
              title: group.title,
              hasScreen: hasScreen(group.plugin),
              ...context,
            });
          return (
            <SettingsRow
              key={group.plugin}
              title={group.title}
              status={
                <Badge size="sm" variant={badge.variant}>
                  {badge.label}
                </Badge>
              }
            >
              <div className="flex flex-col pb-2">
                {group.open.map((check) => (
                  <CheckLine key={check.id} check={check} link={linkOf(check)} />
                ))}
                {group.ready.length === 0 ? null : (
                  <Collapsible>
                    <CollapsibleTrigger render={<Button size="xs" variant="ghost-muted" />}>
                      {group.ready.length} ready
                    </CollapsibleTrigger>
                    <CollapsiblePanel>
                      {group.ready.map((check) => (
                        <CheckLine key={check.id} check={check} link={null} />
                      ))}
                    </CollapsiblePanel>
                  </Collapsible>
                )}
              </div>
            </SettingsRow>
          );
        })
      )}
    </SettingsSection>
  );
}

/** One check: its name, its sentence, and where to fix it. */
function CheckLine({
  check,
  link,
}: {
  readonly check: ReadinessCheck;
  readonly link: ReadinessLink | null;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0 space-y-0.5 text-xs">
        <p className="font-medium text-foreground">{check.label}</p>
        <p className="text-muted-foreground">{check.sentence}</p>
      </div>
      {link === null ? null : (
        <div className="shrink-0">
          <CheckLink link={link} />
        </div>
      )}
    </div>
  );
}

function CheckLink({ link }: { readonly link: ReadinessLink }) {
  switch (link.kind) {
    case "row":
      return (
        <Button
          size="xs"
          variant="outline"
          onClick={() => scrollToSettingsTarget(pluginRowId(link.plugin))}
        >
          {link.label}
        </Button>
      );
    case "screen":
      return (
        <Button size="xs" variant="outline" render={<Link to={link.to} params={link.params} />}>
          {link.label}
        </Button>
      );
    case "board":
      return (
        <Button size="xs" variant="outline" render={<Link to={link.to} search={link.search} />}>
          {link.label}
        </Button>
      );
    case "usage":
      return (
        <Button size="xs" variant="outline" render={<Link to={link.to} />}>
          {link.label}
        </Button>
      );
    case "scheduled_tasks":
      return (
        <Button size="xs" variant="outline" render={<Link to={link.to} search={link.search} />}>
          {link.label}
        </Button>
      );
  }
}
