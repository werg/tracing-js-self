# Exact child creation/bootstrap and complete-history recovery qualification

[GitHub run 45025448089](https://github.com/werg/tracing-js-self/actions/runs/45025448089)
and job 137217357931 completed successfully on 22 November 2026.

| Frozen input | Exact identity |
| --- | --- |
| Producer | `86b1ecc633cd2be324c4cac2cb990d409195a1f5` |
| Native consumer | `8cdec19dbac9af0ba7968ac3b1adb84e53ce0dbc` |
| Python | 3.12.14 |
| Torch | Locked 2.10.0+cpu |
| Runner | Ubuntu 24.04, with the actual Linux boot/time-namespace authority required |
| Leaf testcases | **72 passed; zero failures, errors or skips** |
| Node aggregate counter | 73, including one parent entry; not an additional leaf test |
| Test duration | 605.1024022 seconds for this hosted invocation, not a performance claim |

The complete original artifact ZIP and extracted JUnit report are committed
here, together with the full decoded job log and checksum manifest. Artifact
14755912709 is 3,262 bytes with SHA-256
`fbef5a9c4564bee3f6b5fa8fbc8be05da2571b910bc69be991e5aa2d9a8e33ce`.
This proof does not depend only on an expiring Actions artifact.

The suite covers original-byte native commit acknowledgement, separate child
bootstrap acknowledgement, reconstruction from the complete independently
acknowledged application history, repeated process loss, exact latest-head
refusal, missing outcomes, original clock/deadline preservation and accumulated
costs. Creation now has an acknowledged complete intermediate application cut
before initialization. Missing native outcomes never authorize another dispatch.

The production native adapter performs reconstruction. The test peer controls
the final lexical decoder bytes, so this is recovery engineering evidence,
not learned-model quality or production source admission. Optimizer updates: zero.

## Further hardening discovered after this frozen candidate

Comparison with an independently developed older branch exposed a stronger
predecessor obligation: the native bootstrap endpoint should independently read
the exact immediately preceding durable create request, check owner/model/
generation and ordinal, and require its committed poststate to equal the
bootstrap prestate. This candidate checks the complete bootstrap state and the
producer application history's predecessor/ordinal relation, but does not yet
perform that separate native-journal predecessor read. The strengthened check,
an explicit crash before the producer's bootstrap intent, and bootstrap-specific
deadline expiration require a new frozen qualification; this pass is not
retroactive evidence for those later changes.

Terminal session-close recovery is also a separate later candidate. Unknown
external effects, unsettled work, successor/distributed ownership, full language
coverage, production assets, learned quality and all 17 full acceptance packages
remain open. No default is changed by this qualification.
