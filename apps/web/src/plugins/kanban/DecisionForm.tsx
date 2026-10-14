import {
  KANBAN_DECISION_STATES,
  KanbanAlternativeDisposition,
  KanbanAlternativeReasonKind,
  type KanbanAlternative,
  type KanbanDecision,
  type KanbanDecisionState,
  type ThreadId,
} from "@t3tools/contracts";
import { CheckIcon, PlusIcon, XIcon } from "lucide-react";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "~/components/ui/combobox";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Textarea } from "~/components/ui/textarea";
import { useThreadShellsForProjectRefs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { STATUS_LABEL, reportFailure } from "./BoardPage";
import { DISPOSITION_LABEL, REASON_KIND_LABEL, type DecisionScope } from "./DecisionRow";
import { kanbanBoard, kanbanWrite } from "./state";

const NO_ISSUES: ReadonlyArray<string> = [];

/** The states a person picks; `superseded` comes only from superseding. */
const PICKABLE_STATES = KANBAN_DECISION_STATES.filter((state) => state !== "superseded");
const isPickable = (value: unknown): value is KanbanDecisionState =>
  PICKABLE_STATES.some((state) => state === value);
const oneOf =
  <T extends string>(literals: ReadonlyArray<T>) =>
  (value: unknown): value is T =>
    literals.some((literal) => literal === value);
const isDisposition = oneOf(KanbanAlternativeDisposition.literals);
const isReasonKind = oneOf(KanbanAlternativeReasonKind.literals);

const slugLike = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/** An option being edited, keyed so its row keeps its inputs when another row is removed. */
type DraftAlternative = KanbanAlternative & { readonly key: number };
let draftKeys = 0;
const draft = (alternative: KanbanAlternative): DraftAlternative => ({
  ...alternative,
  key: draftKeys++,
});

/** A new option: the chosen one until the decision has one, then a rejected one. */
const blankAlternative = (current: ReadonlyArray<KanbanAlternative>) =>
  draft({
    title: "",
    disposition: current.some((alternative) => alternative.disposition === "chosen")
      ? "rejected"
      : "chosen",
    reason: "",
    reasonKind: "contextual",
  });

/** Create or edit one decision. Pass `decision` to edit it in place. */
export function DecisionForm({
  environmentId,
  projectId,
  decision,
  initialIssues = NO_ISSUES,
  onDone,
}: DecisionScope & {
  readonly decision?: KanbanDecision;
  readonly initialIssues?: ReadonlyArray<string>;
  readonly onDone: () => void;
}) {
  const write = useAtomCommand(kanbanWrite, { reportFailure: false });
  // Already open wherever a decision is shown, so this adds no subscription.
  const board = useEnvironmentQuery(kanbanBoard({ environmentId, input: { projectId } }));
  const categories = board.data?.decisionCategories ?? [];
  const categoryListId = useId();
  const [category, setCategory] = useState(
    decision?.category ?? categories[0]?.category ?? "general",
  );
  const [state, setState] = useState<KanbanDecisionState>(decision?.state ?? "accepted");
  const [title, setTitle] = useState(decision?.title ?? "");
  const [why, setWhy] = useState(decision?.why ?? "");
  const [alternatives, setAlternatives] = useState<ReadonlyArray<DraftAlternative>>(() =>
    (decision?.alternatives ?? []).map(draft),
  );
  const [reconsiderWhen, setReconsiderWhen] = useState(decision?.reconsiderWhen ?? "");
  const [issues, setIssues] = useState<ReadonlyArray<string>>(decision?.issues ?? initialIssues);
  const [threads, setThreads] = useState<ReadonlyArray<ThreadId>>(decision?.threads ?? []);

  const projectRefs = useMemo(() => [{ environmentId, projectId }], [environmentId, projectId]);
  const threadShells = useThreadShellsForProjectRefs(projectRefs);
  const issueOptions = useMemo(
    () =>
      [...(board.data?.issues ?? [])]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((issue) => ({
          key: issue.id,
          label: issue.title,
          detail: STATUS_LABEL[issue.status],
        })),
    [board.data],
  );
  const threadOptions = useMemo(
    () =>
      threadShells
        .filter((thread) => thread.deletedAt === null)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((thread) => ({ key: thread.id, label: thread.title.trim() || "Untitled thread" })),
    [threadShells],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const base = {
      projectId,
      title: title.trim(),
      why: why.trim(),
      alternatives: alternatives
        .filter((alternative) => alternative.title.trim().length > 0)
        .map(({ key: _key, ...alternative }) => ({
          ...alternative,
          title: alternative.title.trim(),
          reason: alternative.reason.trim(),
        })),
      reconsiderWhen: reconsiderWhen.trim(),
      issues,
      threads,
    };
    let result = await write({
      environmentId,
      input:
        decision === undefined
          ? {
              ...base,
              action: "decision.create",
              state,
              category: slugLike(category) || "general",
            }
          : { ...base, action: "decision.update", category: decision.category, id: decision.id },
    });
    // A state change is its own write, so its revision says what it was.
    if (result._tag === "Success" && decision !== undefined && state !== decision.state)
      result = await write({
        environmentId,
        input: {
          projectId,
          action: "decision.setState",
          category: decision.category,
          id: decision.id,
          state,
        },
      });
    reportFailure("Could not save the decision", result);
    if (result._tag === "Success") onDone();
  };

  const patchAlternative = (key: number, patch: Partial<KanbanAlternative>) =>
    setAlternatives((current) =>
      current.map((alternative) =>
        alternative.key === key ? { ...alternative, ...patch } : alternative,
      ),
    );

  return (
    <form className="flex flex-col gap-3 rounded-lg border border-border p-3" onSubmit={submit}>
      <div className="flex gap-2">
        <Select
          value={state}
          onValueChange={(value) => (isPickable(value) ? setState(value) : undefined)}
        >
          <SelectTrigger size="sm" className="w-32 min-w-0" aria-label="State">
            <SelectValue>{state}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {PICKABLE_STATES.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Input
          size="sm"
          list={categoryListId}
          value={category}
          disabled={decision !== undefined}
          placeholder="category"
          aria-label="Category"
          onChange={(event) => setCategory(event.target.value)}
        />
        <datalist id={categoryListId}>
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

      <FormSection label="Alternatives weighed">
        {alternatives.map((alternative) => (
          <div
            key={alternative.key}
            className="flex flex-col gap-1.5 rounded-md border border-border/60 p-2"
          >
            <div className="flex gap-2">
              <Input
                size="sm"
                value={alternative.title}
                placeholder="Option"
                aria-label="Option"
                onChange={(event) =>
                  patchAlternative(alternative.key, { title: event.target.value })
                }
              />
              <Select
                value={alternative.disposition}
                onValueChange={(value) =>
                  isDisposition(value)
                    ? patchAlternative(alternative.key, { disposition: value })
                    : undefined
                }
              >
                <SelectTrigger size="sm" className="w-36 min-w-0" aria-label="Disposition">
                  <SelectValue>{DISPOSITION_LABEL[alternative.disposition]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KanbanAlternativeDisposition.literals.map((option) => (
                    <SelectItem key={option} value={option}>
                      {DISPOSITION_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Remove option"
                onClick={() =>
                  setAlternatives((current) =>
                    current.filter((other) => other.key !== alternative.key),
                  )
                }
              >
                <XIcon />
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                size="sm"
                value={alternative.reason}
                placeholder="Why it went this way"
                aria-label="Reason"
                onChange={(event) =>
                  patchAlternative(alternative.key, { reason: event.target.value })
                }
              />
              <Select
                value={alternative.reasonKind}
                onValueChange={(value) =>
                  isReasonKind(value)
                    ? patchAlternative(alternative.key, { reasonKind: value })
                    : undefined
                }
              >
                <SelectTrigger size="sm" className="w-36 min-w-0" aria-label="Reason holds">
                  <SelectValue>{REASON_KIND_LABEL[alternative.reasonKind]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {KanbanAlternativeReasonKind.literals.map((option) => (
                    <SelectItem key={option} value={option}>
                      {REASON_KIND_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </div>
        ))}
        <div>
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => setAlternatives((current) => [...current, blankAlternative(current)])}
          >
            <PlusIcon />
            Add alternative
          </Button>
        </div>
      </FormSection>

      <Input
        size="sm"
        value={reconsiderWhen}
        placeholder="Reconsider when…"
        aria-label="Reconsider when"
        onChange={(event) => setReconsiderWhen(event.target.value)}
      />

      <FormSection label="Issues">
        <LinkedList
          items={issues.map((id) => ({
            key: id,
            label: issueOptions.find((option) => option.key === id)?.label ?? id,
          }))}
          onRemove={(id) => setIssues((current) => current.filter((key) => key !== id))}
        />
        <LinkPicker
          label="Link issue"
          searchLabel="Find an issue"
          emptyLabel="No issues on this board."
          options={issueOptions}
          selected={issues}
          onToggle={(id) =>
            setIssues((current) =>
              current.includes(id) ? current.filter((key) => key !== id) : [...current, id],
            )
          }
        />
      </FormSection>

      <FormSection label="Threads">
        <LinkedList
          items={threads.map((id) => ({
            key: id,
            label: threadOptions.find((option) => option.key === id)?.label ?? id,
          }))}
          onRemove={(id) => setThreads((current) => current.filter((key) => key !== id))}
        />
        <LinkPicker
          label="Link thread"
          searchLabel="Find a thread"
          emptyLabel="No threads in this project."
          options={threadOptions}
          selected={threads}
          onToggle={(id) =>
            setThreads((current) =>
              current.includes(id) ? current.filter((key) => key !== id) : [...current, id],
            )
          }
        />
      </FormSection>

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

function FormSection({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function LinkedList<K extends string>({
  items,
  onRemove,
}: {
  readonly items: ReadonlyArray<{ readonly key: K; readonly label: string }>;
  readonly onRemove: (key: K) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-sm">
      {items.map((item) => (
        <li key={item.key} className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost-muted"
            aria-label={`Unlink ${item.label}`}
            onClick={() => onRemove(item.key)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** A searchable list to link or unlink one item at a time; it stays open between picks. */
function LinkPicker<K extends string>({
  label,
  searchLabel,
  emptyLabel,
  options,
  selected,
  onToggle,
}: {
  readonly label: string;
  readonly searchLabel: string;
  readonly emptyLabel: string;
  readonly options: ReadonlyArray<{
    readonly key: K;
    readonly label: string;
    readonly detail?: string;
  }>;
  readonly selected: ReadonlyArray<K>;
  readonly onToggle: (key: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const shown =
    needle.length === 0
      ? options
      : options.filter(
          (option) =>
            option.label.toLowerCase().includes(needle) ||
            option.key.toLowerCase().includes(needle),
        );
  const keys = shown.map((option) => option.key);
  return (
    <Combobox
      items={keys}
      // The list is narrowed here, so the combobox does no filtering of its own.
      filteredItems={keys}
      filter={null}
      autoHighlight
      value={null}
      onValueChange={(key) => {
        const option = shown.find((entry) => entry.key === key);
        if (option !== undefined) onToggle(option.key);
      }}
      open={open}
      onOpenChange={(next, details) => {
        // Stays open on a pick, since a decision often links more than one.
        if (!next && details.reason === "item-press") {
          details.cancel();
          return;
        }
        setOpen(next);
        if (next) setQuery("");
      }}
    >
      <div>
        <ComboboxTrigger render={<Button type="button" size="xs" variant="outline" />}>
          <PlusIcon />
          {label}
        </ComboboxTrigger>
      </div>
      <ComboboxPopup align="start" side="bottom" className="w-80">
        <ComboboxSearchInput
          aria-label={searchLabel}
          placeholder={searchLabel}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxList className="max-h-72">
          {shown.length === 0 ? (
            <p className="p-2 text-xs text-muted-foreground">
              {needle.length > 0 ? "Nothing matches." : emptyLabel}
            </p>
          ) : (
            shown.map((option, index) => (
              <ComboboxItem key={option.key} hideIndicator index={index} value={option.key}>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.detail === undefined ? null : (
                  <span className="shrink-0 text-xs text-muted-foreground">{option.detail}</span>
                )}
                {selected.includes(option.key) ? (
                  <CheckIcon className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <span className="size-3.5 shrink-0" aria-hidden />
                )}
              </ComboboxItem>
            ))
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
