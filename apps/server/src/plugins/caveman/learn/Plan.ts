import { CavemanLearnClass, CavemanLearnFraming } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** The only report version this plugin reads. */
const PLAN_SCHEMA = "caveman.learn.v1";

/** caveman leaves `tokens_observed` out when it is zero, so every count may be missing. */
const Tokens = Schema.optional(Schema.NullOr(Schema.Number));

const Sink = Schema.Struct({
  sink_id: Schema.String,
  title: Schema.String,
  class: CavemanLearnClass,
  framing: CavemanLearnFraming,
  basis: Schema.String,
  tokens_per_turn: Tokens,
  tokens_observed: Tokens,
  tokens_per_day_rate: Tokens,
  suggestion: Schema.String,
  // caveman writes its Go maps and slices, so an empty one can arrive as null.
  evidence: Schema.optional(Schema.NullOr(Schema.JsonObject)),
});

/**
 * The subset of caveman's `caveman.learn.v1` plan this plugin keeps; every other field is ignored.
 * The sinks arrive ranked, so their order is their rank.
 */
const PlanSchema = Schema.Struct({
  schema: Schema.Literal(PLAN_SCHEMA),
  generated_at: Schema.DateTimeUtcFromString,
  window: Schema.Struct({ from: Schema.String, to: Schema.String }),
  cave_score: Schema.Struct({ score: Schema.Number }),
  sessions_scanned: Schema.Number,
  sinks: Schema.NullOr(Schema.Array(Sink)),
  caveats: Schema.NullOr(Schema.Array(Schema.String)),
  spend: Schema.optional(Schema.Json),
  wrap_measured: Schema.optional(Schema.Json),
});
export type Plan = typeof PlanSchema.Type;

const decodePlan = Schema.decodeUnknownResult(Schema.fromJsonString(PlanSchema));
const decodeVersion = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ schema: Schema.String })),
);
const formatIssue = SchemaIssue.makeFormatterDefault();

/**
 * A report's text as a plan, or the warning that says why it is skipped: a `schema` other than
 * `caveman.learn.v1`, named, or text that does not decode.
 */
export const parse = (text: string): Result.Result<Plan, string> =>
  Result.mapError(decodePlan(text), (error) => {
    const version = Option.map(decodeVersion(text), ({ schema }) => schema);
    return Option.isSome(version) && version.value !== PLAN_SCHEMA
      ? `The report's schema is "${version.value}"; only ${PLAN_SCHEMA} is read.`
      : `The report does not decode as ${PLAN_SCHEMA}: ${formatIssue(error.issue)}`;
  });
