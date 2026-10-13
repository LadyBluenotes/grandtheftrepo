import type { KnowledgeVerifyResult, PolicyAgent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as Readiness from "../Readiness.ts";
import * as KnowledgeStore from "./KnowledgeStore.ts";

const FILES: Readiness.Check = { id: "files", label: "Instruction files writable", target: null };
const DELIVERED: Readiness.Check = {
  id: "delivered",
  label: "Accepted pages delivered",
  target: "plugin",
};

const NAME: Record<PolicyAgent, string> = { claude: "Claude", codex: "Codex", copilot: "Copilot" };

/** One project instruction file the index goes into, and whether the server can write it. */
export interface InstructionFile {
  readonly path: string;
  readonly writable: boolean;
}

/** The index goes into the project instruction file of each agent in use; each must be writable. */
export const filesCheck = (files: ReadonlyArray<InstructionFile>) => {
  if (files.length === 0) {
    return Readiness.attention(
      FILES,
      "No agent is in use, so no instruction file in the project gets the knowledge index.",
    );
  }
  const blocked = files.filter((file) => !file.writable);
  if (blocked.length === 0) {
    return Readiness.ready(
      FILES,
      `The server can write ${Readiness.list(files.map((file) => file.path))}.`,
    );
  }
  return Readiness.attention(
    FILES,
    `The server cannot write ${Readiness.list(blocked.map((file) => file.path))}, so the knowledge index cannot be installed there.`,
  );
};

/** Every agent in use holds the accepted pages and the index as they render now (`verify`). */
export const deliveredCheck = (accepted: number, results: ReadonlyArray<KnowledgeVerifyResult>) => {
  const pages = `${accepted} accepted ${accepted === 1 ? "page" : "pages"}`;
  if (results.length === 0) {
    return accepted === 0
      ? Readiness.ready(DELIVERED, "No page is accepted yet, so none is due.")
      : Readiness.attention(DELIVERED, `No agent is in use, so ${pages} are indexed for none.`);
  }
  const gaps = results.filter((result) => result.status !== "ok");
  if (gaps.length === 0) {
    return Readiness.ready(
      DELIVERED,
      accepted === 0
        ? "No page is accepted yet, so none is due."
        : `${pages} ${accepted === 1 ? "is" : "are"} delivered and indexed for ${Readiness.list(results.map((result) => NAME[result.agent]))}.`,
    );
  }
  return Readiness.attention(
    DELIVERED,
    `Pages are not as accepted for ${Readiness.list(gaps.map((result) => `${NAME[result.agent]} (${result.status})`))}; install from the Knowledge screen.`,
  );
};

/** Knowledge's readiness: both checks are about one project, so none without one. */
export class KnowledgeReadiness extends Context.Service<KnowledgeReadiness, Readiness.Checks>()(
  "t3/plugins/knowledge/readiness/KnowledgeReadiness",
) {}

export const layer = Layer.effect(
  KnowledgeReadiness,
  Effect.gen(function* () {
    const store = yield* KnowledgeStore.KnowledgeStore;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** An install creates missing directories, so a missing file is writable where its nearest existing ancestor is. */
    const writable = Effect.fn("KnowledgeReadiness.writable")(function* (filePath: string) {
      let target = filePath;
      while (!(yield* fs.exists(target))) {
        const parent = path.dirname(target);
        if (parent === target) break;
        target = parent;
      }
      return yield* fs.access(target, { writable: true }).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    });

    return KnowledgeReadiness.of({
      checks: (projectId) =>
        projectId === null
          ? Effect.succeed([])
          : Effect.gen(function* () {
              const results = yield* store.verify({ projectId });
              const files = yield* Effect.forEach(results, (result) =>
                Effect.map(writable(result.path), (ok) => ({ path: result.path, writable: ok })),
              );
              const accepted = yield* store.list({ projectId, state: "accepted" });
              return [filesCheck(files), deliveredCheck(accepted.length, results)];
            }).pipe(
              // `verify` resolves the project and its agents, so neither check stands without it.
              Effect.catch((error) =>
                Effect.succeed([
                  Readiness.unreadable(FILES, error),
                  Readiness.unreadable(DELIVERED, error),
                ]),
              ),
            ),
    });
  }),
);
