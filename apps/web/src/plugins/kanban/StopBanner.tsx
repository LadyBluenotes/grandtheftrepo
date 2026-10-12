import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { OctagonXIcon } from "lucide-react";

import { Alert, AlertAction, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { reportFailure } from "./BoardPage";
import { kanbanStop, kanbanStopClear } from "./state";

/**
 * Shown above the board while the emergency stop is set, with the way out. The stop is the
 * environment's, not a project's: it holds back every launch the supervisor would make, and
 * nothing else. Running agents and work started by hand carry on.
 */
export function StopBanner({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const stop = useEnvironmentQuery(kanbanStop({ environmentId, input: {} }));
  const clear = useAtomCommand(kanbanStopClear, { reportFailure: false });
  const canClear = useAtomValue(kanbanStopClear.permissionAtom(environmentId));
  if (stop.data === null) return null;

  return (
    <div className="px-5 pt-3 sm:px-6">
      <Alert variant="warning">
        <OctagonXIcon />
        <AlertTitle>Emergency stop is set</AlertTitle>
        <AlertDescription>
          <p>
            Nothing the supervisor starts will launch until you clear it. Running agents carry on,
            and you can still start work yourself.
          </p>
          <p>
            Set by {stop.data.setBy} at {new Date(stop.data.setAt).toLocaleString()}
            {stop.data.reason === null ? "." : `: ${stop.data.reason}`}
          </p>
        </AlertDescription>
        <AlertAction>
          <Button
            size="xs"
            variant="outline"
            disabled={!canClear}
            onClick={async () => {
              const result = await clear({ environmentId, input: {} });
              reportFailure("Could not clear the emergency stop", result);
              if (result._tag === "Success") stop.refresh();
            }}
          >
            Clear
          </Button>
        </AlertAction>
      </Alert>
    </div>
  );
}
