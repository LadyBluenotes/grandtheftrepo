import { assert, it } from "@effect/vitest";
import type { TelemetryMeasure } from "@t3tools/contracts";

import { fullInput, INSIDE, pullRequest, thread } from "./fixtures.ts";
import { foldReport } from "./fold.ts";
import { renderHtml } from "./renderHtml.ts";

it("escapes a thread title that holds markup, and the page carries no script", () => {
  const html = renderHtml(
    foldReport({
      ...fullInput(),
      projectTitle: 'Acme "app" & co',
      threads: [
        thread("thread:hostile", {
          title: "<script>alert(1)</script>",
          settledAt: INSIDE,
          pullRequests: [
            pullRequest(1, {
              state: "merged",
              closedAt: INSIDE,
              url: "javascript:alert(1)",
            }),
          ],
        }),
      ],
    }),
  );
  assert.notInclude(html, "<script");
  assert.include(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.include(html, "Acme &quot;app&quot; &amp; co");
  // A link only for http(s); anything else stays text.
  assert.notInclude(html, 'href="javascript');
});

it("names the plugin a section is missing, styled with the theme's variables", () => {
  const html = renderHtml(foldReport({ ...fullInput(), verdicts: undefined }));
  assert.include(html, "The review plugin is not running.");
  assert.include(html, "var(--foreground)");
  assert.include(html, "var(--border)");
});

const largestRow = (tool: string, estimatedTokens: number, index: number) => ({
  tool,
  threadId: `thread:${index}`,
  runId: index % 2 === 0 ? null : `run:${index}`,
  itemId: `item:${index}`,
  estimatedTokens,
});

const toolOutputMeasure: TelemetryMeasure = {
  measure: "tool_output_max_per_call",
  state: "ok",
  value: 9000,
  unit: "tokens",
  direction: "lower_is_better",
  sampleSize: 30,
  missingReason: null,
  provenance: [],
  detail: {
    largest: [
      largestRow("Read", 9000, 1),
      largestRow("<b>mcp__t3-code__thread_list</b>", 8000, 2),
      largestRow("command:git", 7000, 3),
      largestRow("web_search", 6000, 4),
      largestRow("file_search", 5000, 5),
      largestRow("Grep", 4000, 6),
      largestRow("Glob", 3000, 7),
    ],
  },
};

it("renders a measure's five largest results as a sub-table of the efficiency section", () => {
  const html = renderHtml(foldReport({ ...fullInput(), measures: [toolOutputMeasure] }));
  const start = html.indexOf("<th>Largest result</th>");
  assert.isAbove(start, html.indexOf("Efficiency"));
  const table = html.slice(start, html.indexOf("</table>", start));
  // Five rows of ten the measure holds: the largest first, the rest left to the MCP tool.
  assert.strictEqual(table.match(/<tr><td>/g)?.length, 5);
  assert.include(table, "<td>Read</td><td>~9000</td><td>thread:1</td>");
  assert.include(table, "<td>file_search</td><td>~5000</td><td>thread:5</td>");
  assert.notInclude(table, "Grep");
  assert.notInclude(table, "Glob");
  // A tool name is text, not markup.
  assert.include(table, "&lt;b&gt;mcp__t3-code__thread_list&lt;/b&gt;");
  assert.notInclude(html, "<b>mcp__");
});

it("renders no sub-table for a measure without largest results, or with an empty list", () => {
  const html = renderHtml(
    foldReport({
      ...fullInput(),
      measures: [
        { ...toolOutputMeasure, detail: { byTool: [] } },
        { ...toolOutputMeasure, measure: "other", detail: { largest: [] } },
        { ...toolOutputMeasure, measure: "plain", detail: undefined },
      ],
    }),
  );
  assert.notInclude(html, "Largest result");
});

const candidate = (steps: ReadonlyArray<string>, estimatedTokens: number, index: number) => ({
  id: `candidate:${index}`,
  kind: steps.length === 1 ? ("step" as const) : ("procedure" as const),
  steps,
  threads: 3 + index,
  occurrences: 4 + index,
  deterministicRatio: 1,
  estimatedTokens,
  form: "script" as const,
  example: {
    threadId: `thread:${index}`,
    runId: `run:${index}`,
    itemIds: [`item:${index}`],
  },
});

it("renders the five costliest extraction candidates as a sub-table of the efficiency section", () => {
  const measure: TelemetryMeasure = {
    measure: "extraction_candidates",
    state: "ok",
    value: 6,
    unit: "count",
    direction: "lower_is_better",
    sampleSize: 9,
    missingReason: null,
    provenance: [],
    detail: {
      candidates: [
        candidate(["command:pnpm lint", "command:pnpm test"], 9000, 1),
        candidate(["Read <b>AGENTS.md</b>"], 8000, 2),
        candidate(["Grep <pattern> <path>"], 7000, 3),
        candidate(["command:git status"], 6000, 4),
        candidate(["file_search:TODO"], 5000, 5),
        candidate(["command:pnpm audit"], 4000, 6),
      ],
    },
  };
  const html = renderHtml(foldReport({ ...fullInput(), measures: [measure] }));
  const start = html.indexOf("<th>Repeated steps</th>");
  assert.isAbove(start, html.indexOf("Efficiency"));
  const table = html.slice(start, html.indexOf("</table>", start));
  assert.strictEqual(table.match(/<tr><td>/g)?.length, 5);
  assert.include(
    table,
    "<td>command:pnpm lint &rarr; command:pnpm test</td><td>4</td><td>~9000</td><td>script</td>",
  );
  assert.notInclude(table, "pnpm audit");
  // Steps are text: a path that looks like markup, and the slots, are escaped.
  assert.include(table, "Read &lt;b&gt;AGENTS.md&lt;/b&gt;");
  assert.include(table, "Grep &lt;pattern&gt; &lt;path&gt;");
  assert.notInclude(html, "<b>AGENTS");
});
