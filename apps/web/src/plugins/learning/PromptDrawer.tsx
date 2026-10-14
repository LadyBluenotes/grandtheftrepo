import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProjectId, PromptDetail, PromptKind } from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "~/components/ui/sheet";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Field } from "./ItemDrawer";
import {
  PROMPT_KIND_LABEL,
  PROMPT_KINDS,
  PROMPT_ORIGIN_LABEL,
  PROMPT_STATE_LABEL,
  PROMPT_STATE_VARIANT,
  isPromptKind,
  promptProblem,
  usePrompt,
  usePromptCommands,
} from "./promptState";
import { When } from "./When";

interface PromptDrawerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** The prompt on show, `new` for the form that saves one, or null when closed. */
  readonly open: number | "new" | null;
  /** Shows another prompt, such as the one just saved. */
  readonly onOpen: (id: number) => void;
  readonly onClose: () => void;
  /** Runs after a command lands, so the list behind the drawer refetches. */
  readonly onChanged: () => void;
}

/** One prompt: its state, its latest text to edit into a new version, and its earlier versions. */
export function PromptDrawer({
  environmentId,
  projectId,
  open,
  onOpen,
  onClose,
  onChanged,
}: PromptDrawerProps) {
  const detail = usePrompt(environmentId, typeof open === "number" ? open : null);
  return (
    <Sheet open={open !== null} onOpenChange={(next) => !next && onClose()}>
      <SheetPopup side="right" className="sm:max-w-lg">
        {open === "new" ? (
          <NewPrompt
            environmentId={environmentId}
            projectId={projectId}
            onSaved={(id) => {
              onChanged();
              onOpen(id);
            }}
          />
        ) : detail.data === null ? (
          <SheetHeader>
            <SheetTitle>{detail.error ?? "Loading…"}</SheetTitle>
          </SheetHeader>
        ) : (
          <PromptDetails
            // A new version seeds the form again.
            key={`${detail.data.prompt.id}:${detail.data.prompt.version}`}
            environmentId={environmentId}
            detail={detail.data}
            onChanged={() => {
              detail.refresh();
              onChanged();
            }}
          />
        )}
      </SheetPopup>
    </Sheet>
  );
}

/** Runs a command with the drawer locked meanwhile; a failure is a toast titled `failureTitle`. */
function useRun() {
  const [busy, setBusy] = useState(false);
  const run = async <A,>(
    failureTitle: string,
    command: () => Promise<AtomCommandResult<A, unknown>>,
    onSuccess: (value: A) => void,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    if (result._tag === "Success") {
      onSuccess(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: failureTitle,
        description: failure instanceof Error ? failure.message : String(failure),
      }),
    );
  };
  return { busy, run };
}

function PromptDetails({
  environmentId,
  detail: { prompt, versions },
  onChanged,
}: {
  readonly environmentId: EnvironmentId;
  readonly detail: PromptDetail;
  readonly onChanged: () => void;
}) {
  const commands = usePromptCommands(environmentId);
  const { busy, run } = useRun();
  const [title, setTitle] = useState(prompt.title);
  const [body, setBody] = useState(prompt.body);
  const locked = !commands.canWrite || busy;
  const changed = title.trim() !== prompt.title || body.trim() !== prompt.body;
  const problem = changed ? promptProblem(title, body) : null;

  const save = (event: FormEvent) => {
    event.preventDefault();
    void run(
      "Could not save the version",
      () => commands.edit({ id: prompt.id, title: title.trim(), body: body.trim() }),
      onChanged,
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>{prompt.title}</SheetTitle>
        <SheetDescription>
          {PROMPT_KIND_LABEL[prompt.kind]} · {PROMPT_ORIGIN_LABEL[prompt.origin]} origin ·{" "}
          {prompt.useCount === 1 ? "used once" : `used ${prompt.useCount} times`}
          {prompt.lastUsedAt === null ? null : (
            <>
              , last <When at={prompt.lastUsedAt} />
            </>
          )}
        </SheetDescription>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <Badge size="sm" variant={PROMPT_STATE_VARIANT[prompt.state]}>
            {PROMPT_STATE_LABEL[prompt.state]}
          </Badge>
          <span>v{prompt.version}</span>
          <span>
            · updated <When at={prompt.updatedAt} />
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {prompt.state === "proposed" ? (
            <Button
              size="sm"
              disabled={locked}
              onClick={() =>
                void run("Could not accept the prompt", () => commands.accept(prompt.id), onChanged)
              }
            >
              Accept
            </Button>
          ) : null}
          {prompt.state === "archived" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                void run(
                  "Could not unarchive the prompt",
                  () => commands.unarchive(prompt.id),
                  onChanged,
                )
              }
            >
              Unarchive
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() =>
                void run(
                  "Could not archive the prompt",
                  () => commands.archive(prompt.id),
                  onChanged,
                )
              }
            >
              Archive
            </Button>
          )}
        </div>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 px-6 pb-6">
          <form className="flex flex-col gap-2" onSubmit={save}>
            <Field label="Title">
              <Input
                size="sm"
                aria-label="Title"
                value={title}
                disabled={locked}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>
            <Field label="Body">
              <Textarea
                rows={10}
                aria-label="Body"
                value={body}
                disabled={locked}
                onChange={(event) => setBody(event.target.value)}
              />
            </Field>
            <div className="flex items-center justify-end gap-2">
              {problem === null ? null : (
                <span className="mr-auto text-xs text-destructive">{problem}</span>
              )}
              <Button type="submit" size="sm" disabled={locked || !changed || problem !== null}>
                Save as new version
              </Button>
            </div>
          </form>

          <Field label="Versions">
            <ol className="flex flex-col gap-3 text-sm">
              {versions.toReversed().map((version) => (
                <li key={version.version} className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">v{version.version}</span>
                    <span className="min-w-0 flex-1 truncate">{version.title}</span>
                    <span className="text-xs text-muted-foreground">
                      <When at={version.createdAt} />
                    </span>
                    {version.version === prompt.version ? (
                      <Badge size="sm" variant="secondary">
                        Latest
                      </Badge>
                    ) : (
                      <Button
                        size="xs"
                        variant="outline"
                        aria-label={`Restore version ${version.version}`}
                        disabled={locked}
                        onClick={() =>
                          void run(
                            "Could not restore the version",
                            () => commands.revert(prompt.id, version.version),
                            onChanged,
                          )
                        }
                      >
                        Restore
                      </Button>
                    )}
                  </div>
                  <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">
                    {version.body}
                  </p>
                </li>
              ))}
            </ol>
            <p className="text-xs text-muted-foreground">
              Restoring a version saves a copy of it as the latest; no version is ever removed.
            </p>
          </Field>
        </div>
      </ScrollArea>
    </>
  );
}

/** A person's save, which is active at once. */
function NewPrompt({
  environmentId,
  projectId,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly onSaved: (id: number) => void;
}) {
  const commands = usePromptCommands(environmentId);
  const { busy, run } = useRun();
  const [kind, setKind] = useState<PromptKind>("prompt");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const problem = promptProblem(title, body);
  const locked = !commands.canWrite || busy;

  const save = (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    void run(
      "Could not save the prompt",
      () => commands.create({ projectId, kind, title: title.trim(), body: body.trim() }),
      (saved) => onSaved(saved.id),
    );
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>New prompt</SheetTitle>
        <SheetDescription>
          A prompt is one message to send; a workflow is steps to follow in order. What you save
          here is active at once.
        </SheetDescription>
      </SheetHeader>
      <ScrollArea className="min-h-0 flex-1">
        <form className="flex flex-col gap-2 px-6 pb-6" onSubmit={save}>
          <Field label="Kind">
            <div className="w-40">
              <Select<string>
                value={kind}
                disabled={locked}
                onValueChange={(value) => {
                  if (isPromptKind(value)) setKind(value);
                }}
              >
                <SelectTrigger size="sm" aria-label="Kind">
                  <SelectValue>{PROMPT_KIND_LABEL[kind]}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {PROMPT_KINDS.map((candidate) => (
                    <SelectItem key={candidate} value={candidate}>
                      {PROMPT_KIND_LABEL[candidate]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          </Field>
          <Field label="Title">
            <Input
              size="sm"
              aria-label="Title"
              autoFocus
              value={title}
              disabled={locked}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <Field label="Body">
            <Textarea
              rows={10}
              aria-label="Body"
              value={body}
              disabled={locked}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            {problem === null || (title === "" && body === "") ? null : (
              <span className="mr-auto text-xs text-destructive">{problem}</span>
            )}
            <Button type="submit" size="sm" disabled={locked || problem !== null}>
              Save
            </Button>
          </div>
        </form>
      </ScrollArea>
    </>
  );
}
