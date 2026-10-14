import { describe, expect, it } from "vite-plus/test";

import { validatePluginScreenSearch } from "./pluginScreenSearch";

describe("validatePluginScreenSearch", () => {
  it("keeps the environment, tab and record, and drops blank or unknown keys", () => {
    expect(
      validatePluginScreenSearch({
        machine: "remote",
        tab: "items",
        recordId: "fix-login",
        project: "p1",
      }),
    ).toStrictEqual({ machine: "remote", tab: "items", recordId: "fix-login" });
    expect(validatePluginScreenSearch({ machine: " ", tab: "", recordId: null })).toStrictEqual({});
  });

  it("reads a typed numeric record as the string a link gives", () => {
    // The router JSON-parses `?recordId=12` to a number; a link's "12" round-trips as a string.
    expect(validatePluginScreenSearch({ recordId: 12 })).toStrictEqual({ recordId: "12" });
    expect(validatePluginScreenSearch({ recordId: "12" })).toStrictEqual({ recordId: "12" });
  });
});
