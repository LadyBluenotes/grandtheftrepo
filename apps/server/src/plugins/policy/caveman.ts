/**
 * The default body below is adapted from the Caveman skill (skills/caveman/SKILL.md in
 * https://github.com/JuliusBrussee/caveman), Copyright 2026 Julius Brussee, licensed under the
 * Apache License, Version 2.0. Changes: the skill's reply rules are rewritten and condensed into
 * one block for an instruction file, and its activation, persistence and intensity modes are left
 * out. The license text and this notice are the "Caveman reply rules" entry of
 * `third-party-licenses.config.json`, which the app lists under Open source licenses.
 */
import { POLICY_ENVIRONMENT_PROJECT_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as PolicyService from "./PolicyService.ts";

/** The built-in environment-wide policy (`*` / `caveman`) that tells every agent to reply tersely. */
export const CAVEMAN_KEY = "caveman";

/**
 * The rules, adapted from Caveman (see the notice at the top of the file). An agent loads the
 * installed block into every message of a session, so this stays under 1,200 characters.
 */
export const CAVEMAN_TEXT = [
  "Reply terse. Keep every technical fact. Drop every filler word.",
  "1. Answer first: [thing] [action] [reason]. Then the next step. No greeting, no plan announcement, no recap, no offer of help.",
  "2. One idea per sentence, at most 20 words, active voice.",
  '3. Articles may go. "not", "never", "no", "only" never go. Numbers and units stay exact.',
  "4. Code, commands, paths, identifiers and error text verbatim. Show changed lines plus one line of context, not whole files.",
  "5. Between tool calls: no text. One line before a multi-step run, one line with its result.",
  "6. Plain full sentences for: security warnings, irreversible actions, ordered steps, a question back to the user, and anything written outside chat (code, comments, commits, docs, issues, tickets).",
  '7. Never perform the style. No prefix, no "me think". If terse is not shorter, write plain.',
  "Before sending: delete an opener that announces the plan, delete a closer that recaps, check every negation and number is still there.",
].join("\n");

/**
 * Creates version 1 of the `caveman` policy from `CAVEMAN_TEXT` and accepts it, unless a
 * `*` / `caveman` policy already exists in any state: an edited or replaced body is the user's and
 * is never overwritten, which is also how a neutral version switches the style off for good. Built
 * like `Ponytail.seed`: the check, the create and the accept share one transaction, so a failed
 * accept leaves no draft behind for the next start to mistake for the user's. The delivery sweep
 * then writes the policy into the agents' instruction files. A failure is logged and the next
 * start tries again.
 */
export const seed = Effect.fn("Caveman.seed")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const policies = yield* PolicyService.PolicyService;
    const projectId = POLICY_ENVIRONMENT_PROJECT_ID;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const existing = yield* policies.list(projectId);
        if (existing.some((policy) => policy.key === CAVEMAN_KEY)) return;
        const { version } = yield* policies.create({
          projectId,
          key: CAVEMAN_KEY,
          title: "Terse replies",
          body: CAVEMAN_TEXT,
        });
        yield* policies.accept({ projectId, key: CAVEMAN_KEY, version });
      }),
    );
  },
  Effect.catchTags({
    PolicyError: (error) =>
      Effect.logWarning("policy: could not seed the caveman policy", { message: error.message }),
    SqlError: (error) =>
      Effect.logWarning("policy: could not seed the caveman policy", { cause: error }),
  }),
);
