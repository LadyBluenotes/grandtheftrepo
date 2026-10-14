import {
  CAPTURED_RECORD_OUTPUT_KEY,
  type CapturedRecord,
  type OrchestrationV2TurnItem,
  ProjectId,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

type ToolItem = Pick<
  Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>,
  "toolName" | "status" | "input" | "output"
>;

const MAX_TITLE_LENGTH = 200;
const MAX_ID_LENGTH = 256;
const MAX_STATE_LENGTH = 64;
/** A capture result is a few kilobytes; anything far larger is not one. */
const MAX_OUTPUT_LENGTH = 1_000_000;
const MAX_DEPTH = 6;

const text = (value: unknown, max: number) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  // Cut by code point; `max` of them fit in twice as many code units.
  return trimmed === ""
    ? undefined
    : Array.from(trimmed.slice(0, max * 2))
        .slice(0, max)
        .join("");
};
const idText = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value)
    ? String(value)
    : text(value, MAX_ID_LENGTH);
const projectOf = (value: unknown) => {
  const id = text(value, MAX_ID_LENGTH);
  return id === undefined ? null : ProjectId.make(id);
};

/** A record with every field it needs, or nothing. */
function record(
  kind: CapturedRecord["kind"],
  fields: {
    readonly id: unknown;
    readonly title: unknown;
    readonly state: unknown;
    readonly projectId: unknown;
    readonly issueId?: unknown;
  },
): CapturedRecord | undefined {
  const id = idText(fields.id);
  const title = text(fields.title, MAX_TITLE_LENGTH);
  const state = text(fields.state, MAX_STATE_LENGTH);
  if (id === undefined || title === undefined || state === undefined) return undefined;
  const issueId = text(fields.issueId, MAX_ID_LENGTH);
  return {
    kind,
    id,
    title,
    state,
    projectId: projectOf(fields.projectId),
    ...(issueId === undefined ? {} : { issueId }),
  };
}

type Reader = (
  input: Readonly<Record<PropertyKey, unknown>>,
  result: unknown,
) => CapturedRecord | undefined;

/**
 * The capture tools the capture rule names, and how each call reads as a record: `kanban_write`
 * answers with the bare id, so a decision's title, category and state come from its input; the
 * others answer with the record itself.
 */
const CAPTURE_TOOLS: Readonly<Record<string, Reader>> = {
  kanban_write: (input, result) =>
    input.action === "decision.create" && typeof result === "string"
      ? record("decision", {
          id: `${text(input.category, MAX_ID_LENGTH) ?? "general"}/${result}`,
          title: input.title,
          state: input.state ?? "accepted",
          projectId: input.projectId,
        })
      : undefined,
  finding_capture: (_input, result) =>
    Predicate.isObject(result) && Predicate.isObject(result.finding)
      ? record("finding", {
          id: result.finding.id,
          title: result.finding.title,
          state: result.finding.disposition,
          projectId: result.projectId,
          issueId: result.issueId,
        })
      : undefined,
  learning_correction_add: (_input, result) =>
    Predicate.isObject(result)
      ? record("correction", {
          id: result.id,
          title: result.description,
          state: result.declaredMode ?? result.causeClass,
          projectId: result.projectId,
        })
      : undefined,
  knowledge_propose: (_input, result) =>
    Predicate.isObject(result)
      ? record("knowledge", {
          id: result.id,
          title: result.title,
          state: result.state,
          projectId: result.projectId,
        })
      : undefined,
  prompt_save: (_input, result) =>
    Predicate.isObject(result)
      ? record("prompt", {
          id: result.id,
          title: result.title,
          state: result.state,
          projectId: result.projectId,
        })
      : undefined,
};

/**
 * A capture tool of the `t3-code` MCP server, in any provider's spelling: `mcp__t3-code__x`,
 * `t3-code.x`, `mcp_t3_code_x`, OpenCode's per-thread `t3-code-<thread>_x`, or the bare name.
 */
const T3_SERVER_PREFIX = /^(?:mcp[-_]{1,2})?t3[-_ ]?code(?:-\S+)?(?:__|[-_.:/ ]|\s*·\s*)$/i;
const CAPTURE_TOOL_ENTRIES = Object.entries(CAPTURE_TOOLS);
function captureReader(toolName: string | null): Reader | undefined {
  if (toolName === null) return undefined;
  const label = toolName.replace(/\s+(?:complete|completed)\s*$/i, "").trim();
  for (const [tool, reader] of CAPTURE_TOOL_ENTRIES) {
    if (!label.endsWith(tool)) continue;
    const prefix = label.slice(0, label.length - tool.length);
    if (prefix === "" || T3_SERVER_PREFIX.test(prefix)) return reader;
  }
  return undefined;
}

/**
 * What a tool answered with, whichever way the provider stored it: MCP `structuredContent`, a
 * list of content blocks (ACP wraps each in another), or JSON text. A string that is not JSON is
 * the answer itself.
 */
function resultOf(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof value === "string") {
    if (value.length > MAX_OUTPUT_LENGTH) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" || Predicate.isObject(parsed)
        ? resultOf(parsed, depth + 1)
        : value;
    } catch {
      return value;
    }
  }
  if (Array.isArray(value)) {
    const block = value.find(Predicate.isObject);
    return block === undefined ? undefined : resultOf(block, depth + 1);
  }
  if (!Predicate.isObject(value)) return undefined;
  if (value.structuredContent !== undefined) return resultOf(value.structuredContent, depth + 1);
  if (value.content !== undefined) return resultOf(value.content, depth + 1);
  if (value.type === "text") return resultOf(value.text, depth + 1);
  return value;
}

/** The record a completed capture call made; nothing for any other call. */
export function capturedRecordFromToolItem(item: ToolItem): CapturedRecord | undefined {
  if (item.status !== "completed") return undefined;
  const read = captureReader(item.toolName);
  if (read === undefined) return undefined;
  const input = Predicate.isObject(item.input) ? item.input : {};
  return read(input, resultOf(item.output));
}

/**
 * A capture call's compact wire output with its record added, which is all a client needs to list
 * what the turn recorded. A failed call adds nothing.
 */
export function withCapturedRecord<Output extends { readonly isError?: true }>(
  item: ToolItem,
  output: Output | undefined,
) {
  if (output?.isError === true) return output;
  const captured = capturedRecordFromToolItem(item);
  return captured === undefined ? output : { ...output, [CAPTURED_RECORD_OUTPUT_KEY]: captured };
}
