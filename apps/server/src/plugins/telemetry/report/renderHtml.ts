import type { TelemetryMeasure, TelemetryReport } from "@t3tools/contracts";

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Every stored string goes through this before it reaches the page. */
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ENTITIES[char] ?? char);

/** `2026-10-05T09:30:00.000Z` as `2026-10-05 09:30`. */
const at = (iso: string) => escape(iso.slice(0, 16).replace("T", " "));

const link = (url: string, label: string) =>
  /^https?:\/\//i.test(url) ? `<a href="${escape(url)}">${escape(label)}</a>` : escape(label);

const thread = (title: string | null, threadId: string) => escape(title ?? threadId);

const pullRequestLabel = (pr: { readonly repository: string; readonly number: number }) =>
  `${pr.repository}#${pr.number}`;

const measureValue = (measure: TelemetryMeasure) => {
  const { value } = measure;
  if (value === null) return "–";
  switch (measure.unit) {
    case "ratio":
      return `${(value * 100).toFixed(0)}%`;
    case "usd":
      return `$${value.toFixed(2)}`;
    case "seconds":
      return `${value.toFixed(0)} s`;
    case "tokens":
    case "count":
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
};

const STYLE = [
  "body{color:var(--foreground);font-family:var(--font-sans)}",
  "h1{font-size:1.25rem;margin:0 0 4px}",
  "h2{font-size:1rem;margin:24px 0 8px}",
  ".muted{color:var(--muted-foreground)}",
  ".scroll{overflow-x:auto}",
  "table{width:100%;border-collapse:collapse;font-size:13px}",
  "th,td{text-align:left;vertical-align:top;padding:6px 12px 6px 0;border-bottom:1px solid var(--border);overflow-wrap:anywhere}",
  "th{color:var(--muted-foreground);font-weight:500}",
  "a{color:var(--accent)}",
].join("");

/** One section: a heading, then a table, or why there is none. Cells arrive escaped. */
const section = <Item>(
  heading: string,
  part: {
    readonly state: "ok" | "unavailable";
    readonly missingReason: string | null;
    readonly count: number;
    readonly items: ReadonlyArray<Item>;
  },
  headers: ReadonlyArray<string>,
  row: (item: Item) => ReadonlyArray<string>,
) => {
  const title = `<h2>${heading} <span class="muted">${part.count}</span></h2>`;
  const note =
    part.missingReason === null ? "" : `<p class="muted">${escape(part.missingReason)}</p>`;
  if (part.state === "unavailable" || part.items.length === 0) {
    return `<section>${title}${note || '<p class="muted">Nothing in this range.</p>'}</section>`;
  }
  const head = headers.map((header) => `<th>${header}</th>`).join("");
  const body = part.items
    .map(
      (item) =>
        `<tr>${row(item)
          .map((cell) => `<td>${cell}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const more =
    part.count > part.items.length
      ? `<p class="muted">Showing ${part.items.length} of ${part.count}.</p>`
      : "";
  return `<section>${title}${note}<div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}</section>`;
};

/**
 * The report as one self-contained page for `html_render`: a heading and a table per section,
 * styled only with the theme variables T3 injects, and no script.
 */
export const renderHtml = (report: TelemetryReport) =>
  [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<title>Activity report</title><style>${STYLE}</style></head><body>`,
    `<h1>Activity report: ${escape(report.projectTitle)}</h1>`,
    `<p class="muted">${at(report.from)} to ${at(report.to)} UTC</p>`,
    section("Delivered", report.delivered, ["Thread", "Settled", "Pull requests"], (item) => [
      thread(item.title, item.threadId),
      at(item.settledAt),
      item.pullRequests.map((pr) => link(pr.url, pullRequestLabel(pr))).join(", "),
    ]),
    section(
      "Review findings",
      report.findings,
      ["Outcome", "Failure mode", "Thread", "Summary", "Given"],
      (item) => [
        escape(item.outcome),
        escape(item.failureMode ?? ""),
        thread(item.title, item.threadId),
        escape(item.summary),
        at(item.createdAt),
      ],
    ),
    section("Decisions", report.decisions, ["Failure mode", "State", "Owner", "Set"], (item) => [
      escape(item.failureMode),
      escape(item.state),
      escape(item.ownerKind ?? ""),
      at(item.updatedAt),
    ]),
    section("Knowledge changes", report.knowledgeChanges, ["Failure mode", "Delivered"], (item) => [
      escape(item.failureMode),
      at(item.deliveredAt),
    ]),
    section("Prompt changes", report.prompts, ["Failure mode", "Delivered"], (item) => [
      escape(item.failureMode),
      at(item.deliveredAt),
    ]),
    section(
      "Failures",
      report.failures,
      ["Kind", "Mode", "Thread", "Description", "Recorded"],
      (item) => [
        escape(item.failureKind),
        escape(item.declaredMode ?? ""),
        thread(item.title, item.threadId),
        escape(item.description),
        at(item.createdAt),
      ],
    ),
    section("Pull requests", report.pullRequests, ["State", "Pull request", "Title"], (item) => [
      escape(item.state),
      link(item.url, pullRequestLabel(item)),
      escape(item.title),
    ]),
    section("Unresolved", report.unresolved, ["What", "Detail"], (item) =>
      item.kind === "learning_item"
        ? [
            `Learning item: ${escape(item.failureMode)}`,
            `Seen ${item.occurrences} times, last ${at(item.updatedAt)}`,
          ]
        : [`Changes requested: ${link(item.url, pullRequestLabel(item))}`, escape(item.title)],
    ),
    section("Needs attention", report.attention, ["Thread", "Flag"], (item) => [
      thread(item.title, item.threadId),
      escape(item.text),
    ]),
    section("Efficiency", report.efficiency, ["Measure", "Value", "Sample", "Note"], (item) => [
      escape(item.measure),
      escape(measureValue(item)),
      String(item.sampleSize),
      escape(item.missingReason ?? ""),
    ]),
    "</body></html>",
  ].join("");
