import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PluginDatabase from "../../PluginDatabase.ts";
import { migrations } from "../migrations.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

/**
 * A `caveman.learn.v1` report as caveman writes it, with every class and both framings, and the
 * fields this plugin ignores. A forward-rate sink has no `tokens_observed`, as caveman leaves a zero
 * out, and one sink's evidence is null, as an empty Go map is written.
 */
export const reportJson = (generatedAt: string, schema = "caveman.learn.v1") =>
  encodeJson({
    schema,
    basis: "inferred",
    generated_at: generatedAt,
    generation: "1",
    window: { from: "2026-09-10T00:00:00Z", to: "2026-10-10T00:00:00Z", since: "30d" },
    cave_score: {
      score: 72,
      basis: "inferred",
      scope: "local_setup",
      components: [],
    },
    sessions_scanned: 41,
    sessions_by_source: { claude: 30, codex: 11 },
    sinks: [
      {
        sink_id: "claude_md_weight:project",
        practice_id: "claude_md",
        title: "Project CLAUDE.md is heavy",
        class: "reducible",
        basis: "inferred",
        tokens_per_turn: 2400,
        tokens_per_day_rate: 96000,
        evidence: { path: "/home/user/project/CLAUDE.md", lines: [12, 40] },
        suggestion: "Move rarely used sections into a skill.",
        framing: "forward_rate",
      },
      {
        sink_id: "recurring_context:repaste:ab12cd",
        practice_id: "repaste",
        title: "The same text pasted in 9 sessions",
        class: "recurring_context",
        basis: "inferred",
        tokens_per_turn: 0,
        tokens_per_day_rate: 0,
        tokens_observed: 18000,
        evidence: { locators: [{ file: "/home/user/.claude/projects/a.jsonl", line: 7 }] },
        suggestion: "Keep it in a file and point at it.",
        framing: "historical",
      },
      {
        sink_id: "procedure_repeat:release",
        practice_id: "procedure_repeat",
        title: "A release procedure typed out by hand",
        class: "behavioral",
        basis: "inferred",
        tokens_per_turn: 0,
        tokens_per_day_rate: 0,
        tokens_observed: 9000,
        evidence: null,
        suggestion: "Consider a command for it.",
        framing: "historical",
      },
      {
        sink_id: "config_tax:baseline",
        practice_id: "config_tax",
        title: "System prompt and tools",
        class: "load_bearing",
        basis: "inferred",
        tokens_per_turn: 8000,
        tokens_per_day_rate: 320000,
        evidence: { tools: 14 },
        suggestion: "Needed; nothing to change.",
        framing: "forward_rate",
      },
    ],
    caveats: ["Counts come from an offline tokenizer."],
    spend: { window_usd: 12.5, unpriced: [] },
    wrap_measured: { tokens_saved: 120000 },
    moves: 4,
  });

/** A migrated in-memory caveman database for the enclosing scope. */
export const openDatabase = PluginDatabase.open({
  id: "caveman",
  filename: ":memory:",
  migrations,
}).pipe(Effect.map(({ sql }) => sql));
