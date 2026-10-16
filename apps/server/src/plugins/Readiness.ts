import type { PluginStatus, ProjectId, ReadinessCheck, ReadinessTarget } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Readiness checks: what each plugin needs to do its work, shown above the plugin list on the
 * Plugins page and answered by the `plugins_readiness` tool. A plugin builds one service in its
 * layer, so it holds the plugin's own database, and `ServerPlugin.readiness` reads it with
 * `fromService`; `PluginHost.readiness` gathers every plugin's checks.
 */

/** A check before it is judged: what it is and where a person fixes it. */
export interface Check {
  readonly id: string;
  readonly label: string;
  readonly target: ReadinessTarget | null;
}

export const ready = (check: Check, sentence: string): ReadinessCheck => ({
  ...check,
  status: "ready",
  sentence,
});

export const attention = (check: Check, sentence: string): ReadinessCheck => ({
  ...check,
  status: "attention",
  sentence,
});

const withStop = (text: string) => (/[.!?]$/.test(text) ? text : `${text}.`);

/** `text` as a sentence: a capital first letter and a stop at the end. */
export const sentence = (text: string) => withStop(text.charAt(0).toUpperCase() + text.slice(1));

/**
 * A check whose inputs could not be read is `attention` with the reason, so one failure never hides
 * the plugin's other checks.
 */
export const unreadable = (check: Check, error: { readonly message: string }) =>
  attention(check, `Could not check it: ${withStop(error.message)}`);

export const orAttention =
  (check: Check) =>
  <E extends { readonly message: string }, R>(effect: Effect.Effect<ReadinessCheck, E, R>) =>
    Effect.catch(effect, (error) => Effect.succeed(unreadable(check, error)));

/** Names joined for a sentence: `a`, `a and b`, `a, b and c`. */
export const list = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A plugin's readiness service: its checks for the environment and, when given, one project. */
export interface Checks {
  readonly checks: (projectId: ProjectId | null) => Effect.Effect<ReadonlyArray<ReadinessCheck>>;
}

const RUNNING: Check = { id: "running", label: "Running", target: "plugins" };

/**
 * `ServerPlugin.readiness` from the plugin's readiness service, read where the call runs: plugin
 * services are typed as absent from the server chain, and are absent while the plugin is off.
 */
export const fromService =
  <I>(key: Context.Key<I, Checks>) =>
  (projectId: ProjectId | null): Effect.Effect<ReadonlyArray<ReadinessCheck>> =>
    Effect.flatMap(
      Effect.serviceOption(key),
      Option.match({
        onNone: () =>
          Effect.succeed([
            { ...RUNNING, status: "off", sentence: "It is not running in this process." } as const,
          ]),
        onSome: (service) => service.checks(projectId),
      }),
    );

/**
 * The one check a plugin that does not run reports, from its status: why it did not start, else
 * its own switch, else the dependency that is off, else a restart it is waiting for.
 */
export const offCheck = (status: PluginStatus): ReadinessCheck => ({
  ...RUNNING,
  status: "off",
  sentence:
    status.startError !== null
      ? `It did not start: ${withStop(status.startError)}`
      : !status.enabled
        ? "It is switched off. Switch it on and restart the server to use it."
        : status.missing.length > 0
          ? `It needs ${list(status.missing)}, which ${status.missing.length === 1 ? "is" : "are"} off.`
          : "It is switched on and starts with the next server start.",
});

/** A plugin whose checks died: one `attention` check with the reason. */
export const failedCheck = (message: string): ReadinessCheck => ({
  id: "readiness",
  label: "Checks",
  status: "attention",
  sentence: `Its checks failed: ${withStop(message)}`,
  target: null,
});
