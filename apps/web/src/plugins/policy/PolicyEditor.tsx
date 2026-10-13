import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { PolicyListing, ProjectId } from "@t3tools/contracts";
import { useState, type FormEvent } from "react";

import { useRelativeTimeTick } from "~/components/settings/settingsLayout";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Textarea } from "~/components/ui/textarea";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { newPolicyProblem, STATE_BADGE, usePolicyCommands, versionsNewestFirst } from "./state";

/** A failed command as a toast; a success or an interrupt says nothing. */
export function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const failure = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: failure instanceof Error ? failure.message : String(failure),
    }),
  );
}

/**
 * One policy's versions, newest first, with Accept on each that is not current, and the form
 * for the next version, which starts from the body on show. Saving makes a draft; accepting a
 * draft makes it current and supersedes the one before, which the delivery sweep then installs.
 */
export function PolicyEditor({
  scope,
  policy,
  onChanged,
}: {
  readonly scope: ProjectId;
  readonly policy: PolicyListing;
  readonly onChanged: () => void;
}) {
  const { canWrite, create, accept } = usePolicyCommands();
  const [title, setTitle] = useState(policy.title);
  const [body, setBody] = useState(policy.body);
  const [busy, setBusy] = useState(false);
  useRelativeTimeTick(60_000);

  const run = async (
    label: string,
    command: () => Promise<AtomCommandResult<unknown, unknown>>,
  ) => {
    setBusy(true);
    const result = await command();
    setBusy(false);
    reportFailure(label, result);
    if (result._tag === "Success") onChanged();
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    void run("Could not save the version", () =>
      create({ projectId: scope, key: policy.key, title: title.trim(), body }),
    );
  };

  return (
    <section className="flex flex-col gap-4" aria-label={`Policy ${policy.key}`}>
      <div>
        <h2 className="font-mono text-sm font-medium">{policy.key}</h2>
        <p className="text-xs text-muted-foreground">{policy.title}</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Version</TableHead>
            <TableHead>State</TableHead>
            <TableHead>Title</TableHead>
            <TableHead>Changed</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {versionsNewestFirst(policy).map((version) => {
            const state = STATE_BADGE[version.state];
            return (
              <TableRow key={version.version}>
                <TableCell>v{version.version}</TableCell>
                <TableCell>
                  <Badge size="sm" variant={state.variant}>
                    {state.label}
                  </Badge>
                </TableCell>
                <TableCell>
                  <span className="block max-w-64 truncate">{version.title}</span>
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground">
                    {formatRelativeTimeLabel(version.at)}
                  </span>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end">
                    {version.state === "accepted" ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={!canWrite || busy}
                        onClick={() =>
                          void run("Could not accept the version", () =>
                            accept({ projectId: scope, key: policy.key, version: version.version }),
                          )
                        }
                      >
                        Accept
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <form className="flex flex-col gap-2" onSubmit={save}>
        <h3 className="text-sm font-medium">New version</h3>
        <Label htmlFor="policy-title">Title</Label>
        <Input
          id="policy-title"
          size="sm"
          value={title}
          disabled={!canWrite}
          onChange={(event) => setTitle(event.target.value)}
        />
        <Label htmlFor="policy-body">Body</Label>
        <Textarea
          id="policy-body"
          rows={8}
          value={body}
          disabled={!canWrite}
          onChange={(event) => setBody(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={!canWrite || busy || title.trim().length === 0}>
            Save draft
          </Button>
        </div>
      </form>
    </section>
  );
}

/** The form for a policy the scope does not have yet; its first version saves as a draft. */
export function NewPolicyForm({
  scope,
  existing,
  onCreated,
  onCancel,
}: {
  readonly scope: ProjectId;
  readonly existing: ReadonlyArray<PolicyListing>;
  readonly onCreated: (key: string) => void;
  readonly onCancel: () => void;
}) {
  const { canWrite, create } = usePolicyCommands();
  const [key, setKey] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const problem = newPolicyProblem(key, title, existing);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (problem !== null) return;
    setBusy(true);
    const result = await create({ projectId: scope, key, title: title.trim(), body });
    setBusy(false);
    reportFailure("Could not create the policy", result);
    if (result._tag === "Success") onCreated(key);
  };

  return (
    <form
      className="flex flex-col gap-2"
      aria-label="New policy"
      onSubmit={(event) => void save(event)}
    >
      <h2 className="text-sm font-medium">New policy</h2>
      <Label htmlFor="policy-key">Key</Label>
      <Input
        id="policy-key"
        size="sm"
        font="mono"
        autoFocus
        placeholder="lowercase-with-dashes"
        value={key}
        disabled={!canWrite}
        onChange={(event) => setKey(event.target.value.trim())}
      />
      <Label htmlFor="policy-new-title">Title</Label>
      <Input
        id="policy-new-title"
        size="sm"
        value={title}
        disabled={!canWrite}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Label htmlFor="policy-new-body">Body</Label>
      <Textarea
        id="policy-new-body"
        rows={8}
        value={body}
        disabled={!canWrite}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex items-center justify-end gap-2">
        {problem === null ? null : (
          <span className="mr-auto text-xs text-muted-foreground">{problem}</span>
        )}
        <Button type="button" size="sm" variant="ghost-muted" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={!canWrite || busy || problem !== null}>
          Save draft
        </Button>
      </div>
    </form>
  );
}
