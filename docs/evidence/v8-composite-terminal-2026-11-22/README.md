# Successful composite completion: retained qualification

Date: 22 November 2026. Implementation candidate:
`e32b412e86e8ececf2e025c8ccaffd23e1f17c53` in tracing-js-self.
Independent Python consumer:
`e9817ad637f57ba82e370770420f6f3ef877c7b3` in megatoken.

The implementation promoted with these logs is byte-for-byte the tested candidate
for the seven executable/test/type files. Documentation and evidence are additional.
The completed-disposition path is restricted to successful `track_complete`.

## Passed gates

| Gate | Exact run | Result |
| --- | --- | --- |
| Focused continuation/history | [44991390200](https://github.com/werg/tracing-js-self/actions/runs/44991390200) | 108 individual JUnit test cases; zero failure, skip or cancellation |
| Real Python/shared-runtime transport | [44991390261](https://github.com/werg/tracing-js-self/actions/runs/44991390261) | 77 individual paired cases; zero failure or skip |

The focused Node summary counts four suite containers as well; its 112 outer
entries must not be confused with the 108 individual JUnit cases.

The driver verifies the complete successful host/coordinator checkpoint before
close, the exact positive native close acknowledgement, and the full closed-session
checkpoint after close. The journal event must resolve the exact latest pending
coordinator selection and the chain cannot continue afterward. Restoration invokes
the real native restore operation on a fresh process and requires zero restored
active sessions, zero host dispatches, all original attempts consumed, and the
exact transport checkpoint digest. It returns a nonresumable disposition.

Controls exercise altered base/pending identity, unfinished or changed host
completion, changed tombstone/attempt evidence, lost native close acknowledgement,
lost terminal-history acknowledgement, and cancellation after journal reading
before native restore. All failed or uncertain persistence continues to fence
possibly executed work.

## Retained unsuccessful attempts

- [44990916377](https://github.com/werg/tracing-js-self/actions/runs/44990916377):
  focused 107 passed and one failure. The tampered base was correctly rejected,
  but the negative test expected a later error string.
- [44990916373](https://github.com/werg/tracing-js-self/actions/runs/44990916373):
  paired 75 passed and two failures: that assertion and an undefined cancellation
  helper in static terminal restore.
- [44991138793](https://github.com/werg/tracing-js-self/actions/runs/44991138793):
  focused 107 passed and one failure from the same missing local helper.
- [44991138794](https://github.com/werg/tracing-js-self/actions/runs/44991138794):
  paired 75 passed and two cases reaching that helper.

The final revision defines cancellation checking in the static restore scope and
adds a control for abort during asynchronous history reading. Prior cancellation
after the pending-fence acknowledgement is also preserved.

## Scope still open

The final lexical selector in native tests is an explicit deterministic fixture;
the checkpoint/replay service is real Python. These results do not measure learned
program success. `sourceValidated:false` and `defaultPromotion:false` remain.
Cancelled/failed/unknown terminal reconciliation, dynamic descendants, arbitrary
external side effects, external current-head discovery, distributed ownership and
successor takeover remain unqualified. Sole supervisor ownership and an independently
retained current history head are required.

Each *.log is the complete decoded hosted job log, including setup and cleanup.
No local test result is claimed.
