# Terminal authority, original-module runner and complete regression evidence

This supplement retains the original failures and the later successful gates.
Each measurement keeps its exact source identity. Counts from overlapping
selections are not additive. The complete 843-module campaign is separate and
was still running when this packet was assembled. No acceptance package,
complete-program recovery, learned-quality or default-cutover claim is made.

## Full producer and external-asset gates

- Frozen clean producer `76a06f88b744e121f0ce406bcc4a5496929f0da4` failed its
  complete suite: 2,434 passed, two failed, six skipped, 2,442 total. Both failures
  are required original-module namespace cases. The chained reference fixture
  was not reached; a separate invocation passed all eight fixture controls.
- Frozen clean producer `973400ff5085848d7b61fb7cbb711294ea29f32c` passed the
  complete suite: 2,459 passed, zero failed, six skipped, 2,465 total, in
  538.421751186 seconds. The chained reference fixture then passed all eight.
- The six asset-dependent cases were separately exercised in the complete
  tokenizer file (3/3) and coordinator file (13/13), with zero failures or skips.
  The tokenizer uses its historical policy-pinned consumer; the coordinator
  uses consumer `1ddcc6110d70703f6b08244d53ec461047677bec`. Exact identities,
  environment, commands and clean before/after checks are in the metadata.
  Four coordinator cases use disclosed engineering selections; the actual
  initialized-weight case retains a refused output and does not claim learned
  success. The original complete-suite skips remain unchanged.

## Terminal-history controls and original actual-model failure

The clean integrated six-file control run at local `37f6224` passed 89/89.
Independent probes then reproduced acceptance of three invalid, deliberately
rehashed terminal histories: omitted metrics, reduced inherited RPC cost and
changed original native output bytes. These probes check structural validation,
not authentication against a compromised external authority.

The correction committed as `2e209a1` rejects all three. The 93/93 rerun was on
the working tree of `37f6224` with the three-file patch subsequently committed
as `2e209a1`; it was not a clean run of published `33a98c8`. A later clean probe
on published `33a98c8` independently rejects all three cases. An accidental
probe of old isolated `a5d0665` is retained under its actual source identity.

The first actual-model terminal qualifier ran on clean local `3b1bb25` and
consumer `1ddcc61`. It accepted one original model record, persisted the
terminal-request marker, and received a response that passed the positive
schema/session/closed checks. Appending the final close disposition then failed
strict receipt-field validation. The actual consumer implementation emits
`reason`; this field was absent from the producer validator's allowed fields.
The initial qualifier retained the request, error stack and chain but did not
capture the raw close-response bytes. Follow-up `db8366a` adds that capture for
future runs. **No actual terminal scenario passed in this original run.**
The requested marker remained the independently trusted head. The exact model
output, attempts, source, manifest and failure are preserved without rewriting.

The earlier isolated agent control counts without standalone logs and its
stopped broader semantic run are not promoted to retained successful evidence.
Initial missing-TMPDIR setup failures are included separately.

## Namespace runner identities and limits

The final isolated runner controls measure committed `7df599b`: original runner
29/29, namespace diagnostic controls 2/2, owned-script controls 7/7, evaluated
modules 37/37. The integrated three-file selection measures local `d08c26c` and
passes 38/38. Their counts overlap. The before/first-after/intermediate logs lack
an independently recorded exact source identity and are retained only as
development attempts. Their bytes do not establish a clean pinned measurement.

The two Node 24 resolution SyntaxErrors for unchanged namespace/reexport inputs
remain explicit disagreements: source-only resolution and owned execution pass,
but `admitted:false` is retained. The two diagnostic test passes do not establish
native parity. Public/source/native namespace projection and host namespace
outputs remain refused. Source-scoped linker plumbing is not an unforgeable
source-authority token.

## Hosted consumer evidence

Consumer head `c9977b240a26c897299f07043a82cd5f26920f31`, tested PR merge
`effa466938e15012b3172dad556415e02c7fd608`, completed run `44940251289`:
Python 3.11 and 3.12 each passed 3,567 tests with 82 skips and 20 warnings, in
1,083.30 and 1,049.76 seconds respectively. Installed-package and CLI steps pass.
The optional hardware job remains skipped. All four workflows on this consumer
head completed successfully. The original 1dd Python 3.12 cancellation remains
incomplete and is retained in the consumer repository's
`docs/evidence/ci-complete-cpu-1ddcc61` at `c9977b2`.

## Separate-process ownership probe

The `ownership-probe/` sources, original output and metadata preserve two actual
OS processes sharing one POSIX action journal. The old owner pauses after its
claim; the successor explicitly asserts `not-dispatched`, retries, then the old
owner resumes. Both controlled adapters run with the same logical idempotency
key. This demonstrates missing enforcement if the caller's reconciliation does
not establish that the old owner can no longer act. Ordinary recovery does not
automatically authorize that retry. The checked imported lifecycle/action source
files at the probe's `7df599b` checkout are byte-identical to `973400f`.

A checkpoint/head check immediately before an adapter call still leaves a pause
window. A qualified ownership solution must enforce ownership and deduplication
atomically at the effect sink, or keep the physical outcome uncertain. This
probe is an open-work finding, not a distributed-ownership pass. Rotation and
compaction are also separate from the currently enforced whole-chain limits.

## Restore and inspect

Run from a producer checkout containing the committed inventory:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/terminal-runner-973400f-c9977b2/inventory.json \
  --out /absolute/path/to/new-evidence-directory
```

The verifier checks every compressed part, full archive and extracted member.
`metadata/results.json`, `metadata/log-summary.json` and `source/identities.json`
give the scoped outcomes and exact source trees. `source/exact-unpublished-sources.bundle`
preserves the local tested commits, including the initial qualifier. Fetch the
published branch first; `git bundle verify` reports its published prerequisites.
The raw test logs, actual failed-run tree, native engineering receipts, hosted
logs and command metadata remain independently inspectable.

Model/tokenizer assets were already retained in the repository's
`docs/evidence/semantic-v8-final47-pair-934a111-f25fa32` packet at `5eeddef47`.
The actual failed run retains their exact manifest and hashes. This supplement
does not duplicate weights or manufacture a new training result.
