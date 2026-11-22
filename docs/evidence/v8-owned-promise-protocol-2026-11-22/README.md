# Owned-Promise return protocol checkpoint

The current isolated mechanism uses the existing shared FIFO job collection.
Completing an async function body that returns an already-owned Promise leaves
its execution Promise pending; explicit enqueue, subscription and settlement
records preserve the separate scheduling turns and causal ownership.

Six direct JavaScript protocol cases passed, zero failures/skips, in 334.306 ms.
Eleven independent Python semantic-state cases passed, zero failures/skips, in
0.19 s. Complete retained logs and hashes are supplied here. These are focused
mechanism tests, not original-source certification, actual learned model quality,
or a complete language feature qualification. Native executable source is
published at `138f8354b62cbc7747bea8d2e230ed1f341f640c`; `summary.json` retains the
original local executed source identities. The producer mechanism and tests in
this branch have the same bytes as the recorded producer checkpoint.

Review identified two concrete gaps after the first mechanism checkpoint. A
future settlement-job identity was checked for freshness but not reserved,
allowing unrelated queued work to claim it. It is now represented by a reserved
row in the common job collection. Ordinary reuse, another async return trying
the same identity, and a malformed subscription collide safely. Separately,
throwing an owned Promise is a rejection reason, not adoption; the restore check
now makes that distinction. Exact resolution metadata keys are checked on both
sides. Further restored-job metadata and original-source boundary review are
still in progress and remain required before promotion.

The initial four-JavaScript/ten-Python counts were observed and reported during
development, but those original local log files were overwritten by the next
run. No original raw output or pre-fix red execution is claimed here, and no
rerun is relabeled as the lost run. The six/eleven logs above were copied into
immutable, source-named files before further work. Populations overlap and are
not added together.

Original JavaScript/native source projection, exact queue ordering, checkpoint
cuts, normal rejection values and refusal of unsupported then-property changes
are being qualified separately. General thenables/getters, foreign Promise
ownership, arbitrary async callbacks and complete language composition remain
outside this mechanism checkpoint.
