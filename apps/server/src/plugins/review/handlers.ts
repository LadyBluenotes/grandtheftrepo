import { REVIEW_METHODS, ReviewVerdictError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PluginRpc from "../PluginRpc.ts";
import * as ReviewRequests from "./ReviewRequests.ts";
import * as VerdictStore from "./VerdictStore.ts";

/** The handlers exist whether or not the plugin runs, so an inactive plugin answers with an error. */
const running = <I, S>(service: Context.Key<I, S>) =>
  Effect.serviceOption(service).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          new ReviewVerdictError({ code: "inactive", message: 'Plugin "review" is not running.' }),
        onSome: Effect.succeed,
      }),
    ),
  );

/** Merged into the host's dispatch table through `PluginHost.handlers`. */
export const table = PluginRpc.defineHandlers(REVIEW_METHODS)({
  verdicts: (input) => Effect.flatMap(running(VerdictStore.VerdictStore), (s) => s.list(input)),
  // A client is a person; agents request reviews through the `review_request` tool.
  request: ({ threadId }) =>
    Effect.flatMap(running(ReviewRequests.ReviewRequests), (s) =>
      s.request({ threadId, requestedBy: "user" }),
    ),
  requestsList: (input) =>
    Effect.flatMap(running(ReviewRequests.ReviewRequests), (s) => s.list(input)),
});
