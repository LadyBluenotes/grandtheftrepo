import * as Schema from "effect/Schema";
import { ProjectId } from "../baseSchemas.ts";

/** What an agent can record during a turn, in the order the chat lists them. */
export const CAPTURED_RECORD_KINDS = [
  "decision",
  "finding",
  "correction",
  "knowledge",
  "prompt",
] as const;
export const CapturedRecordKind = Schema.Literals(CAPTURED_RECORD_KINDS);
export type CapturedRecordKind = typeof CapturedRecordKind.Type;

/** The key a capture call's compact wire output carries its record under. */
export const CAPTURED_RECORD_OUTPUT_KEY = "capturedRecord";

/**
 * A record a completed capture tool call made, read by the server from the call's own input and
 * output and added to its compact wire output, so a client lists what a turn recorded without
 * another read. Clients decode each one on its own, so a kind they do not know is skipped.
 */
export const CapturedRecord = Schema.Struct({
  kind: CapturedRecordKind,
  /** The record's id; a decision's is `category/id`. */
  id: Schema.String,
  title: Schema.String,
  /** Its state when it was recorded, which may have moved on since. */
  state: Schema.String,
  /** Null when the call left it to the calling thread's project. */
  projectId: Schema.NullOr(ProjectId),
  /** The issue that holds a finding. */
  issueId: Schema.optional(Schema.String),
});
export type CapturedRecord = typeof CapturedRecord.Type;
