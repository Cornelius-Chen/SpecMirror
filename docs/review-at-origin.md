# Review at the original opinion

[← SpecMirror](../README.md) · [UI recording](../assets/review-at-origin.webm)

This release offers **two distinct, inspectable rehearsals**:

| Rehearsal | Real implementation exercised | What is substituted |
| --- | --- | --- |
| Isolated HTTP source loop | Fastify engineering routes, domain transitions, frozen run snapshot, source proof, YAML persistence and exact feedback link | Temporary source checkout, invented report, in-memory test agent and test-human identities |
| Isolated UI interaction | Actual React graph, feedback card, result projection, node switch and late-response guards | Invented project nodes and intercepted API replies in Playwright |

The [HTTP test](../apps/orchestrator/test-fixtures/graph-feedback-loop.test.ts) creates an initial run, opens an opinion on its output, adopts the request, runs a replacement with an actual changed `src/result.json`, checks the source diff and accepted paths, then submits **that exact replacement run**. A closure attempt before review is rejected. A deliberately injected test-human review completes the isolated fixture. Other tests reject anonymous/copied approvals, out-of-scope source changes, and source changes made after review.

The [UI test](../tests/e2e/graph-feedback.spec.ts) shows a recorded change, exact affected graph nodes and the submitted result at the opinion. Its `read the exact submitted report` and `recorded changes` cases check that the result belongs to the recorded `submitted_run_id`; its delayed-response case switches between opinions and verifies that an old response cannot replace the current one. These UI tests do not exercise the production authentication path.

The included screenshot and video come from the `recorded changes, exact impact and real artifacts return to the opinion location` UI test. They are **test output**, not a user's real project or a human acceptance event. The app itself can be started against the included fictional `.project/` workspace, with normal authentication rules intact.

The remaining gap is a real user's local opinion, actual source edit, and authenticated human acceptance observed together through the production UI. A future Jervis learning claim would need a separate valid feedback receipt and new-task evaluation.
