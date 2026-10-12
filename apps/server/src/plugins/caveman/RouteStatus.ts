import type { CavemanRoute } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface RouteReading {
  readonly route: CavemanRoute;
  readonly detail: string | null;
}

const SettingsEnv = Schema.fromJsonString(
  Schema.Struct({
    env: Schema.optional(Schema.Struct({ ANTHROPIC_BASE_URL: Schema.optional(Schema.String) })),
  }),
);
const decodeSettings = Schema.decodeUnknownOption(SettingsEnv);

const trimSlashes = (url: string) => url.replace(/\/+$/, "");

/** Where caveman's proxy listens: `CAVE_GATEWAY_URL` or the default, trailing slashes trimmed. */
export const proxyOrigin = (gatewayUrl: string | undefined): string =>
  trimSlashes(gatewayUrl?.trim() || "http://127.0.0.1:8787");

/**
 * Claude Code's `settings.json` text, or null when the file is absent. `caveman enable claude`
 * sets `env.ANTHROPIC_BASE_URL` to `<origin>/w/claude`; another value is `other`, none is
 * `direct`. Text that is not JSON sets nothing, so it reads as `direct`.
 */
export const claudeRoute = (settings: string | null, origin: string): RouteReading => {
  const decoded = settings === null ? Option.none() : decodeSettings(settings);
  const baseUrl = Option.getOrUndefined(decoded)?.env?.ANTHROPIC_BASE_URL?.trim();
  if (!baseUrl) return { route: "direct", detail: null };
  return trimSlashes(baseUrl) === `${origin}/w/claude`
    ? { route: "routed", detail: null }
    : { route: "other", detail: baseUrl };
};

/**
 * Codex's `config.toml` text, or null when the file is absent. `caveman enable codex` writes a
 * top-level `model_provider = "caveman"` and a `[model_providers.caveman]` table; both make it
 * `routed`. shortcut: line-based, so a table written as `[model_providers."caveman"]` reads as
 * `direct`; swap in a TOML parser if caveman ever writes that form.
 */
export const codexRoute = (config: string | null): RouteReading => {
  let table = false;
  let provider = false;
  let routedTable = false;
  for (const line of (config ?? "").split("\n")) {
    const text = line.trim();
    if (text.startsWith("[")) {
      table = true;
      routedTable ||= /^\[model_providers\.caveman\]\s*(#.*)?$/.test(text);
    } else if (!table && /^model_provider\s*=\s*["']caveman["']\s*(#.*)?$/.test(text)) {
      provider = true;
    }
  }
  return { route: provider && routedTable ? "routed" : "direct", detail: null };
};
