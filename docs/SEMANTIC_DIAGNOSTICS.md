# Selected trace diagnostics and bounded session campaign

The inspector can continue to print the familiar text transcript:

```sh
node tools/inspect-selected-harness.mjs path/to/episode.json
```

To write both an offline JSON report and a standalone HTML report, use:

```sh
node tools/inspect-selected-harness.mjs path/to/episode.json --report /tmp/trace-report
```

The optional `--expected EXPECTED.json` comparison records the first structurally
different public timeline record. `--track ID` limits rendered records to one
track; `--transport` includes transport details. The report keeps the public
episode bytes and partial invalid traces, and includes exact source, invocation
and track anchors, visible selected-state changes, plus causal links between
requests, awaits, resumes and results. Replay uses
`SelectedExecutionHarness.replay(..., { requireTerminal: false })`; inspection
does not invoke services, redispatch effects, repair records or infer missing
observations. The HTML contains inline CSS only, escapes trace-derived text, and
does not load external assets.

Run the deterministic, source-certified session protocol campaign with:

```sh
npm run training:session-campaign -- --invocations 32 --iterations 7 --out /tmp/semantic-session
```

The campaign uses a bounded (2–256) number of distinct inputs in one session
and the existing fixture broker, owned source executor, independent
source-reference worker and selected-harness replay path. It checks repeated
source-certified invocations, reverse settlement of two independent reads per
invocation, duplicate ingress and result delivery, checkpoint/restore refusal
to redispatch an uncertain effect, cancellation and late-result behavior (the
current harness accepts a matching late observation while leaving the cancelled
invocation closed), and terminal cleanup. The report records session size and
remaining active jobs, intents and handlers, including the uncertainty retained
at cancellation and whether the later observation resolved it,
along with source-reference agreement and actual replay timings and process RSS
measurements. Its “cold” sample is the first replay in the current process
after source certification (the Node modules are already loaded); warm samples
are subsequent replay calls in that process. Source certification time is
reported separately. RSS at start/end and the process-lifetime maximum are
reported as process measurements; the maximum is not attributed to one case.

This is deterministic engineering evidence. It does not call a model, train an
optimizer, admit training rows, or claim learned capability. The fixture-backed
service observations exist only to verify source behavior and trace plumbing.

## Close a real model process cleanly

`createMegatokenProcessSelector()` now exposes asynchronous `shutdown()`.
After outstanding requests finish, it sends EOF and waits for a successful
process exit so Megatoken can close its runtime and flush its optional serving
profile. It is idempotent and has a bounded deadline (10 seconds by default).
A failed exit or deadline produces a failure; timeout cleanup terminates the
child. `close()` remains the immediate abort path for active or failed requests.
The selected evaluation CLI uses graceful shutdown when its requests have drained.
