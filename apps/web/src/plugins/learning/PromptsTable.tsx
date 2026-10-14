import type { PromptState } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button, InlineButton } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { PromptDrawer } from "./PromptDrawer";
import {
  PROMPT_KIND_LABEL,
  PROMPT_ORIGIN_LABEL,
  PROMPT_STATE_LABEL,
  PROMPT_STATE_VARIANT,
  PROMPT_STATES,
  isPromptState,
  promptRows,
  usePromptCommands,
  usePrompts,
} from "./promptState";
import type { LearningScope } from "./state";
import { When } from "./When";

/**
 * A project's prompt library, narrowed by state and by the words of a search. A row's title opens
 * the drawer, as does New prompt; whatever the drawer changes refetches the list.
 */
export function PromptsTable({ environmentId, projectId }: LearningScope) {
  const [state, setState] = useState<PromptState | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<number | "new" | null>(null);
  const prompts = usePrompts({ environmentId, projectId });
  const { canWrite } = usePromptCommands(environmentId);
  const rows = useMemo(
    () => promptRows(prompts.data ?? [], { state, query }),
    [prompts.data, state, query],
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-56">
          <Input
            size="sm"
            type="search"
            aria-label="Search prompts"
            placeholder="Search titles and bodies"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="w-36">
          <Select<string>
            value={state ?? "all"}
            onValueChange={(value) => setState(isPromptState(value) ? value : null)}
          >
            <SelectTrigger size="sm" aria-label="State">
              <SelectValue>{state === null ? "All states" : PROMPT_STATE_LABEL[state]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="all">All states</SelectItem>
              {PROMPT_STATES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {PROMPT_STATE_LABEL[candidate]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <span className="text-xs text-muted-foreground">
          {rows.length === 1 ? "1 prompt" : `${rows.length} prompts`}
        </span>
        <div className="ml-auto">
          <Button size="sm" disabled={!canWrite} onClick={() => setOpen("new")}>
            <PlusIcon />
            New prompt
          </Button>
        </div>
      </div>
      {prompts.error !== null ? (
        <p className="text-sm text-muted-foreground">{prompts.error}</p>
      ) : prompts.data !== null && rows.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No prompts</EmptyTitle>
            <EmptyDescription>
              {prompts.data.length === 0
                ? "Save a prompt or workflow you reuse. Agents propose them with the prompt_save tool, and a learning item for a prompt arrives here as a proposal."
                : "Nothing matches the search and state."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Origin</TableHead>
              <TableHead>Uses</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>
                  <InlineButton onClick={() => setOpen(row.id)}>{row.title}</InlineButton>
                </TableCell>
                <TableCell>{PROMPT_KIND_LABEL[row.kind]}</TableCell>
                <TableCell>
                  <Badge size="sm" variant={PROMPT_STATE_VARIANT[row.state]}>
                    {PROMPT_STATE_LABEL[row.state]}
                  </Badge>
                </TableCell>
                <TableCell>{PROMPT_ORIGIN_LABEL[row.origin]}</TableCell>
                <TableCell>{row.useCount}</TableCell>
                <TableCell>
                  <When at={row.lastUsedAt} />
                </TableCell>
                <TableCell>
                  <When at={row.updatedAt} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <PromptDrawer
        environmentId={environmentId}
        projectId={projectId}
        open={open}
        onOpen={setOpen}
        onClose={() => setOpen(null)}
        onChanged={prompts.refresh}
      />
    </div>
  );
}
