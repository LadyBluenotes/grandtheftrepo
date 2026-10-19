import { defaultParseSearch, defaultStringifySearch } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { validatePluginScreenSearch } from "./pluginScreenSearch";

/** What a screen reads after a link wrote `search` into the URL and the router read it back. */
const throughUrl = (search: Record<string, unknown>) =>
  validatePluginScreenSearch(defaultParseSearch(defaultStringifySearch(search)));

describe("validatePluginScreenSearch", () => {
  it("brings back every tab and record a link writes, including ones that look like JSON", () => {
    for (const value of ["12", "1.50", "true", "null", "[1]", '"quoted"', "fix-login", " a b "]) {
      expect(throughUrl({ machine: "remote", tab: value, recordId: value })).toStrictEqual({
        machine: "remote",
        tab: value,
        recordId: value,
      });
    }
  });

  it("reads a hand-typed value the router parsed as the text that was typed", () => {
    expect(validatePluginScreenSearch(defaultParseSearch("?tab=true&recordId=12"))).toStrictEqual({
      tab: "true",
      recordId: "12",
    });
    expect(validatePluginScreenSearch(defaultParseSearch("?recordId=null"))).toStrictEqual({
      recordId: "null",
    });
  });

  it("trims the machine and the project, and keeps a tab's and record's exact text", () => {
    expect(
      validatePluginScreenSearch({
        machine: " env-1 ",
        projectId: " project-1 ",
        tab: " a ",
        recordId: " 7",
      }),
    ).toStrictEqual({ machine: "env-1", projectId: "project-1", tab: " a ", recordId: " 7" });
  });

  it("drops blank values and keys a screen does not read", () => {
    expect(
      validatePluginScreenSearch({ machine: " ", tab: "", recordId: "7", project: "p1" }),
    ).toStrictEqual({ recordId: "7" });
  });
});
