import { CAVEMAN_INSTALL_COMMAND } from "@t3tools/contracts";
import { spawnAndCollect, type CommandResult } from "@t3tools/provider-core/server/snapshotProbe";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

/** The one message for a missing binary; the status panel and the learn scan show the same command. */
export const INSTALL_REFUSAL = `caveman is not installed. Run: ${CAVEMAN_INSTALL_COMMAND}`;

export type Outcome =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "TimedOut" }
  | ({ readonly _tag: "Exited" } & CommandResult);

/**
 * Runs `caveman <args>` found on `env.PATH`, in `cwd`, and never fails: a binary that is not there
 * is `Missing`, a command that overruns `timeout` is `TimedOut` and its process is killed.
 * shortcut: any failure to spawn reads as `Missing`, so a `caveman` that exists but cannot run says
 * to install it; tell the two apart if that ever misleads someone.
 */
export const run = (input: {
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly timeout: Duration.Input;
}): Effect.Effect<Outcome, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawn = yield* resolveSpawnCommand("caveman", input.args, { env: input.env });
    const command = ChildProcess.make(spawn.command, spawn.args, {
      env: input.env,
      cwd: input.cwd,
      shell: spawn.shell,
    });
    return yield* spawnAndCollect("caveman", command).pipe(
      Effect.map((result): Outcome => ({ _tag: "Exited", ...result })),
      Effect.timeoutOption(input.timeout),
      Effect.map(Option.getOrElse((): Outcome => ({ _tag: "TimedOut" }))),
    );
  }).pipe(Effect.catch(() => Effect.succeed<Outcome>({ _tag: "Missing" })));

/** A failed command's last stderr line, bounded, or its exit code when stderr is empty. */
export const failureLine = (result: CommandResult) =>
  result.stderr.trim().split("\n").pop()?.trim().slice(0, 300) ||
  `caveman exited with code ${result.code}.`;
