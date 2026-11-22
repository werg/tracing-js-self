# Terminal close: local controls and pending frozen gate

These are incremental engineering controls for a terminal-only durable close.
They do not qualify unknown remote outcomes, service ownership transfer, learned
execution, or the complete application-history/clock path. All 17 full work
packages remain open, and V6 remains the production default.

## Local results

| Retained report | Result and scope |
| --- | --- |
| `builder-initial.xml` | Initial three-case run: two failures exposed inconsistent absent service-policy normalization. Retained before correction. |
| `builder-corrected.xml`, `builder-final.xml` | Three builder cases passed in each corrected run. These repeated results are not six different tests. |
| `existing-history.xml` | 24 coordinator/checkpoint/history controls passed before the final cancellation and dispatch-boundary extension. |
| `transport-initial.xml` | Five real Python transport cases passed: normal/lost/altered close replies, repeated reconstruction, unknown outcome and nonterminal refusal. |
| `transport-dispatch-boundaries.xml` | Two added real Python cases passed: changed saved request boundary and changed saved precheckpoint both refuse before another close dispatch. |
| `unconfigured-transport-probe.xml` | Five explicit skips from an unconfigured exploratory invocation. This is retained as a nonqualification attempt, never a passing result. |
| `native-close-initial.xml` and `.log` | Seven native close controls passed on implementation candidate `6cbad1d`. |
| `native-close-focused.xml` and `.log` | Nine native close controls passed in 53.86 seconds at local test commit `f324851`. The two additions check pending sibling work before admission and later sibling mutation superseding a known close. The current published equivalent is `1507ac2`. This suite overlaps the seven-case run. |

The producer local runs exercised evolving working candidates; they are not
represented as clean-checkout qualification. The final implementation comparison
anchor is producer `2ed7fc4`. The exact raw XML counts, including failures and
skips, are machine-readable in `files.json`. The local environment used Node
24.22.3, Python 3.12.14, pytest 8.4.2 and Torch 2.10.0+cpu. It cannot supply the
Linux time namespace identity required by the live-history acceptance gate.

## Frozen hosted gate

[Run 45028606167](https://github.com/werg/tracing-js-self/actions/runs/45028606167)
was launched on producer `5fc8e9e690806d8fe2e6b2da9f0d820056ee7d55` and native
`1507ac24653158c68c91b314aefe83046f81ba31`. It requires the actual kernel time
namespace, all 55 selected native recovery cases and all 95 selected producer
leaf cases with zero failures, errors or skips. The 95 include the earlier
72-case manifest, four coordinator cases, three close-builder cases, seven
close-transport cases and nine complete terminal-history cases. These counts
are overlapping test manifests, not source or language coverage populations.

The gate covers normal completed close, lost/altered replies, repeated process
loss with preserved attempts/cost/elapsed time, an unknown native outcome, a
history intent without its producer request, a lost new-head acknowledgement,
a close racing the acknowledgement, and fully settled cancellation. At the
creation of this evidence increment the run was queued; no hosted pass is
claimed here. Its final result and complete raw evidence must be retained
separately under the exact frozen pair.

## Lessons and remaining authority

A terminal history acknowledgement precedes the native close, but code can run
while that acknowledgement awaits. The close dispatch therefore atomically
checks both the saved next request boundary and the complete precheckpoint.
This prevents a later driver call from quietly admitting a second close after
a racing first close.

A known close reconstructs only the exact archived session and preserves every
live sibling, original model attempt, resource count and terminal outcome. It
returns a nonresumable disposition and cannot authorize host redispatch. An
unknown native result and a newer durable history head remain refusals. The
service-backed path and the independent bootstrap create-predecessor
strengthening remain separate work; this close qualification does not imply
either has passed.
