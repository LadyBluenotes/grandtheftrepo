import { assert, describe, it } from "@effect/vitest";

import { claudeRoute, codexRoute, proxyOrigin } from "./RouteStatus.ts";

const origin = "http://127.0.0.1:8787";
const settings = (env: Record<string, unknown>) => JSON.stringify({ theme: "dark", env });

describe("proxyOrigin", () => {
  it("falls back to the default and trims trailing slashes", () => {
    assert.strictEqual(proxyOrigin(undefined), origin);
    assert.strictEqual(proxyOrigin("  "), origin);
    assert.strictEqual(proxyOrigin("http://127.0.0.1:9000//"), "http://127.0.0.1:9000");
  });
});

describe("claudeRoute", () => {
  it("is routed when the base URL is the proxy's Claude path", () => {
    const text = settings({ ANTHROPIC_BASE_URL: `${origin}/w/claude`, OTHER: "1" });
    assert.deepStrictEqual(claudeRoute(text, origin), { route: "routed", detail: null });
    assert.strictEqual(
      claudeRoute(settings({ ANTHROPIC_BASE_URL: `${origin}/w/claude/` }), origin).route,
      "routed",
    );
  });

  it("is other, with the URL, for any other base URL such as a hosted gateway", () => {
    assert.deepStrictEqual(
      claudeRoute(settings({ ANTHROPIC_BASE_URL: "https://gateway.example.com/w/claude" }), origin),
      { route: "other", detail: "https://gateway.example.com/w/claude" },
    );
    // Same path on another port is not this proxy.
    assert.strictEqual(
      claudeRoute(settings({ ANTHROPIC_BASE_URL: "http://127.0.0.1:9000/w/claude" }), origin).route,
      "other",
    );
  });

  it("is direct without a base URL, without env, without the file, or when the text is not JSON", () => {
    for (const text of [
      settings({ OTHER: "1" }),
      settings({ ANTHROPIC_BASE_URL: "" }),
      JSON.stringify({ theme: "dark" }),
      "{ not json",
      null,
    ]) {
      assert.deepStrictEqual(claudeRoute(text, origin), { route: "direct", detail: null });
    }
  });
});

describe("codexRoute", () => {
  const routed = [
    'model = "example-model"',
    'model_provider = "caveman"',
    "",
    "[model_providers.caveman]",
    'name = "Caveman"',
    'base_url = "http://127.0.0.1:8787/w/codex"',
  ].join("\n");

  it("is routed with the provider line and its table", () => {
    assert.deepStrictEqual(codexRoute(routed), { route: "routed", detail: null });
    assert.strictEqual(codexRoute(routed.replace(/\n/g, "\r\n")).route, "routed");
  });

  it("is direct when either half is missing, or the file is", () => {
    const withoutTable = routed.slice(0, routed.indexOf("[model_providers.caveman]"));
    const withoutProvider = routed.replace('model_provider = "caveman"\n', "");
    for (const text of [withoutTable, withoutProvider, 'model = "example-model"', "", null]) {
      assert.strictEqual(codexRoute(text).route, "direct");
    }
  });

  it("ignores a provider line that sits inside another table or a comment", () => {
    const scoped = ["[profiles.work]", 'model_provider = "caveman"', "[model_providers.caveman]"];
    assert.strictEqual(codexRoute(scoped.join("\n")).route, "direct");
    assert.strictEqual(
      codexRoute(['# model_provider = "caveman"', "[model_providers.caveman]"].join("\n")).route,
      "direct",
    );
  });

  it("is direct while another provider is selected", () => {
    const text = ['model_provider = "azure"', "[model_providers.caveman]"].join("\n");
    assert.strictEqual(codexRoute(text).route, "direct");
  });
});
