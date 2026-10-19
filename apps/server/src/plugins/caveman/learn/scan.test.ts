import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as LearnScan from "./scan.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** The scanner with `stub` as the only `caveman` on `PATH`; `root` holds it and is the scan's cwd. */
const start = Effect.fn("test.start")(function* (stub: (root: string) => string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-caveman-scan-test-" });
  const bin = path.join(root, "bin");
  yield* fs.makeDirectory(bin);
  yield* fs.writeFileString(path.join(bin, "caveman"), stub(root), { mode: 0o755 });
  const scanner = yield* LearnScan.make;
  return {
    root,
    scanner,
    scan: scanner.start({
      env: { PATH: `${bin}:/usr/bin:/bin`, CAVE_LEARN_TIMEOUT: "5" },
      cwd: root,
    }),
    calls: fs.readFileString(path.join(root, "calls.txt")),
  };
});

const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe.skipIf(windowsHost)("caveman learn scan", () => {
  it.effect(
    "runs learn scan with CAVE_LEARN_TIMEOUT=120 and clears the last error on success",
    () =>
      run(
        Effect.gen(function* () {
          const h = yield* start(
            (root) =>
              `#!/bin/sh\nprintf '%s|%s|%s\\n' "$*" "$CAVE_LEARN_TIMEOUT" "$PWD" > '${root}/calls.txt'\n`,
          );
          yield* Fiber.join(yield* h.scan);
          assert.strictEqual(
            yield* h.calls,
            `learn scan --write-report --no-remember|120|${h.root}\n`,
          );
          assert.deepStrictEqual(yield* h.scanner.state, { running: false, lastError: null });
        }),
      ),
  );

  it.effect("keeps the last line of stderr when caveman exits non-zero", () =>
    run(
      Effect.gen(function* () {
        const h = yield* start(
          () =>
            "#!/bin/sh\necho 'reading sessions' >&2\necho 'no session stores found' >&2\nexit 1\n",
        );
        yield* Fiber.join(yield* h.scan);
        assert.deepStrictEqual(yield* h.scanner.state, {
          running: false,
          lastError: "Last scan failed: no session stores found",
        });
      }),
    ),
  );

  it.effect("stops a scan that overruns 180 seconds, and runs one at a time", () =>
    run(
      Effect.gen(function* () {
        const started = (root: string) => `${root}/started`;
        const h = yield* start(
          (root) => `#!/bin/sh\necho started > '${started(root)}'\nexec sleep 600\n`,
        );
        const fs = yield* FileSystem.FileSystem;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(ChildProcess.make("mkfifo", [started(h.root)]));
        const scan = yield* h.scan;
        // Reading the pipe returns once the stub runs, which is after the timeout is armed.
        yield* fs.readFileString(started(h.root));
        assert.deepStrictEqual(yield* h.scanner.state, { running: true, lastError: null });
        const refused = yield* Effect.flip(h.scan);
        assert.strictEqual(refused.code, "busy");
        assert.strictEqual(refused.message, "A scan is already running.");

        yield* TestClock.adjust("180 seconds");
        yield* Fiber.join(scan);
        assert.deepStrictEqual(yield* h.scanner.state, {
          running: false,
          lastError: "Last scan failed: caveman did not finish within 180 seconds.",
        });
      }),
    ),
  );

  it.effect("says caveman is not installed when the binary is gone", () =>
    run(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const h = yield* start(() => "#!/bin/sh\n");
        yield* fs.remove(`${h.root}/bin/caveman`);
        yield* Fiber.join(yield* h.scan);
        assert.deepStrictEqual(yield* h.scanner.state, {
          running: false,
          lastError:
            "Last scan failed: caveman is not installed. Run: npm install -g @caveman-ai/cli && caveman setup --install",
        });
      }),
    ),
  );
});
