import {
  POLICY_ENVIRONMENT_PROJECT_ID,
  PONYTAIL_RUNG_IDS,
  type PonytailRungId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PolicyService from "./PolicyService.ts";

/** The built-in environment-wide policy (`*` / `ponytail`) that states the ladder to every agent. */
export const PONYTAIL_KEY = "ponytail";

const RUNGS: Record<PonytailRungId, { readonly question: string; readonly action: string }> = {
  needed: { question: "Does it need to exist?", action: "If not, do not add it." },
  existing: { question: "Is it already in this codebase?", action: "Reuse it." },
  platform: { question: "Does the standard library or platform do it?", action: "Use that." },
  dependency: {
    question: "Does an installed dependency do it?",
    action: "Use that. Add no dependency for a few lines.",
  },
  one_line: { question: "Can it be one line?", action: "Write the line." },
  minimum: { question: "None of the above?", action: "Write the minimum that works." },
};

/** The ladder in the order of `PONYTAIL_RUNG_IDS`, one line per rung with its id in code. */
export const PONYTAIL_TEXT = [
  "## Before you add anything",
  "",
  "Ask these in order, and use the first rung that applies.",
  "",
  ...PONYTAIL_RUNG_IDS.map(
    (id, index) => `${index + 1}. \`${id}\`: ${RUNGS[id].question} ${RUNGS[id].action}`,
  ),
  "",
  "Source: https://github.com/DietrichGebert/ponytail",
].join("\n");

/**
 * Creates version 1 of the `ponytail` policy from `PONYTAIL_TEXT` and accepts it, unless a
 * `*` / `ponytail` policy already exists in any state: an edited or replaced ladder is the user's
 * and is never overwritten. The delivery sweep then writes it into the agents' instruction files
 * like any accepted policy. A failure is logged and the next start tries again.
 */
export const seed = Effect.fn("Ponytail.seed")(
  function* () {
    const policies = yield* PolicyService.PolicyService;
    const existing = yield* policies.list(POLICY_ENVIRONMENT_PROJECT_ID);
    if (existing.some((policy) => policy.key === PONYTAIL_KEY)) return;
    const projectId = POLICY_ENVIRONMENT_PROJECT_ID;
    const { version } = yield* policies.create({
      projectId,
      key: PONYTAIL_KEY,
      title: "Ponytail ladder",
      body: PONYTAIL_TEXT,
    });
    yield* policies.accept({ projectId, key: PONYTAIL_KEY, version });
  },
  Effect.catchTags({
    PolicyError: (error) =>
      Effect.logWarning("policy: could not seed the ponytail policy", { message: error.message }),
  }),
);
