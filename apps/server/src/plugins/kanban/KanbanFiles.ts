import {
  KanbanActor,
  KanbanBlock,
  KanbanCriterion,
  KanbanDecision,
  KanbanFinding,
  KanbanLabel,
  KanbanLogEntry,
  KanbanLogKind,
  KanbanPriority,
  KanbanReopen,
  KanbanSlug,
  KanbanStatus,
  KanbanThreadLink,
  KanbanTier,
  KanbanVerification,
  type KanbanIssue,
} from "@t3tools/contracts";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as Schema from "effect/Schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Issue and decision files on disk. Issues are markdown with YAML frontmatter,
 * the description, then an append-only `## Log`. Decisions are one YAML file
 * per category. Both are the only copy of their data; the server never holds
 * anything the files do not.
 */

export const ISSUE_EXTENSION = ".md";
export const DECISION_EXTENSION = ".yaml";

export function slugOf(title: string): string {
  const slug = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug.length === 0 ? "untitled" : slug;
}

/** The first slug not in `taken`: the base, then `-2`, `-3`, ... */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let attempt = 2; ; attempt += 1) {
    const candidate = `${base}-${attempt}`;
    if (!taken(candidate)) return candidate;
  }
}

const IssueFrontmatter = Schema.Struct({
  title: Schema.String,
  project: Schema.optional(Schema.NullOr(Schema.String)),
  status: KanbanStatus,
  priority: Schema.optional(Schema.NullOr(KanbanPriority)),
  labels: Schema.optional(Schema.NullOr(Schema.Array(KanbanLabel))),
  verification: Schema.optional(Schema.NullOr(KanbanVerification)),
  tier: Schema.optional(Schema.NullOr(KanbanTier)),
  criteria: Schema.optional(Schema.NullOr(Schema.Array(KanbanCriterion))),
  findings: Schema.optional(Schema.NullOr(Schema.Array(KanbanFinding))),
  blocked: Schema.optional(Schema.NullOr(KanbanBlock)),
  reopened: Schema.optional(Schema.NullOr(KanbanReopen)),
  threads: Schema.optional(Schema.NullOr(Schema.Array(KanbanThreadLink))),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.NullOr(KanbanActor)),
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  doneAt: Schema.optional(Schema.NullOr(Schema.String)),
  archivedAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeIssueFrontmatter = Schema.decodeUnknownSync(IssueFrontmatter);
const isLogKind = Schema.is(KanbanLogKind);

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const LOG_HEADING = /\r?\n## Log[ \t]*(?:\r?\n|$)/;
/** One log line: `- <at> | <by> | <kind> | <text>`; indented lines continue `text`. */
const LOG_LINE = /^- (\S+) \| (\S+) \| (\S+) \| ?(.*)$/;

export interface ParsedIssue {
  readonly issue: KanbanIssue;
  /** The `project` frontmatter field, for the folder-mismatch warning. */
  readonly project: string | null;
}

/** Null when the file is not an issue this version can read; the caller keeps what it had. */
export function parseIssue(id: string, text: string): ParsedIssue | null {
  const match = FRONTMATTER.exec(text);
  if (match === null) return null;
  let front: typeof IssueFrontmatter.Type;
  try {
    front = decodeIssueFrontmatter(parseYaml(match[1] ?? ""));
  } catch {
    return null;
  }
  const body = text.slice(match[0].length);
  const split = LOG_HEADING.exec(body);
  const description = (split === null ? body : body.slice(0, split.index)).trim();
  const log = split === null ? [] : parseLog(body.slice(split.index + split[0].length));
  return {
    project: front.project ?? null,
    issue: {
      id,
      title: front.title,
      status: front.status,
      priority: front.priority ?? "p3",
      labels: front.labels ?? [],
      verification: front.verification ?? "unverified",
      tier: front.tier ?? null,
      criteria: front.criteria ?? [],
      findings: front.findings ?? [],
      blocked: front.blocked ?? null,
      reopened: front.reopened ?? null,
      threads: front.threads ?? [],
      createdAt: front.createdAt,
      createdBy: front.createdBy ?? "user",
      updatedAt: front.updatedAt ?? front.createdAt,
      doneAt: front.doneAt ?? null,
      archivedAt: front.archivedAt ?? null,
      description,
      log,
    },
  };
}

function parseLog(text: string): Array<KanbanLogEntry> {
  const entries: Array<KanbanLogEntry> = [];
  for (const line of text.split(/\r?\n/)) {
    const match = LOG_LINE.exec(line);
    if (match !== null) {
      const kind = match[3]!;
      if (!isLogKind(kind)) continue;
      entries.push({ at: match[1]!, by: match[2]!, kind, text: match[4]! });
      continue;
    }
    const last = entries[entries.length - 1];
    if (last !== undefined && /^(?: {4}|\t)/.test(line)) {
      entries[entries.length - 1] = {
        ...last,
        text: `${last.text}\n${line.replace(/^(?: {4}|\t)/, "")}`,
      };
    }
  }
  return entries;
}

export function formatLogEntry(entry: KanbanLogEntry): string {
  const [first = "", ...rest] = entry.text.split("\n");
  return [
    `- ${entry.at} | ${entry.by} | ${entry.kind} | ${first}`,
    ...rest.map((l) => `    ${l}`),
  ].join("\n");
}

export function serializeIssue(issue: KanbanIssue, project: string): string {
  const { id: _id, description, log, blocked, reopened, criteria, findings, ...rest } = issue;
  const front = {
    ...rest,
    project,
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(findings.length === 0 ? {} : { findings }),
    ...(blocked === null ? {} : { blocked }),
    ...(reopened === null ? {} : { reopened }),
  };
  const body = description.length === 0 ? "" : `${description}\n`;
  const logText = log.length === 0 ? "" : `${log.map(formatLogEntry).join("\n")}\n`;
  return `---\n${stringifyYaml(front, { lineWidth: 0 })}---\n${body}\n## Log\n${logText}`;
}

const DecisionFile = fromYaml(
  Schema.Struct({
    category: Schema.optional(Schema.NullOr(Schema.String)),
    project: Schema.optional(Schema.NullOr(Schema.String)),
    decisions: Schema.optional(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({ ...KanbanDecision.fields, category: Schema.optional(KanbanSlug) }),
        ),
      ),
    ),
  }),
);
const decodeDecisionFile = Schema.decodeUnknownSync(DecisionFile);
const encodeDecisionFile = Schema.encodeSync(DecisionFile);

/** Null when the file is not a decision file this version can read. */
export function parseDecisions(
  category: string,
  text: string,
): ReadonlyArray<KanbanDecision> | null {
  try {
    return (decodeDecisionFile(text).decisions ?? []).map((d) => ({ ...d, category }));
  } catch {
    return null;
  }
}

export function serializeDecisions(
  category: string,
  project: string,
  decisions: ReadonlyArray<KanbanDecision>,
): string {
  return encodeDecisionFile({
    category,
    project,
    decisions: decisions.map(({ category: _category, ...rest }) => rest),
  });
}
