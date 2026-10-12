import { CavemanError, type CavemanLearnScan } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Ref from "effect/Ref";
import { ChildProcessSpawner } from "effect/process";

import * as Cli from "../Cli.ts";

const SCAN_ARGS = ["learn", "scan", "--write-report", "--no-remember"];
/** caveman's own limit for a scan, passed as `CAVE_LEARN_TIMEOUT`. */
const LEARN_TIMEOUT_SECONDS = 120;
/** Ours, past caveman's, for a scan that ignores its own. */
const SCAN_TIMEOUT_SECONDS = 180;

/** What a finished scan leaves for the next status; null when it succeeded. */
const lastError = (outcome: Cli.Outcome) => {
  switch (outcome._tag) {
    case "Missing":
      return `Last scan failed: ${Cli.INSTALL_REFUSAL}`;
    case "TimedOut":
      return `Last scan failed: caveman did not finish within ${SCAN_TIMEOUT_SECONDS} seconds.`;
    case "Exited":
      return outcome.code === 0 ? null : `Last scan failed: ${Cli.failureLine(outcome)}`;
  }
};

/**
 * Runs `caveman learn scan --write-report --no-remember`, one at a time, in a fiber of the scope
 * that built it, so a scan outlives the request that started it. The scan writes caveman's own
 * report and database and replaces the canonical report, which the `caveman/learn` sweep imports
 * on its next tick.
 */
export const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const state = yield* Ref.make<CavemanLearnScan>({ running: false, lastError: null });

  const scan = (input: { readonly env: NodeJS.ProcessEnv; readonly cwd: string }) =>
    Cli.run({
      args: SCAN_ARGS,
      env: { ...input.env, CAVE_LEARN_TIMEOUT: String(LEARN_TIMEOUT_SECONDS) },
      cwd: input.cwd,
      timeout: `${SCAN_TIMEOUT_SECONDS} seconds`,
    }).pipe(
      Effect.map(lastError),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.onExit((exit) =>
        Ref.update(state, (current) => ({
          running: false,
          lastError: Exit.isSuccess(exit) ? exit.value : current.lastError,
        })),
      ),
    );

  return {
    /** Whether a scan runs, and why the last one failed. */
    state: Ref.get(state),
    /** Starts a scan in `cwd` with `env` and answers with its fiber; refuses while one runs. */
    start: (input: { readonly env: NodeJS.ProcessEnv; readonly cwd: string }) =>
      Effect.gen(function* () {
        const claimed = yield* Ref.modify(state, (current) =>
          current.running
            ? [false, current]
            : [true, { running: true, lastError: null } satisfies CavemanLearnScan],
        );
        if (!claimed) {
          return yield* new CavemanError({ code: "busy", message: "A scan is already running." });
        }
        return yield* Effect.forkIn(Effect.interruptible(scan(input)), scope);
      }).pipe(Effect.uninterruptible),
  };
});
