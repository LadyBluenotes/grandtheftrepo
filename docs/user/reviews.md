# Reviews

A reviewing agent can judge another thread's work at one checkpoint, the snapshot T3 Code takes at
the end of each turn. It approves the work or sends it back with one reason: a defect, a missing
part, changes nobody asked for, no evidence that it works, a broken project convention, or an
unclear request. Agents give verdicts with the `review_verdict` MCP tool and read them with
`review_verdicts`.

## Requesting a review

Ask the agent working in a thread to request a review when it finishes; it uses the
`review_request` tool. The request names the thread's latest checkpoint and stays open until a
reviewer gives a verdict on that checkpoint. Asking again before the thread changes returns the
same request. `review_requests` lists a thread's requests and where each stands.

A review describes the work as it was at its checkpoint. Once the thread changes after that, the
review is out of date: T3 Code marks the request stale, opens a new request at the latest
checkpoint, and that one needs its own verdict. An out-of-date review stays out of date, even if
you roll the thread back to the checkpoint it reviewed.
