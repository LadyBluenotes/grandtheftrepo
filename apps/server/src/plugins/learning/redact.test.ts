import { assert, it } from "@effect/vitest";
import { DESCRIPTION_LIMIT, redact } from "./redact.ts";

it("replaces secrets and keeps the rest", () => {
  assert.strictEqual(redact("set TOKEN=abc123 then run"), "set TOKEN=[redacted] then run");
  assert.strictEqual(redact("api_key=sk-live-123 ok"), "api_key=[redacted] ok");
  assert.strictEqual(redact("Authorization: Bearer eyJhbGci.xyz"), "Authorization: [redacted]");
  assert.strictEqual(
    redact("ghp_abcDEF123 then xoxb-1-2-3 then github_pat_x_y then AKIAIOSFODNN7EXAMPLE"),
    "[redacted] then [redacted] then [redacted] then [redacted]",
  );
  assert.strictEqual(redact("monkey business, no token here"), "monkey business, no token here");
});

it("truncates to the limit after redacting", () => {
  assert.strictEqual(redact(`TOKEN=${"x".repeat(600)}`), "TOKEN=[redacted]");
  assert.strictEqual(redact("y".repeat(600)).length, DESCRIPTION_LIMIT);
});
