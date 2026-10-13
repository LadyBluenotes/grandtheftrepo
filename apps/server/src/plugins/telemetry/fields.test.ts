import { assert, it } from "@effect/vitest";
import * as Fixtures from "./eventFixtures.ts";
import {
  correctionFields,
  deliveredFields,
  pinnedFields,
  runFields,
  settledFields,
  threadFields,
  toolCallFields,
  toolInputFields,
  toolOutputFields,
  turnUsageFields,
  verdictFields,
} from "./fields.ts";
import { input } from "./measures/fixtures.ts";
import { computeMeasures } from "./measures/index.ts";

const usageEvent = Fixtures.turnUpdated(Fixtures.usage);
const settled = { commandId: Fixtures.sweepCommandId };
const pinned = Fixtures.threadEvent("thread.pinned");

/** What the reactor and the loader read out of the fixtures, through the accessors they use. */
const accessed: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  turnUsageFields(usageEvent) ?? {},
  runFields(Fixtures.run),
  toolCallFields(Fixtures.readItem),
  toolCallFields(Fixtures.editItem),
  toolOutputFields(Fixtures.commandItem),
  toolOutputFields(Fixtures.mcpItem),
  toolOutputFields(Fixtures.fileSearchItem),
  toolOutputFields(Fixtures.webSearchItem),
  toolCallFields(Fixtures.subagentGrepItem),
  toolInputFields(Fixtures.subagentGrepItem),
  toolInputFields(Fixtures.fileSearchItem),
  threadFields(Fixtures.thread),
  settledFields(settled),
  pinnedFields(pinned),
  correctionFields(Fixtures.correction),
  verdictFields(Fixtures.verdict),
  deliveredFields(Fixtures.delivery),
];

/** The fixture each provenance root names, so a path can be walked on the real event shape. */
const roots: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]> = [
  ["provider-turn.updated", [usageEvent]],
  ["providerTurn", [usageEvent.payload]],
  ["run", [Fixtures.run]],
  [
    "turnItem",
    [
      Fixtures.readItem,
      Fixtures.editItem,
      Fixtures.commandItem,
      Fixtures.mcpItem,
      Fixtures.fileSearchItem,
      Fixtures.webSearchItem,
      Fixtures.subagentGrepItem,
    ],
  ],
  ["thread.settled", [settled]],
  ["thread.pinned", [pinned]],
  ["thread", [Fixtures.thread]],
  ["learning.correction", [Fixtures.correction]],
  ["learning.promotion", [Fixtures.promotion]],
  ["review.verdict", [Fixtures.verdict]],
];

/** Follows `keys` from `value`, into the first element of an array on the way. */
const walk = (value: unknown, keys: ReadonlyArray<string>): unknown =>
  keys.reduce<unknown>((current, key) => {
    const node = Array.isArray(current) ? current[0] : current;
    return typeof node === "object" && node !== null ? Reflect.get(node, key) : undefined;
  }, value);

const isSet = (value: unknown) => value !== undefined && value !== null;

const cited = [...new Set(computeMeasures(input()).flatMap((measure) => measure.provenance))];

it("lists every measure in the issue's order", () => {
  assert.deepEqual(
    computeMeasures(input()).map((measure) => measure.measure),
    [
      "first_review_acceptance",
      "material_correction_burden",
      "known_error_recurrence",
      "time_to_accepted_outcome",
      "cost_per_accepted_outcome",
      "context_efficiency",
      "knowledge_reuse",
      "delegation_overhead",
      "repeated_reads",
      "repeated_rediscovery",
      "repeated_failed_approaches",
      "scope_stability",
      "recovery_efficiency",
      "supervision_burden",
      "tool_output_total",
      "tool_output_max_per_call",
      "deterministic_work_share",
      "extraction_candidates",
    ],
  );
});

it("cites only paths the reactor's accessors read, each set on a fixture event", () => {
  assert.isAbove(cited.length, 0);
  assert.deepEqual(
    cited.filter((path) => !accessed.some((fields) => isSet(fields[path]))),
    [],
  );
});

it("cites paths that exist on the events they name", () => {
  const missing = cited.filter((path) => {
    const [root, fixtures] = roots.find(([name]) => path.startsWith(`${name}.`)) ?? ["", []];
    const keys = path.slice(root.length + 1).split(".");
    return !fixtures.some((fixture) => isSet(walk(fixture, keys)));
  });
  assert.deepEqual(missing, []);
});

it("the tool output measures cite what the accessors read of a tool call", () => {
  const toolOutput = computeMeasures(input()).filter((measure) =>
    measure.measure.startsWith("tool_output_"),
  );
  assert.strictEqual(toolOutput.length, 2);
  for (const measure of toolOutput) {
    for (const path of [
      "turnItem.output",
      "turnItem.results",
      "turnItem.toolName",
      "turnItem.input",
    ]) {
      assert.include(measure.provenance, path);
      assert.isTrue(
        accessed.some((fields) => isSet(fields[path])),
        `${path} is set by no accessor on a fixture`,
      );
    }
  }
});

it("the repeated work measures cite what the reactor reads of a call's input and its turn", () => {
  const repeated = computeMeasures(input()).filter((measure) =>
    ["deterministic_work_share", "extraction_candidates"].includes(measure.measure),
  );
  assert.strictEqual(repeated.length, 2);
  for (const measure of repeated) {
    assert.includeMembers(
      [...measure.provenance],
      ["turnItem.input", "turnItem.pattern", "turnItem.providerTurnId", "turnItem.output"],
    );
  }
  // A dynamic tool's pattern comes from its input; a file search's is its own.
  assert.strictEqual(toolInputFields(Fixtures.subagentGrepItem)["turnItem.pattern"], "useEffect");
  assert.strictEqual(toolInputFields(Fixtures.fileSearchItem)["turnItem.pattern"], "TODO");
  assert.strictEqual(
    toolInputFields(Fixtures.subagentGrepItem)["turnItem.input"]?.keys,
    "output_mode,path,pattern",
  );
  assert.isNull(toolInputFields(Fixtures.editItem)["turnItem.input"]);
});
