import { assert, describe, it } from "@effect/vitest";

import { SPEC_FORMAT, validateSpec } from "./SpecValidator.ts";

const spec = (...sections: ReadonlyArray<string>) => sections.join("\n\n");
const goal = "## Goal\nLogin survives an expired cookie.";
const approach = "## Approach\n- Detect the expired cookie.\n- Refresh it before redirecting.";
const acceptance = "## Acceptance\n- [ ] An expired cookie lands on the page asked for.";
const outOfScope = "## Out of scope\nSession storage.";

const reason = (text: string) => {
  const check = validateSpec(text);
  return check.valid ? null : check.reason;
};

describe("validateSpec", () => {
  it("accepts the three sections in order and returns the Acceptance items", () => {
    assert.deepEqual(validateSpec(spec(goal, approach, acceptance)), {
      valid: true,
      acceptance: ["An expired cookie lands on the page asked for."],
    });
  });

  it("accepts Out of scope last, text before Goal, numbered steps and wrapped items", () => {
    const check = validateSpec(
      spec(
        "Here is the spec.",
        goal,
        "## Approach\n1. Detect the expired cookie.\n2. Refresh it\n   before redirecting.",
        "## Acceptance\n- [ ] The redirect keeps\n  the query string.\n\n- [ ] No loop.",
        outOfScope,
      ),
    );
    assert.deepEqual(check, {
      valid: true,
      acceptance: ["The redirect keeps the query string.", "No loop."],
    });
  });

  it("accepts the format the drafting thread is shown, once its placeholders are filled", () => {
    assert.isTrue(validateSpec(SPEC_FORMAT.replace("- Two to five", "- One\n- Two to five")).valid);
  });

  describe("refusal fixtures", () => {
    it("missing sections", () => {
      assert.strictEqual(reason(spec(goal, approach)), "Missing section: Acceptance.");
      assert.strictEqual(reason(spec(approach, acceptance)), "Missing section: Goal.");
      assert.strictEqual(reason(spec(goal, acceptance)), "Missing section: Approach.");
      assert.strictEqual(reason("A rough idea with no sections."), "Missing section: Goal.");
    });

    it("reordered sections", () => {
      assert.strictEqual(
        reason(spec(approach, goal, acceptance)),
        "Sections are out of order: Approach comes before Goal.",
      );
      assert.strictEqual(
        reason(spec(goal, acceptance, approach)),
        "Sections are out of order: Acceptance comes before Approach.",
      );
      assert.strictEqual(
        reason(spec(goal, approach, outOfScope, acceptance)),
        "Sections are out of order: Out of scope comes before Acceptance.",
      );
    });

    it("extra sections and repeated ones", () => {
      assert.strictEqual(
        reason(spec(goal, approach, "## Notes\nAsk Theo.", acceptance)),
        'Unexpected heading "## Notes". The only sections are Goal, Approach, Acceptance and Out of scope.',
      );
      assert.strictEqual(
        reason(spec("# Spec", goal, approach, acceptance)),
        'Unexpected heading "# Spec". The only sections are Goal, Approach, Acceptance and Out of scope.',
      );
      assert.strictEqual(
        reason(spec(goal, approach, "### Detail", acceptance)),
        'Unexpected heading "### Detail". The only sections are Goal, Approach, Acceptance and Out of scope.',
      );
      assert.strictEqual(
        reason(spec(goal, approach, acceptance, goal)),
        "Duplicate section: Goal.",
      );
    });
  });

  it("refuses an empty Goal", () => {
    assert.strictEqual(reason(spec("## Goal\n\n", approach, acceptance)), "Goal is empty.");
  });

  it("refuses an Approach that is not a list of two to five items", () => {
    const steps = (count: number) =>
      `## Approach\n${Array.from({ length: count }, (_, i) => `- Step ${i + 1}.`).join("\n")}`;
    assert.strictEqual(
      reason(spec(goal, steps(6), acceptance)),
      "Approach has 6 items; the limit is 5.",
    );
    assert.isNull(reason(spec(goal, steps(5), acceptance)));
    assert.strictEqual(
      reason(spec(goal, steps(1), acceptance)),
      "Approach has 1 item; it needs at least 2.",
    );
    assert.strictEqual(
      reason(spec(goal, "## Approach\nJust do it.", acceptance)),
      "Approach must be a list, one step per item.",
    );
  });

  it("refuses an Acceptance that is not a checklist with an item", () => {
    assert.strictEqual(
      reason(spec(goal, approach, "## Acceptance\n- It works.")),
      'Acceptance must be a checklist of "- [ ]" items.',
    );
    assert.strictEqual(
      reason(spec(goal, approach, "## Acceptance\n- [x] Already done.")),
      'Acceptance must be a checklist of "- [ ]" items.',
    );
    assert.strictEqual(
      reason(spec(goal, approach, "## Acceptance\n")),
      'Acceptance has no items; it needs at least one "- [ ]" item.',
    );
  });
});
