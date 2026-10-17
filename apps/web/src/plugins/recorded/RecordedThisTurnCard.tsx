import type { CapturedRecord, RunId, ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useThreadShell } from "~/state/entities";
import { capturedRecordTarget, groupCapturedRecords, RECORDED_ROWS_SHOWN } from "./logic";

/** The runs whose long card a person opened, keyed `<thread key>:<run id>`; closing drops one. */
const EXPANDED_STORAGE_KEY = "t3code:recorded-this-turn:expanded";
const ExpandedRuns = Schema.Record(Schema.String, Schema.Boolean);
const NONE_EXPANDED: typeof ExpandedRuns.Type = {};

/**
 * Under a turn's last reply: what the agent recorded during it, grouped by kind, each row opening
 * the record where it lives. Nothing while the turn recorded nothing.
 */
export const RecordedThisTurnCard = memo(function RecordedThisTurnCard(props: {
  readonly records: ReadonlyArray<CapturedRecord> | undefined;
  readonly runId: RunId | null;
  readonly threadRef: ScopedThreadRef | null;
  readonly routeThreadKey: string;
}) {
  const { records, runId, threadRef, routeThreadKey } = props;
  if (records === undefined || records.length === 0 || runId === null || threadRef === null) {
    return null;
  }
  return (
    <RecordedThisTurnCardInner
      records={records}
      expandedKey={`${routeThreadKey}:${runId}`}
      threadRef={threadRef}
    />
  );
});

function RecordedThisTurnCardInner({
  records,
  expandedKey,
  threadRef,
}: {
  readonly records: ReadonlyArray<CapturedRecord>;
  readonly expandedKey: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const navigate = useNavigate();
  const projectId = useThreadShell(threadRef)?.projectId ?? null;
  const [expandedRuns, setExpandedRuns] = useLocalStorage(
    EXPANDED_STORAGE_KEY,
    NONE_EXPANDED,
    ExpandedRuns,
  );
  const groups = useMemo(() => groupCapturedRecords(records), [records]);
  const collapsible = records.length > RECORDED_ROWS_SHOWN;
  const expanded = !collapsible || expandedRuns[expandedKey] === true;
  const thread = { environmentId: threadRef.environmentId, projectId };

  const toggle = () =>
    setExpandedRuns((current) => {
      const { [expandedKey]: _open, ...rest } = current;
      return expanded ? rest : { ...rest, [expandedKey]: true };
    });

  const open = (record: CapturedRecord) => {
    const target = capturedRecordTarget(record, thread);
    switch (target?.to) {
      case "/board":
        return void navigate(target);
      case "/plugins/$pluginId":
        return void navigate(target);
    }
  };

  return (
    <section
      aria-label="Recorded this turn"
      className="mt-4 rounded-lg bg-secondary dark:bg-input/20"
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-foreground">
        <span>
          Recorded this turn <span className="text-muted-foreground">{records.length}</span>
        </span>
        {collapsible ? (
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={expanded}
            data-scroll-anchor-ignore
            onClick={toggle}
          >
            {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
            {expanded ? "Collapse" : "Show all"}
          </Button>
        ) : null}
      </div>
      {expanded ? (
        <div className="flex flex-col gap-2 px-2 pb-2">
          {groups.map((group) => (
            <div key={group.kind}>
              <div className="px-1 py-1 text-2xs font-medium text-muted-foreground">
                {group.label} <span className="tabular-nums">{group.records.length}</span>
              </div>
              {group.records.map((record) => (
                <button
                  key={record.id}
                  type="button"
                  disabled={capturedRecordTarget(record, thread) === null}
                  className="group flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none"
                  onClick={() => open(record)}
                >
                  <span className="min-w-0 flex-1 truncate text-xs text-foreground/85 group-hover:text-foreground">
                    {record.title}
                  </span>
                  <Badge size="sm" variant="outline">
                    {record.state.replaceAll("_", " ")}
                  </Badge>
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
