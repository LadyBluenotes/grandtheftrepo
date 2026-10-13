import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Readiness from "../Readiness.ts";
import { listening } from "./CavemanService.ts";
import { proxyOrigin } from "./RouteStatus.ts";

const PROXY: Readiness.Check = { id: "proxy", label: "Proxy", target: "plugins" };

/**
 * One connect to the proxy's loopback port. An origin on another machine is not probed, and
 * nothing here can fix it, so it is not flagged.
 */
export const proxyCheck = (origin: string, answers: boolean | null) =>
  answers === null
    ? Readiness.ready(PROXY, `The proxy at ${origin} is not on this machine, so it is not probed.`)
    : answers
      ? Readiness.ready(PROXY, `The proxy answers at ${origin}.`)
      : Readiness.attention(
          PROXY,
          `Nothing answers at ${origin}, so instances routed through caveman cannot reach their models; start caveman's proxy.`,
        );

/** Caveman's readiness: the proxy, for the environment. */
export class CavemanReadiness extends Context.Service<CavemanReadiness, Readiness.Checks>()(
  "t3/plugins/caveman/readiness/CavemanReadiness",
) {}

export const layer = Layer.succeed(
  CavemanReadiness,
  CavemanReadiness.of({
    checks: () =>
      Effect.gen(function* () {
        const origin = proxyOrigin((yield* HostProcess.Environment).CAVE_GATEWAY_URL);
        return [proxyCheck(origin, yield* listening(origin))];
      }),
  }),
);
