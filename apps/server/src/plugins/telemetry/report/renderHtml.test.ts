import { assert, it } from "@effect/vitest";

import { fullInput, INSIDE, pullRequest, thread } from "./fixtures.ts";
import { foldReport } from "./fold.ts";
import { renderHtml } from "./renderHtml.ts";

it("escapes a thread title that holds markup, and the page carries no script", () => {
  const html = renderHtml(
    foldReport({
      ...fullInput(),
      projectTitle: 'Acme "app" & co',
      threads: [
        thread("thread:hostile", {
          title: "<script>alert(1)</script>",
          settledAt: INSIDE,
          pullRequests: [
            pullRequest(1, {
              state: "merged",
              closedAt: INSIDE,
              url: "javascript:alert(1)",
            }),
          ],
        }),
      ],
    }),
  );
  assert.notInclude(html, "<script");
  assert.include(html, "&lt;script&gt;alert(1)&lt;/script&gt;");
  assert.include(html, "Acme &quot;app&quot; &amp; co");
  // A link only for http(s); anything else stays text.
  assert.notInclude(html, 'href="javascript');
});

it("names the plugin a section is missing, styled with the theme's variables", () => {
  const html = renderHtml(foldReport({ ...fullInput(), verdicts: undefined }));
  assert.include(html, "The review plugin is not running.");
  assert.include(html, "var(--foreground)");
  assert.include(html, "var(--border)");
});
