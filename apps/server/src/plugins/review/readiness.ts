import type { SecurityMode } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Readiness from "../Readiness.ts";
import { savedModeOf } from "./security/SecurityHold.ts";

// There is no screen for the mode yet; `review.security.setMode` sets it.
const SECURITY: Readiness.Check = { id: "security_mode", label: "Security mode", target: null };

/** A project with no saved mode scans in `warn`, which nobody chose. */
export const securityCheck = (mode: SecurityMode | null) =>
  mode === null
    ? Readiness.attention(
        SECURITY,
        "No security mode is saved for this project, so it scans in warn.",
      )
    : Readiness.ready(
        SECURITY,
        mode === "off"
          ? "Security mode is off, so turns are not scanned."
          : `Security mode is ${mode}.`,
      );

/** Review's readiness: the security mode is per project, so nothing without one. */
export class ReviewReadiness extends Context.Service<ReviewReadiness, Readiness.Checks>()(
  "t3/plugins/review/readiness/ReviewReadiness",
) {}

export const layer = Layer.effect(
  ReviewReadiness,
  Effect.map(SqlClient.SqlClient, (sql) =>
    ReviewReadiness.of({
      checks: (projectId) =>
        projectId === null
          ? Effect.succeed([])
          : savedModeOf(sql, projectId).pipe(
              Effect.map(securityCheck),
              Readiness.orAttention(SECURITY),
              Effect.map((check) => [check]),
            ),
    }),
  ),
);
