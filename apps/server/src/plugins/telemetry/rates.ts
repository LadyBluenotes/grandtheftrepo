import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseRateTable, type RateTable } from "../../usage/usagePricing.ts";

/** The LiteLLM rate snapshot the Usage page saves under the state directory. */
const RATES_FILE = "usage-model-rates.json";
const decodeRatesFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ document: Schema.Unknown })),
);

/**
 * The rate snapshot's path and its table; `read` fails when there is no snapshot or it cannot be
 * decoded. shortcut: UsageService keeps its rate table private, so this reads the snapshot it
 * saves; ask UsageService for the table if that file moves.
 */
export const rateSnapshot = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly stateDir: string;
}) => {
  const filePath = input.path.join(input.stateDir, RATES_FILE);
  return {
    filePath,
    read: input.fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeRatesFile),
      Effect.map((file): RateTable => parseRateTable(file.document)),
    ),
  };
};
