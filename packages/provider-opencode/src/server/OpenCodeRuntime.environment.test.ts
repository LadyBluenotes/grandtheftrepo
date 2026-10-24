import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("resolveOpenCodeServerPassword", () => {
  it("uses the settings password when local settings and environment differ", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        {
          external: false,
          serverPassword: "settings-password",
          environment: { OPENCODE_SERVER_PASSWORD: "environment-password" },
        },
        {},
      ),
    ).toBe("settings-password");
  });

  it("does not send an inherited local password to an external server", () => {
    expect(
      OpenCodeRuntime.resolveOpenCodeServerPassword(
        { external: true, environment: { OPENCODE_SERVER_PASSWORD: "local-secret" } },
        { OPENCODE_SERVER_PASSWORD: "inherited-secret" },
      ),
    ).toBeUndefined();
  });
});

function makeHealthClient(
  result: (options?: { readonly signal?: AbortSignal }) => Promise<unknown>,
): OpencodeClient {
  return {
    global: {
      health: result,
    },
  } as unknown as OpencodeClient;
}

describe("verifyOpenCodeServerVersion", () => {
  effectIt.effect("rejects a server below the supported version", () =>
    Effect.gen(function* () {
      const error = yield* OpenCodeRuntime.verifyOpenCodeServerVersion(
        makeHealthClient(() => Promise.resolve({ data: { healthy: true, version: "1.14.18" } })),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OpenCodeRuntime.OpenCodeRuntimeError);
      expect(error.detail).toContain("v1.14.18 is too old");
    }),
  );

  for (const {} of [
    { healthy: true },
    { healthy: true, version: "not-a-version" },
    { healthy: false, version: "1.14.19" },
  ]) {
  }
});

describe("OpenCode database lock startup", () => {
  effectIt.live.each([
    { mode: "transient", keepPipesOpen: false },
    { mode: "permanent", keepPipesOpen: false },
    { mode: "configuration", keepPipesOpen: false },
    { mode: "unrelated", keepPipesOpen: false },
    { mode: "transient", keepPipesOpen: true },
    { mode: "permanent", keepPipesOpen: true },
    { mode: "configuration", keepPipesOpen: true },
    { mode: "unrelated", keepPipesOpen: true },
  ] as const)(
    "handles $mode startup failures with bounded process ownership (open pipes: $keepPipesOpen)",
    ({ mode, keepPipesOpen }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-opencode-lock-" });
        const platform = yield* HostProcess.Platform;
        const executablePath = yield* HostProcess.ExecutablePath;
        const environment = yield* HostProcess.Environment;
        const scriptPath = `${root}/fake.mjs`;
        const attemptsPath = `${root}/attempts`;
        yield* Effect.addFinalizer(() =>
          fs.readFileString(`${attemptsPath}.descendants`).pipe(
            Effect.orElseSucceed(() => ""),
            Effect.flatMap((pids) =>
              Effect.sync(() => {
                for (const pid of pids.trim().split("\n").filter(Boolean)) {
                  try {
                    process.kill(Number(pid), "SIGKILL");
                  } catch {
                    // The fixture descendant may already have exited.
                  }
                }
              }),
            ),
          ),
        );
        yield* fs.writeFileString(
          scriptPath,
          `
import { readFileSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
const path = process.env.T3_TEST_ATTEMPTS;
let attempt = 0;
try { attempt = Number(readFileSync(path, "utf8")); } catch {}
writeFileSync(path, String(++attempt));
if (${JSON.stringify(mode)} !== "transient" || attempt < 3) {
  // Inherited pipes remain open after the direct child exits.
  if (${keepPipesOpen}) {
    const descendant = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
    writeFileSync(path + ".descendants", descendant.pid + "\\n", { flag: "a" });
    descendant.unref();
  }
  // A lock mentioned outside the startup diagnostic is not a lock failure.
  if (${JSON.stringify(mode)} === "unrelated") writeSync(1, "note: database is locked was seen earlier\\n");
  writeSync(2, ${JSON.stringify(mode === "configuration" || mode === "unrelated" ? "Invalid configuration" : "SQLiteError: database is locked (SQLITE_BUSY)")} + "\\n");
  process.exit(1);
}
const server = createServer((req, res) => res.end("ok"));
server.listen(0, "127.0.0.1", () => console.log("opencode server listening on http://127.0.0.1:" + server.address().port));
`,
        );
        const binaryPath = `${root}/opencode${platform === "win32" ? ".cmd" : ""}`;
        yield* fs.writeFileString(
          binaryPath,
          platform === "win32"
            ? '@echo off\n"%T3_TEST_NODE_BINARY%" "%T3_TEST_OPENCODE_SCRIPT%" %*\n'
            : '#!/bin/sh\nexec "$T3_TEST_NODE_BINARY" "$T3_TEST_OPENCODE_SCRIPT" "$@"\n',
        );
        if (platform !== "win32") yield* fs.chmod(binaryPath, 0o700);
        const runtime = yield* OpenCodeRuntime.OpenCodeRuntime;
        const result = yield* Effect.result(
          runtime.startOpenCodeServerProcess({
            binaryPath,
            directory: root,
            port: 0,
            timeoutMs: 2_000,
            environment: {
              ...environment,
              T3_TEST_NODE_BINARY: executablePath,
              T3_TEST_OPENCODE_SCRIPT: scriptPath,
              T3_TEST_ATTEMPTS: attemptsPath,
            },
            verify: () => Effect.succeed("1.14.19"),
          }),
        );
        expect(result._tag).toBe(mode === "transient" ? "Success" : "Failure");
        expect(Number(yield* fs.readFileString(attemptsPath))).toBe(
          mode === "transient" ? 3 : mode === "permanent" ? 4 : 1,
        );
        if (result._tag === "Failure") {
          expect(result.failure.reason).toBe(mode === "permanent" ? "databaseLocked" : undefined);
          const stderr =
            mode === "permanent"
              ? "SQLiteError: database is locked (SQLITE_BUSY)"
              : "Invalid configuration";
          expect(result.failure.detail).toContain(`stderr:\n${stderr}`);
          expect(result.failure.cause).toMatchObject({ exitCode: 1, stderr: `${stderr}\n` });
        }
      }).pipe(
        Effect.scoped,
        Effect.provide([
          OpenCodeRuntime.layer.pipe(
            Layer.provide(OpenCodeServerLedger.layerTest),
            Layer.provideMerge(NodeServices.layer),
          ),
          FetchHttpClient.layer,
        ]),
      ),
    15_000,
  );
});
