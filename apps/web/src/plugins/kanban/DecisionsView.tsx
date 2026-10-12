import type { EnvironmentId, KanbanDecision, KanbanStance, ProjectId } from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import { Badge } from "~/components/ui/badge";
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
import { Textarea } from "~/components/ui/textarea";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { reportFailure } from "./BoardPage";
import { kanbanDecisions, kanbanWrite } from "./state";

type Categories = ReadonlyArray<{ readonly category: string; readonly count: number }>;

interface Scope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

const NO_ISSUES: ReadonlyArray<string> = [];

const slugLike = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** Create or edit one decision. Pass `decision` to edit it in place. */
export function DecisionForm({
  environmentId,
  projectId,
  categories,
  decision,
  initialIssues = NO_ISSUES,
  onDone,
}: Scope & {
  readonly categories: Categories;
  readonly decision?: KanbanDecision;
  readonly initialIssues?: ReadonlyArray<string>;
  readonly onDone: () => void;
}) {
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const [category, setCategory] = useState(
    decision?.category ?? categories[0]?.category ?? "general",
  );
  const [stance, setStance] = useState<KanbanStance>(decision?.stance ?? "for");
  const [title, setTitle] = useState(decision?.title ?? "");
  const [why, setWhy] = useState(decision?.why ?? "");
  const [issues, setIssues] = useState((decision?.issues ?? initialIssues).join(", "));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const issueIds = issues
      .split(",")
      .map(slugLike)
      .filter((id) => id.length > 0);
    const base = { projectId, stance, title: title.trim(), why: why.trim(), issues: issueIds };
    const result = await write({
      environmentId,
      input:
        decision === undefined
          ? { ...base, action: "decision.create", category: slugLike(category) || "general" }
          : { ...base, action: "decision.update", category: decision.category, id: decision.id },
    });
    reportFailure("Could not save the decision", result);
    if (result._tag === "Success") onDone();
  };
  return (
    <form className="flex flex-col gap-2 rounded-lg border border-border p-3" onSubmit={submit}>
      <div className="flex gap-2">
        <Select
          value={stance}
          onValueChange={(value) =>
            value === "for" || value === "against" ? setStance(value) : undefined
          }
        >
          <SelectTrigger size="sm" className="w-28 min-w-0" aria-label="Stance">
            <SelectValue>{stance}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="for">for</SelectItem>
            <SelectItem value="against">against</SelectItem>
          </SelectPopup>
        </Select>
        <Input
          size="sm"
          list="kanban-decision-categories"
          value={category}
          disabled={decision !== undefined}
          placeholder="category"
          aria-label="Category"
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id="kanban-decision-categories">
          {categories.map((c) => (
            <option key={c.category} value={c.category} />
          ))}
        </datalist>
      </div>
      <Input
        size="sm"
        autoFocus
        value={title}
        placeholder="What was decided"
        aria-label="Decision"
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        rows={3}
        value={why}
        placeholder="Why"
        aria-label="Why"
        onChange={(event) => setWhy(event.target.value)}
      />
      <Input
        size="sm"
        value={issues}
        placeholder="Related issues, comma separated"
        aria-label="Related issues"
        onChange={(event) => setIssues(event.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button type="button" size="xs" variant="ghost-muted" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={title.trim().length === 0}>
          Save
        </Button>
      </div>
    </form>
  );
}

export function DecisionRow({
  environmentId,
  projectId,
  decision,
  categories,
  canWrite,
}: Scope & {
  readonly decision: KanbanDecision;
  readonly categories: Categories;
  readonly canWrite: boolean;
}) {
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <li>
        <DecisionForm
          environmentId={environmentId}
          projectId={projectId}
          categories={categories}
          decision={decision}
          onDone={() => setEditing(false)}
        />
      </li>
    );
  return (
    <li className="flex flex-col gap-1 rounded-lg border border-border/60 p-3 text-sm">
      <div className="flex items-start gap-2">
        <Badge size="sm" variant={decision.stance === "for" ? "success" : "warning"}>
          {decision.stance}
        </Badge>
        <span className="min-w-0 flex-1 font-medium">{decision.title}</span>
        {canWrite ? (
          <>
            <Button size="xs" variant="ghost-muted" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              size="xs"
              variant="ghost-destructive"
              onClick={async () =>
                reportFailure(
                  "Could not delete the decision",
                  await write({
                    environmentId,
                    input: {
                      projectId,
                      action: "decision.delete",
                      category: decision.category,
                      id: decision.id,
                    },
                  }),
                )
              }
            >
              Delete
            </Button>
          </>
        ) : null}
      </div>
      {decision.why.length > 0 ? (
        <p className="whitespace-pre-wrap text-muted-foreground">{decision.why}</p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {decision.category} · {decision.by} · {new Date(decision.at).toLocaleString()}
        {decision.issues.length > 0 ? ` · ${decision.issues.join(", ")}` : ""}
      </p>
    </li>
  );
}

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
  const decisions = useEnvironmentQuery(
    kanbanDecisions({
      environmentId,
      input: { projectId, ...(category === undefined ? {} : { category }) },
    }),
  );
  const [recording, setRecording] = useState(false);
  const list = [...(decisions.data ?? [])].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-5 pt-4 pb-12 sm:px-6">
        <div className="flex items-center gap-2">
          <Select
            value={category ?? ""}
            onValueChange={(value) => onCategoryChange(value ? String(value) : undefined)}
          >
            <SelectTrigger size="sm" className="w-56 min-w-0" aria-label="Category">
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
          {canWrite ? (
            <Button className="ml-auto" size="sm" onClick={() => setRecording((v) => !v)}>
              {recording ? "Cancel" : "Record decision"}
            </Button>
          ) : null}
        </div>
        {recording ? (
          <DecisionForm
            environmentId={environmentId}
            projectId={projectId}
            categories={categories}
            onDone={() => setRecording(false)}
          />
        ) : null}
        {list.length === 0 && !recording ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No decisions yet</EmptyTitle>
              <EmptyDescription>
                Record the calls you make for or against something, so the next agent inherits them.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((decision) => (
              <DecisionRow
                key={`${decision.category}:${decision.id}`}
                environmentId={environmentId}
                projectId={projectId}
                decision={decision}
                categories={categories}
                canWrite={canWrite}
              />
            ))}
          </ul>
        )}
      </div>
    </ScrollArea>
  );
}
