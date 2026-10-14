import { describe, expect, it } from "vite-plus/test";

import { promptProblem } from "./promptState";

describe("promptProblem", () => {
  it("accepts a one-line title and a body within the limit", () => {
    expect(promptProblem(" Review ", " Read it. ")).toBeNull();
  });

  it("names what is wrong", () => {
    expect(promptProblem(" ", "Body")).toBe("The title is empty.");
    expect(promptProblem("Two\nlines", "Body")).toBe(
      "The title is one line of at most 200 characters.",
    );
    expect(promptProblem("Title", "")).toBe("The body is empty.");
    expect(promptProblem("Title", "x".repeat(10_001))).toBe(
      "The body is at most 10,000 characters.",
    );
  });
});
