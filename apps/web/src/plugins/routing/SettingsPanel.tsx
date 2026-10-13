import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ROUTING_TIERS,
  type RoutingEntry,
  type RoutingScope,
  type RoutingSource,
  type RoutingTier,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useProjects } from "~/state/entities";
import { offeredModels, useRoutingSetTier, useRoutingTiers } from "./state";
import { useReadinessChanged } from "../readiness/state";
import { usePluginEnvironmentId, usePluginServerConfig } from "../pluginState";

const SOURCE_BADGE: Record<
  RoutingSource,
  { readonly label: string; readonly variant: "info" | "secondary" | "outline" }
> = {
  project: { label: "Project", variant: "info" },
  environment: { label: "Environment", variant: "secondary" },
  builtin: { label: "Built-in", variant: "outline" },
};

/**
 * Which model each tier uses, for the Plugins page's environment or for one of its projects. A project
 * with no entry of its own shows the one it inherits; choosing something saves an override.
 */
export function SettingsPanel() {
  const environmentId = usePluginEnvironmentId();
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const { providers, settings } = usePluginServerConfig();
  const preferences = settings.providerModelPreferences;
  const [scope, setScope] = useState<RoutingScope>("environment");
  const tiers = useRoutingTiers(scope);
  const { canWrite, set } = useRoutingSetTier();
  const readinessChanged = useReadinessChanged();

  const save = async (tier: RoutingTier, entry: RoutingEntry | null) => {
    const result = await set({ scope, tier, entry });
    if (result._tag === "Success") {
      tiers.refresh();
      readinessChanged();
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not save the tier",
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };

  const instances = providers.filter((provider) => offeredModels(provider, preferences).length > 0);

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="w-56">
        <Select<string>
          value={scope}
          onValueChange={(value) =>
            setScope(projects.find((project) => project.id === value)?.id ?? "environment")
          }
        >
          <SelectTrigger size="sm" aria-label="Scope">
            <SelectValue>
              {scope === "environment"
                ? "Environment"
                : (projects.find((project) => project.id === scope)?.title ?? scope)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="environment">Environment</SelectItem>
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {tiers.error !== null ? (
        <p className="text-sm text-muted-foreground">{tiers.error}</p>
      ) : (
        ROUTING_TIERS.map((tier) => {
          const state = tiers.data?.[tier];
          if (state === undefined) return null;
          const { resolved, source } = state;
          const saved = scope === "environment" ? state.environment : state.project;
          const provider = providers.find(
            (candidate) => candidate.instanceId === resolved?.providerInstanceId,
          );
          return (
            <div key={tier} className="flex flex-wrap items-center gap-2">
              <span className="w-20 text-sm font-medium capitalize">{tier}</span>
              <div className="w-44">
                <Select
                  value={resolved?.providerInstanceId ?? null}
                  disabled={!canWrite || resolved === null}
                  onValueChange={(value) => {
                    const next = instances.find((candidate) => candidate.instanceId === value);
                    const model = next && offeredModels(next, preferences)[0];
                    if (next && model) {
                      void save(tier, { providerInstanceId: next.instanceId, model: model.slug });
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`${tier} provider instance`}>
                    <SelectValue placeholder="No models">
                      {provider?.displayName ?? resolved?.providerInstanceId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {instances.map((instance) => (
                      <SelectItem key={instance.instanceId} value={instance.instanceId}>
                        {instance.displayName ?? instance.instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="w-56">
                <Select
                  value={resolved?.model ?? null}
                  disabled={!canWrite || resolved === null}
                  onValueChange={(value) => {
                    if (resolved && typeof value === "string") {
                      void save(tier, {
                        providerInstanceId: resolved.providerInstanceId,
                        model: value,
                      });
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label={`${tier} model`}>
                    <SelectValue placeholder="No models">
                      {provider?.models.find((model) => model.slug === resolved?.model)?.name ??
                        resolved?.model}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {(provider ? offeredModels(provider, preferences) : []).map((model) => (
                      <SelectItem key={model.slug} value={model.slug}>
                        {model.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              {source === null ? null : (
                <Badge size="sm" variant={SOURCE_BADGE[source].variant}>
                  {SOURCE_BADGE[source].label}
                </Badge>
              )}
              {resolved !== null && !state.available ? (
                <Badge size="sm" variant="warning">
                  Not offered
                </Badge>
              ) : null}
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canWrite || saved === null}
                onClick={() => void save(tier, null)}
              >
                Clear
              </Button>
            </div>
          );
        })
      )}
    </div>
  );
}
