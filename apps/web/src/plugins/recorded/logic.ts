import {
  CAPTURED_RECORD_KINDS,
  CAPTURED_RECORD_OUTPUT_KEY,
  CapturedRecord,
  type CapturedRecordKind,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type RunId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type { TimelineEntry } from "../../session-logic";

const decodeRecord = Schema.decodeUnknownOption(CapturedRecord);
/** Items are immutable and reused across timeline rebuilds, so each is decoded once. */
const recordByItem = new WeakMap<OrchestrationV2TurnItem, CapturedRecord | null>();

/** The record a completed capture call made, as the server put it on the call's wire output. */
function recordOf(item: OrchestrationV2TurnItem): CapturedRecord | null {
  if (item.type !== "dynamic_tool" || item.status !== "completed") return null;
  let record = recordByItem.get(item);
  if (record === undefined) {
    const output = item.output;
    record = Predicate.isObject(output)
      ? Option.getOrNull(decodeRecord(output[CAPTURED_RECORD_OUTPUT_KEY]))
      : null;
    recordByItem.set(item, record);
  }
  return record;
}

/**
 * What each run recorded, in the order its calls made them; a record made twice counts once.
 * Only completed calls the server read a record from count, so a failed one never does.
 */
export function capturedRecordsByRun(
  entries: ReadonlyArray<TimelineEntry>,
): ReadonlyMap<RunId, ReadonlyArray<CapturedRecord>> {
  const byRun = new Map<RunId, CapturedRecord[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "work") continue;
    const item = entry.entry.projectedItem?.item;
    if (item === undefined || item.runId === null) continue;
    const record = recordOf(item);
    if (record === null) continue;
    const key = `${item.runId}\u0000${record.kind}\u0000${record.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const records = byRun.get(item.runId);
    if (records === undefined) byRun.set(item.runId, [record]);
    else records.push(record);
  }
  return byRun;
}

const GROUP_LABELS: Readonly<Record<CapturedRecordKind, string>> = {
  decision: "Decisions",
  finding: "Findings",
  correction: "Corrections",
  knowledge: "Knowledge",
  prompt: "Prompts",
};

/** A card with more rows than this starts collapsed. */
export const RECORDED_ROWS_SHOWN = 5;

/** A run's records by kind, in the card's fixed order, leaving out kinds it has none of. */
export function groupCapturedRecords(records: ReadonlyArray<CapturedRecord>) {
  return CAPTURED_RECORD_KINDS.flatMap((kind) => {
    const ofKind = records.filter((record) => record.kind === kind);
    return ofKind.length === 0 ? [] : [{ kind, label: GROUP_LABELS[kind], records: ofKind }];
  });
}

/**
 * Where a row leads, on the thread's environment and the record's project (the thread's when the
 * call left it out): a decision to the board's decisions in its category, a finding to the panel
 * of the issue that holds it, a correction to the Learning screen's corrections, a knowledge page
 * to the Knowledge screen, a prompt to its drawer on the Learning screen. Null without a project.
 */
export function capturedRecordTarget(
  record: CapturedRecord,
  thread: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId | null },
) {
  const projectId = record.projectId ?? thread.projectId;
  if (projectId === null) return null;
  const { environmentId } = thread;
  const plugin = (
    pluginId: string,
    search: { readonly tab?: string; readonly recordId?: string },
  ) =>
    ({
      to: "/plugins/$pluginId",
      params: { pluginId },
      search: { machine: environmentId, projectId, ...search },
    }) as const;
  switch (record.kind) {
    case "decision": {
      const [category] = record.id.split("/");
      return {
        to: "/board",
        search: {
          environmentId,
          projectId,
          view: "decisions",
          ...(category ? { category } : {}),
        },
      } as const;
    }
    case "finding":
      return {
        to: "/board",
        search: {
          environmentId,
          projectId,
          ...(record.issueId === undefined ? {} : { issue: record.issueId }),
        },
      } as const;
    case "correction":
      return plugin("learning", { tab: "corrections" });
    case "knowledge":
      return plugin("knowledge", {});
    case "prompt":
      return plugin("learning", { tab: "prompts", recordId: record.id });
  }
}
