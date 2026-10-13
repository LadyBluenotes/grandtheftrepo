import { POLICY_ENVIRONMENT_PROJECT_ID, ProjectId, type PolicyListing } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canInstall,
  newPolicyProblem,
  pendingDraft,
  scopePolicies,
  versionsNewestFirst,
} from "./state";

const listing = (patch: Partial<PolicyListing>): PolicyListing => ({
  projectId: POLICY_ENVIRONMENT_PROJECT_ID,
  key: "ponytail",
  title: "Ponytail ladder",
  body: "Ask in order.",
  version: 1,
  state: "accepted",
  updatedAt: "2026-10-12T10:00:00.000Z",
  versions: [
    { version: 1, state: "accepted", title: "Ponytail ladder", at: "2026-10-12T10:00:00.000Z" },
  ],
  deliveries: [],
  status: [],
  ...patch,
});

const project = ProjectId.make("project-1");

describe("scopePolicies", () => {
  it("keeps the scope's own policies, the last changed first", () => {
    const listings = [
      listing({ key: "caveman", updatedAt: "2026-10-12T11:00:00.000Z" }),
      listing({ projectId: project, key: "review", updatedAt: "2026-10-12T12:00:00.000Z" }),
      listing({ key: "ponytail", updatedAt: "2026-10-12T10:00:00.000Z" }),
      listing({ key: "alpha", updatedAt: "2026-10-12T11:00:00.000Z" }),
    ];
    expect(scopePolicies(listings, POLICY_ENVIRONMENT_PROJECT_ID).map((p) => p.key)).toEqual([
      "alpha",
      "caveman",
      "ponytail",
    ]);
    expect(scopePolicies(listings, project).map((p) => p.key)).toEqual(["review"]);
    expect(scopePolicies(listings, ProjectId.make("project-2"))).toEqual([]);
  });
});

describe("pendingDraft", () => {
  it("is the newest draft above the version on show", () => {
    const at = "2026-10-12T10:00:00.000Z";
    expect(pendingDraft(listing({}))).toBeNull();
    expect(
      pendingDraft(
        listing({
          version: 2,
          versions: [
            { version: 1, state: "superseded", title: "A", at },
            { version: 2, state: "accepted", title: "B", at },
            { version: 3, state: "draft", title: "C", at },
            { version: 4, state: "draft", title: "D", at },
          ],
        }),
      )?.version,
    ).toBe(4);
    // A draft on show is the latest; an older draft below an accepted one is not pending.
    expect(
      pendingDraft(
        listing({
          version: 2,
          versions: [
            { version: 1, state: "draft", title: "A", at },
            { version: 2, state: "accepted", title: "B", at },
          ],
        }),
      ),
    ).toBeNull();
  });
});

describe("versionsNewestFirst", () => {
  it("reverses the server's earliest-first order", () => {
    const at = "2026-10-12T10:00:00.000Z";
    const versions = [
      { version: 1, state: "superseded" as const, title: "A", at },
      { version: 3, state: "draft" as const, title: "C", at },
      { version: 2, state: "accepted" as const, title: "B", at },
    ];
    expect(versionsNewestFirst({ versions }).map((v) => v.version)).toEqual([3, 2, 1]);
  });
});

describe("canInstall", () => {
  it("allows only an accepted version", () => {
    expect(canInstall({ state: "accepted" })).toBe(true);
    expect(canInstall({ state: "draft" })).toBe(false);
    expect(canInstall({ state: "superseded" })).toBe(false);
  });
});

describe("newPolicyProblem", () => {
  it("wants a well-formed, unused key and a title", () => {
    const existing = [{ key: "ponytail" }];
    expect(newPolicyProblem("", "T", existing)).toBe("A key is needed.");
    expect(newPolicyProblem("Bad Key", "T", existing)).toBe(
      "A key is lowercase letters, digits and dashes.",
    );
    expect(newPolicyProblem("ponytail", "T", existing)).toBe('"ponytail" already exists here.');
    expect(newPolicyProblem("review-2", "  ", existing)).toBe("A title is needed.");
    expect(newPolicyProblem("review-2", "Review", existing)).toBeNull();
  });
});
