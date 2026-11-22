# Exact hosted qualification of the Promise object-operation guard

[GitHub Actions run 45042386283](https://github.com/werg/tracing-js-self/actions/runs/45042386283)
completed successfully at producer
`132b1d10b4de69d766ebc7969c6d4f0a9ed9b668` and native
`03a9e33866207b5b0c4105297c6050dacadcf85f`.
Job `137269488438` and artifact `14762486496` are retained here in full.
The producer source fix is `95907736f46488662bc4f2bb5625abb9459d0f86`;
the following commit adds only the exact-pair workflow.

Independent parsing of the downloaded JUnit files found **104 native cases
and 167 producer cases, with zero failures, errors or skips**. The complete
new source packet contains 22 original programs: 17 precise refusals and five
eligible controls, whose 51 generated contexts were replayed by the actual
native consumer. The original 15-program adoption cohort still contains 65
restored cuts and 423 contexts; the separate shared-realm proof has two owners
and 19 contexts. These are distinct proof populations, not additive corpus
coverage or learned-quality results.

The earlier computed-key/alias/descriptor guard is a separate 24-program
cohort: 19 refusals, five eligible controls and 96 native contexts. The new
object-operation cohort must not be represented as the discovery of that
already-fixed descriptor defect. It adds correct direct/shared-compiler
refusals for unmodeled operations involving Promise object operands.

The canonical adoption packet and shared-realm packet are byte-identical to
the earlier successful lookup-profile hosted run `45041480241`. The earlier
mutation packet changes only four diagnostic fields for the existing
`aliased-setPrototypeOf` input: direct/source category and reason now identify
`unsupported.promise-source-object-operation` instead of the older
`unsupported.witness-projection` captured-cell failure. The exact four-field
comparison is in `earlier-mutation-packet-diff.json`. Both versions refused
the source; neither is silently replaced or called byte-identical.

The workflow regenerates and checks the canonical contract and its 23 source
examples. The contract digest remains
`fd1e64f60ad5b6bb9431db3cd34513a5bd34041cdf7e710a99c5df1205502bf4`, and
the interoperability digest remains
`b004c2bde15007278d0c26189560ac0362530585f8b7d49d5b1999525fcce975`.
No native product source, contract scope or shared fixture changes are part of
the object-operation guard.

`manifest.json` binds the exact revisions and trees, original ZIP, complete
job log, each unmodified artifact member, and the diagnostic comparison. The
downloaded ZIP has 409,594 bytes and SHA-256
`ddd47ab7fc83dfed64f0ba72b31db898bc00afd7967fb701afa4d5c6d91650d2`.
For files ending in `.gz.b64`, decode base64 and then decompress gzip. Both
decoded and stored hashes are retained; no success-only log excerpt replaces
the original run.

This run qualifies its exact pair. Later assertion reconciliation and the
combined recovery/release/Promise composition require their own final gate.
There are zero optimizer updates and no new data, module or learned-quality
admission claims.
