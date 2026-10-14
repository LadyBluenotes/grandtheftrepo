import {
  IsoDateTime,
  KanbanActor,
  KanbanAlternative,
  KanbanBlock,
  KanbanCriterion,
  KanbanDecision,
  KanbanDecisionRef,
  KanbanDecisionRevision,
  KanbanDecisionState,
  KanbanFinding,
  KanbanLabel,
  KanbanLogEntry,
  KanbanLogKind,
  KanbanNoDecision,
  KanbanPriority,
  KanbanReopen,
  KanbanSlug,
  KanbanStatus,
  KanbanThreadLink,
  KanbanTier,
  KanbanVerification,
  ThreadId,
  TrimmedNonEmptyString,
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
  /** Written on every issue filed since the closure check began; a file without it is exempt. */
  closureCheck: Schema.optional(Schema.NullOr(Schema.Boolean)),
  noDecision: Schema.optional(Schema.NullOr(KanbanNoDecision)),
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
      closureCheck: front.closureCheck ?? false,
      noDecision: front.noDecision ?? null,
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
  const {
    id: _id,
    description,
    log,
    blocked,
    reopened,
    criteria,
    findings,
    closureCheck,
    noDecision,
    ...rest
  } = issue;
  const front = {
    ...rest,
    project,
    ...(criteria.length === 0 ? {} : { criteria }),
    ...(findings.length === 0 ? {} : { findings }),
    ...(closureCheck ? { closureCheck } : {}),
    ...(noDecision === null ? {} : { noDecision }),
    ...(blocked === null ? {} : { blocked }),
    ...(reopened === null ? {} : { reopened }),
  };
  const body = description.length === 0 ? "" : `${description}\n`;
  const logText = log.length === 0 ? "" : `${log.map(formatLogEntry).join("\n")}\n`;
  return `---\n${stringifyYaml(front, { lineWidth: 0 })}---\n${body}\n## Log\n${logText}`;
}

/** How one decision names another: `<category>/<id>`. */
export const decisionRef = (decision: Pick<KanbanDecision, "category" | "id">) =>
  `${decision.category}/${decision.id}`;

/** Before decisions had a state, each was `for` or `against` its title. Read, never written. */
const LegacyStance = Schema.Literals(["for", "against"]);

/**
 * One decision as the file holds it. Everything added since the first version is optional, so an
 * older file still reads; `parseDecisions` fills it in and `serializeDecisions` writes it all.
 */
const DecisionEntry = Schema.Struct({
  id: KanbanSlug,
  state: Schema.optional(KanbanDecisionState),
  title: TrimmedNonEmptyString,
  why: Schema.String,
  alternatives: Schema.optional(Schema.Array(KanbanAlternative)),
  reconsiderWhen: Schema.optional(Schema.NullOr(Schema.String)),
  supersedes: Schema.optional(Schema.Array(KanbanDecisionRef)),
  supersededBy: Schema.optional(Schema.NullOr(KanbanDecisionRef)),
  issues: Schema.Array(KanbanSlug),
  threads: Schema.optional(Schema.Array(ThreadId)),
  by: KanbanActor,
  at: IsoDateTime,
  revisions: Schema.optional(Schema.Array(KanbanDecisionRevision)),
  stance: Schema.optional(LegacyStance),
  /** The file's own `category` wins; an entry's is ignored. */
  category: Schema.optional(KanbanSlug),
});

const DecisionFile = fromYaml(
  Schema.Struct({
    category: Schema.optional(Schema.NullOr(Schema.String)),
    project: Schema.optional(Schema.NullOr(Schema.String)),
    decisions: Schema.optional(Schema.NullOr(Schema.Array(DecisionEntry))),
  }),
);
const decodeDecisionFile = Schema.decodeUnknownSync(DecisionFile);
const encodeDecisionFile = Schema.encodeSync(DecisionFile);

/**
 * A decision from its entry. One written with a stance is accepted, and its title becomes its one
 * alternative, chosen for `for` and rejected for `against`, with the why as the reason. Nothing
 * says whether that reason was permanent, so it reads as contextual: worth a second look.
 */
const fromEntry = (category: string, entry: typeof DecisionEntry.Type): KanbanDecision => ({
  category,
  id: entry.id,
  state: entry.state ?? "accepted",
  title: entry.title,
  why: entry.why,
  alternatives:
    entry.alternatives ??
    (entry.stance === undefined
      ? []
      : [
          {
            title: entry.title,
            disposition: entry.stance === "for" ? "chosen" : "rejected",
            reason: entry.why,
            reasonKind: "contextual",
          },
        ]),
  reconsiderWhen: entry.reconsiderWhen ?? null,
  supersedes: entry.supersedes ?? [],
  supersededBy: entry.supersededBy ?? null,
  issues: entry.issues,
  threads: entry.threads ?? [],
  by: entry.by,
  at: entry.at,
  revisions: entry.revisions ?? [],
});

/** Null when the file is not a decision file this version can read. */
export function parseDecisions(
  category: string,
  text: string,
): ReadonlyArray<KanbanDecision> | null {
  try {
    return (decodeDecisionFile(text).decisions ?? []).map((entry) => fromEntry(category, entry));
  } catch {
    return null;
  }
}

/** The file for a category, every field written; a stance never is. */
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
