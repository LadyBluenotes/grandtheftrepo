import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Readiness from "../Readiness.ts";
import { listening } from "./CavemanService.ts";
import { proxyOrigin } from "./RouteStatus.ts";

const PROXY: Readiness.Check = { id: "proxy", label: "Proxy", target: "plugins" };

/** An http or https URL with a host: anything else cannot be a proxy origin. */
const isOrigin = (origin: string) => {
  if (!URL.canParse(origin)) return false;
  const url = new URL(origin);
  return (url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "";
};

/**
 * One connect to the proxy's loopback port. `listening` answers null both for an origin it cannot
 * parse and for one on another machine, so the origin is checked first: a malformed one is a
 * setting to fix, while one on another machine is not probed and nothing here can fix it.
 */
export const proxyCheck = (origin: string, answers: boolean | null) =>
  !isOrigin(origin)
    ? Readiness.attention(
        PROXY,
        `The gateway URL ${origin} (CAVE_GATEWAY_URL) is not a valid origin, so caveman's proxy cannot be reached; set an http or https URL.`,
      )
    : answers === null
      ? Readiness.ready(
          PROXY,
          `The proxy at ${origin} is not on this machine, so it is not probed.`,
        )
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

/**
 * The checks over `probe`, `listening` outside tests. A malformed origin is never probed: one that
 * parses, such as `ftp://127.0.0.1:8787`, would still open a socket and could wait out its timeout.
 */
export const make = (probe: (origin: string) => Effect.Effect<boolean | null>) =>
  CavemanReadiness.of({
    checks: () =>
      Effect.gen(function* () {
        const origin = proxyOrigin((yield* HostProcess.Environment).CAVE_GATEWAY_URL);
        return [proxyCheck(origin, isOrigin(origin) ? yield* probe(origin) : null)];
      }),
  });

export const layer = Layer.succeed(CavemanReadiness, make(listening));
