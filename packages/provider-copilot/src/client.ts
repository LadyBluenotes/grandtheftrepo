/**
 * Copilot's client definition: settings form, label, token field, badge, and
 * glyph. Browser- and React Native-safe.
 *
 * @module provider-copilot/client
 */
import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { CopilotSettings } from "./settings.ts";

export const copilotClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("copilot"),
  label: "Copilot",
  settingsSchema: CopilotSettings,
  // Copilot CLI's ACP server is a public preview and may change under T3.
  badgeLabel: "Beta",
  environmentFields: [
    {
      name: "COPILOT_GITHUB_TOKEN",
      label: "GitHub token",
      description:
        "Optional. A fine-grained token with the Copilot Requests permission; overrides `copilot login` for this instance.",
      placeholder: "github_pat_…",
      sensitive: true,
    },
  ],
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#24292F", dark: "#F0F6FC" },
    paths: [
      {
        // Visor silhouette with the two lens openings and mouth slots cut out.
        d: "M12 7.5C12 6.5 11.99 3.43 8 4C4.5 4.5 4 6.5 4 7.5V12C2.667 12.667 2 13.333 2 14C2 15 2 17 3.5 18C6.5 20 10 21 12 21C14 21 17.5 20 20.5 18C22 17 22 15 22 14C22 13.333 21.333 12.667 20 12V7.5C20 6.5 19.5 4.5 16 4C12.01 3.43 12 6.5 12 7.5ZM10.8 7.7C10.8 7 10.8 5 8.1 5.4C5.7 5.75 5.3 7.1 5.3 7.7C5.3 8.75 5.3 10.4 7.4 10.4C10.1 10.4 10.8 8.65 10.8 7.7ZM13.2 7.7C13.2 7 13.2 5 15.9 5.4C18.3 5.75 18.7 7.1 18.7 7.7C18.7 8.75 18.7 10.4 16.6 10.4C13.9 10.4 13.2 8.65 13.2 7.7ZM9.3 14.4H10.7V17.6H9.3ZM13.3 14.4H14.7V17.6H13.3Z",
        fillRule: "evenodd",
      },
    ],
  },
});
