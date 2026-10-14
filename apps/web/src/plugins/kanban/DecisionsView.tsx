import {
  KANBAN_DECISION_STATES,
  type EnvironmentId,
  type KanbanDecisionState,
  type ProjectId,
} from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Toggle } from "~/components/ui/toggle";
import { useEnvironmentQuery } from "~/state/query";
import { DecisionDrawer, useOpenBoardIssue } from "./DecisionDrawer";
import { DecisionForm } from "./DecisionForm";
import { DecisionRow, type DecisionTarget } from "./DecisionRow";
import { decisionRef, filterDecisions } from "./decisionList";
import { kanbanDecisions } from "./state";

type Categories = ReadonlyArray<{ readonly category: string; readonly count: number }>;

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const isState = (value: unknown): value is KanbanDecisionState =>
  KANBAN_DECISION_STATES.some((state) => state === value);

/**
 * The project's decisions, searchable and filtered by state and category; superseded ones stay
 * hidden until asked for. A row opens the drawer with the decision in full.
 */
export function DecisionsView({
  environmentId,
  projectId,
  category,
  categories,
  onCategoryChange,
  canWrite,
}: Scope & {
  readonly category: string | undefined;
  readonly categories: Categories;
  readonly onCategoryChange: (category: string | undefined) => void;
  readonly canWrite: boolean;
}) {
  // Every decision of the project, so the drawer resolves any supersession link from this read.
  const decisions = useEnvironmentQuery(kanbanDecisions({ environmentId, input: { projectId } }));
  const [query, setQuery] = useState("");
  const [state, setState] = useState<KanbanDecisionState | null>(null);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [recording, setRecording] = useState(false);
  const [target, setTarget] = useState<DecisionTarget | null>(null);
  const openIssue = useOpenBoardIssue();
  const all = decisions.data;
  const list = useMemo(
    () => filterDecisions(all ?? [], { query, state, category: category ?? null, showSuperseded }),
    [all, query, state, category, showSuperseded],
  );
  // The superseded ones the search and category would show, so the hint never promises an empty list.
  const superseded = filterDecisions(all ?? [], {
    query,
    state: "superseded",
    category: category ?? null,
    showSuperseded: true,
  }).length;
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pt-4 pb-12 sm:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="min-w-48 flex-1"
            size="sm"
            type="search"
            autoFocus
            value={query}
            placeholder="Search title, why, alternatives"
            aria-label="Search decisions"
            onChange={(event) => setQuery(event.target.value)}
          />
          <Select
            value={state ?? ""}
            onValueChange={(value) => setState(isState(value) ? value : null)}
          >
            <SelectTrigger size="sm" className="w-36 min-w-0" aria-label="State">
              <SelectValue>{state ?? "All states"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All states</SelectItem>
              {KANBAN_DECISION_STATES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Select
            value={category ?? ""}
            onValueChange={(value) => onCategoryChange(value ? String(value) : undefined)}
          >
            <SelectTrigger size="sm" className="w-44 min-w-0" aria-label="Category">
              <SelectValue>{category ?? "All categories"}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="">All categories</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.category} value={c.category}>
                  {c.category} ({c.count})
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Toggle
            size="sm"
            variant="outline"
            pressed={showSuperseded}
            onPressedChange={setShowSuperseded}
            aria-label="Show superseded decisions"
          >
            Superseded{superseded > 0 ? ` (${superseded})` : ""}
          </Toggle>
          {canWrite ? (
            <Button className="ms-auto" size="sm" onClick={() => setRecording((v) => !v)}>
              {recording ? "Cancel" : "Record decision"}
            </Button>
          ) : null}
        </div>
        {recording ? (
          <DecisionForm
            environmentId={environmentId}
            projectId={projectId}
            onDone={() => setRecording(false)}
          />
        ) : null}
        {all === null || recording ? null : all.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No decisions yet</EmptyTitle>
              <EmptyDescription>
                Agents record a call they make with the <code>kanban_write</code> tool, with the
                alternatives they weighed and the thread they decided in. Record one yourself with
                Record decision, or from a card&apos;s panel.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : list.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No decision matches</EmptyTitle>
              <EmptyDescription>
                {superseded > 0 && !showSuperseded && state === null
                  ? `Clear a filter, or show the ${superseded} superseded.`
                  : "Clear a filter or try other words."}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {list.map((decision) => (
              <DecisionRow
                key={decisionRef(decision)}
                environmentId={environmentId}
                projectId={projectId}
                decision={decision}
                canWrite={canWrite}
                onOpen={(editing) => setTarget({ ref: decisionRef(decision), editing })}
              />
            ))}
          </ul>
        )}
      </div>
      <DecisionDrawer
        environmentId={environmentId}
        projectId={projectId}
        target={target}
        onTargetChange={setTarget}
        canWrite={canWrite}
        onOpenIssue={openIssue}
      />
    </ScrollArea>
  );
}
