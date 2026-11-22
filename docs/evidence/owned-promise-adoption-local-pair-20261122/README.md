# Owned Promise adoption: exact native local qualification

The local checks in this bundle use the detached, published native revision
`03a9e33866207b5b0c4105297c6050dacadcf85f`, exact tree
`0531e702beb88c5421907d6c41d078169ccd00b5`. Producer implementation and
canonical fixture bytes are unchanged from
`c20b70e23565bd413394a7193bf596b10bf244ab`; the containing follow-up adds
explicit public/native controls, one original-source validation family, the
matching native policy pin, corrected count metadata, and the mandatory hosted
workflow. This is local evidence; hosted qualification is still pending.

| Retained run | Passed | Failed / skipped | Exact scope |
| --- | ---: | --- | --- |
| Eight native Promise/protocol/host files | 104 leaves, plus 84 subtests | 0 / 0 | Exact detached native revision; local pytest 9.2 reports subtests separately |
| Full producer union before the final source addition | 118 | 0 / 0 | Public, iterator, join, executor, async, shared source, 14 original adoption sources, and actual native shared-realm replay |
| Source cohort after the final source addition | 21 | 0 / 0 | 15 independently checked original sources, 65 JSON cuts, 423 generated contexts, all actually replayed and restored by native |

The hosted workflow requires **104 native testcase elements and 119 producer
testcase elements**, with no failures, errors, or skips. It uses locked pytest
8.4.2; its reporting of successful unittest subtests need not match the local
pytest 9.2 report. No successful subtest is added to the leaf denominator.

The actual source/native check passes the full generated artifacts to the
independent `validate_v8_artifact` consumer and requires replay, contexts, and
continuation checks. The consumer compares every model-visible context with
its independently replayed state and, on the roundtrip path, restores the
native checkpoint before the next generated record. A second uninterrupted
replay must agree. The producer also independently recompiles each original
source and checks all source-selected JSON continuation cuts.

## Distinct FIFO source cases

`promise-adoption:source-fifo-microtask` has 46 contexts and independently
returns `dqa`. An executor adopts an owned Promise; an adopter reaction, direct
target reaction, explicit microtask, and later awaiting caller compete in the
same queue. The target is already fulfilled when the assimilation job
subscribes forwarding.

`promise-adoption:pending-forwarding-before-microtask-settlement` also has 46
contexts and independently returns `qda`. It moves target settlement into the
explicit microtask. The assimilation job therefore registers forwarding while
the target is still pending. At public sequence 27, `forward2` waits on `p2`
and the only ready item is `microtask3`. At sequence 31, target settlement
readies `[reaction2, forward2]` in registration order. Forwarding later readies
the adopter reaction before the awaiting continuation. The source test asserts
these semantic roles without relying on their chosen witness names.

This additional family closes the waiting-subscription/mixed-queue assertion
identified in the earlier async-only native proposal. It adds one validation
case, while the canonical interoperability fixture population stays 23 and
the production training population stays unchanged. Exact original source
bytes, artifacts, native receipts, and per-family context counts are retained
in the compressed source-evidence JSON and its manifest.

## Retained realm control and boundaries

The public shared-realm control has two invocation controllers and 19 generated
contexts. Both owners initialize their protocol state, and a queued job from
the second owner must run before adoption forwarding from the first. The
control restores both controllers through JSON and compares both exact final
states against native replay. It is a public-machine control and is not counted
among the 15 independently compiled original-source families.

Definition `fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`
and interoperability `b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`
remain fixed. Callable thenables, modified `then` lookup, unsupported Promise
subclasses/proxies, broad Error reflection, and cross-invocation executor
resolver capabilities remain outside this qualification. Module admission,
training admission, and optimizer updates in these artifacts are zero. No
production denominator or resource cap changed.
