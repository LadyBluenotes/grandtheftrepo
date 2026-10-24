import {
  POLICY_AGENTS,
  POLICY_ENVIRONMENT_PROJECT_ID,
  type PolicyAgent,
  type PolicyListing,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import type * as ServerSettings from "../../serverSettings.ts";
import * as Blocks from "../InstructionBlocks.ts";
import * as Readiness from "../Readiness.ts";
import * as PolicyService from "./PolicyService.ts";

const DIRECTORIES: Readiness.Check = {
  id: "directories",
  label: "Instruction directories",
  target: null,
};
const DELIVERED: Readiness.Check = {
  id: "delivered",
  label: "Environment policies delivered",
  target: "plugin",
};

/** The provider driver whose default instance each agent's home comes from, as `Blocks.targets` reads it. */
const DRIVER: Record<PolicyAgent, string> = {
  claude: "claudeAgent",
  codex: "codex",
  copilot: "copilot",
};
const NAME: Record<PolicyAgent, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

/** Where one agent reads its instruction file from, and whether anything uses it. */
export interface AgentHome {
  readonly agent: PolicyAgent;
  readonly directory: string;
  /** A provider of the agent's driver is enabled. */
  readonly enabled: boolean;
  readonly exists: boolean;
}

/** Every agent in use, one whose provider is enabled, needs its home for a policy to reach it. */
export const directoriesCheck = (homes: ReadonlyArray<AgentHome>) => {
  const inUse = homes.filter((home) => home.enabled);
  if (inUse.length === 0) {
    return Readiness.attention(
      DIRECTORIES,
      "No Claude, Codex or Copilot provider is enabled, so no agent reads the policies.",
    );
  }
  const missing = inUse.filter((home) => !home.exists);
  const [only] = missing;
  if (only === undefined) {
    const names = Readiness.list(inUse.map((home) => NAME[home.agent]));
    return Readiness.ready(
      DIRECTORIES,
      inUse.length === 1
        ? `${names} has its instruction directory.`
        : `${names} each have their instruction directory.`,
    );
  }
  return Readiness.attention(
    DIRECTORIES,
    missing.length === 1
      ? `${NAME[only.agent]}'s directory ${only.directory} does not exist, so no policy reaches it; run ${NAME[only.agent]} once to create it.`
      : `The directories of ${Readiness.list(missing.map((home) => `${NAME[home.agent]} (${home.directory})`))} do not exist, so no policy reaches them; run each once to create its directory.`,
  );
};

/**
 * Every accepted environment (`*`) policy is intact and current in the file of each agent whose
 * directory exists, the agents the delivery sweep writes to.
 */
export const deliveredCheck = (
  listings: ReadonlyArray<PolicyListing>,
  delivering: ReadonlyArray<PolicyAgent>,
) => {
  const accepted = listings.filter(
    (listing) =>
      listing.projectId === POLICY_ENVIRONMENT_PROJECT_ID && listing.state === "accepted",
  );
  const count = `${accepted.length} accepted environment ${accepted.length === 1 ? "policy" : "policies"}`;
  if (accepted.length === 0) {
    return Readiness.ready(DELIVERED, "No environment policy is accepted, so none is due.");
  }
  if (delivering.length === 0) {
    return Readiness.attention(
      DELIVERED,
      `No agent has an instruction directory, so ${count} reach no agent.`,
    );
  }
  const gaps = accepted.flatMap((listing) =>
    delivering.flatMap((agent) => {
      const status = listing.status.find((entry) => entry.agent === agent)?.status ?? "missing";
      return status === "ok" ? [] : [`${listing.key} is ${status} for ${NAME[agent]}`];
    }),
  );
  if (gaps.length === 0) {
    return Readiness.ready(
      DELIVERED,
      `${count} ${accepted.length === 1 ? "is" : "are"} delivered to ${Readiness.list(delivering.map((agent) => NAME[agent]))}.`,
    );
  }
  return Readiness.attention(
    DELIVERED,
    Readiness.sentence(`${Readiness.list(gaps)}; install from the Policies screen`),
  );
};

/** Policy's readiness: environment-wide, so the project is not read. */
export class PolicyReadiness extends Context.Service<PolicyReadiness, Readiness.Checks>()(
  "t3/plugins/policy/readiness/PolicyReadiness",
) {}

export const layer = Layer.effect(
  PolicyReadiness,
  Effect.gen(function* () {
    const policies = yield* PolicyService.PolicyService;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const services = yield* Effect.context<Path.Path | ServerSettings.ServerSettingsService>();

    const homes = Effect.gen(function* () {
      const targets = yield* Effect.provideContext(Blocks.targets(), services);
      // Read where the call runs, as the weekly report seed reads scheduled tasks, so the plugin's
      // layer and its tests need no provider registry. The server always has one.
      const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
      const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
      const enabled = new Set(
        providers.filter((provider) => provider.enabled).map((provider): string => provider.driver),
      );
      return yield* Effect.forEach(POLICY_AGENTS, (agent) => {
        const directory = path.dirname(targets[agent]);
        return Effect.map(fs.exists(directory), (exists): AgentHome => ({
          agent,
          directory,
          enabled: enabled.has(DRIVER[agent]),
          exists,
        }));
      });
    });

    return PolicyReadiness.of({
      checks: () =>
        Effect.all([
          homes.pipe(Effect.map(directoriesCheck), Readiness.orAttention(DIRECTORIES)),
          Effect.gen(function* () {
            const delivering = (yield* homes)
              .filter((home) => home.exists)
              .map((home) => home.agent);
            const listings = yield* policies.listWithStatus(POLICY_ENVIRONMENT_PROJECT_ID);
            return deliveredCheck(listings, delivering);
          }).pipe(Readiness.orAttention(DELIVERED)),
        ]),
    });
  }),
);
