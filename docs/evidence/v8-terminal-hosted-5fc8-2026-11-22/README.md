# Original hosted terminal-close gate: one failure retained

[Run 45028606167](https://github.com/werg/tracing-js-self/actions/runs/45028606167)
executed producer `5fc8e9e690806d8fe2e6b2da9f0d820056ee7d55` and the exact native
revision in `native-revision.txt`. The original ZIP digest is independently
checked in `summary.json`. The complete job log, original ZIP, unmodified JUnit
reports, exact revisions and runtime record are retained here.

The native population passed **55 of 55 individual cases**, zero failures,
errors or skips. The producer population ran **95 leaf cases: 94 passed and one
failed**, zero errors or skips. The failed leaf was the existing same-owner
service cancellation reconciliation control. Its peer had a zero-argument
replacement for a fixture function that now receives the final action. This
crashed the native process, which surfaced in cleanup as an already-closed
transport. A direct local reproduction records the underlying TypeError in the
subsequent service-close evidence; the replacement must accept the new argument.

This is a failed gate, not a 95-case passing proof. The other 94 passes include
the original terminal completion/cancellation, known close, repeated loss,
unknown outcome, immutable history and acknowledgement-boundary controls.
The fixture correction and later causal-bootstrap/service-owned close changes
require their own exact combined hosted run. No result here qualifies those
later sources, unknown external effects, or learned selection quality. Fixture
output bytes are controlled inputs, not demonstrated learned model behavior.

The local composed bootstrap/close transport subsequently passed 18 cases with
zero failures/errors/skips. Those development controls use a different source
pair and are deliberately not merged into this hosted population.
