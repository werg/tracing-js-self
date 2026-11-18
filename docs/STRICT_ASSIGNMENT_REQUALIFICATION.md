# Strict assignment repair and historical requalification

The strict getter-only assignment repair is the A1 boundary in
[the execution-training roadmap](EXECUTION_TRAINING_ROADMAP.md). An own or
inherited getter-only property rejects `[[Set]]`; a strict assignment must
throw before yielding an expression result to an enclosing binding. The old
teacher could complete that assignment normally and then overwrite the wrong
intermediate value, allowing final-outcome comparison to miss the error.

## What changed

The compiler records strictness on each lexical code body. An exact directive
prologue enables strictness, nested functions and arrows inherit it, and a
strict caller does not change a sloppy callee's mode. The runtime converts a
missing setter into a guest `TypeError` in strict code. Sloppy assignments
retain silent failure. Successful and throwing setters retain their owned
continuations; catch and finally receive the actual abrupt completion.

The regressions cover the two original examples, inherited accessors, setter
results, finally overrides, once-only operand evaluation, strictness scope,
and explicit refusal of unsupported data descriptors. The overwritten case
must emit `answer` bindings `0 → 7 → 0`, never `0 → 2 → 0`.

## Inventory historical candidates without relabeling them

Run the narrow read-only inventory on a materialized episode, a JSON array of
episodes, an owned archive, or a complete durable campaign:

```sh
node tools/audit-affected-assignments.mjs --input EPISODE.json --out NEW_AUDIT.json
node tools/audit-affected-assignments.mjs --input CAMPAIGN_DIR --out NEW_AUDIT.json
```

For a campaign whose storage format needs its original reader, select an
exact, clean historical checkout explicitly:

```sh
node tools/audit-affected-assignments.mjs --input CAMPAIGN_DIR \
  --tracer-root EXACT_PRODUCING_CHECKOUT --out NEW_AUDIT.json
```

The report binds source/archive digests and historical producer identities.
It checks the original structural evidence and inspects every recorded
property-write pre-state, including prototype descriptors and evaluated
assignment operands. It derives strictness from the source bytes rather than
trusting the old compiler's flags. Neither getters nor guest source execute
during the inventory. A later descriptor replacement or equal final value
does not hide an earlier affected write.

The campaign denominator includes all attempts and distinct candidates;
every positive attempt is retained separately, including retries. Missing
private archives and incomplete/invalid evidence remain explicit quarantine
items. An empty affected list is not a claim about rows that were unavailable.

| Status | Meaning | Required action |
| --- | --- | --- |
| `affected_path_observed` | A strict getter-only write was executed, whether it threw or completed normally in that archive | Regenerate and independently requalify the original case under the repaired producer; otherwise exclude it from a new dataset |
| `incomplete_audit` | An executed write exceeds the scanner's ordinary-property boundary | Keep it quarantined until its evidence can be assessed |
| `not_audited` | Private evidence is absent or structurally invalid | Obtain the original evidence or exclude the row; do not count it as clean |
| `no_affected_path_observed` | The supplied execution contains no affected write within the declared audit boundary | No exclusion from this narrow defect inventory; this is not general semantic certification |

`suspectedSilentFailure` records that an affected strict write completed
without a throw. It is a susceptibility finding in the historical journal,
not a claim that a particular previously released native dataset was proven
contaminated. The inventory never issues a native-admission receipt.

## Preserve producer identities

The compiler's new `strict` field changes compiled archive bytes, including
programs whose visible result is unchanged. Old bundles are still historical
evidence for their original producer. Exact replay with the repaired compiler
can reject those bundles at the compiled-bytecode comparison. Do not strip
fields, rewrite old journals, copy old native receipts, or relabel the old
producer revision to make replay pass.

Regenerate from original source, canonical inputs and schedules under a clean
repaired revision, retain lineage and frozen split identities, and rerun
independent intermediate/source checks and the applicable native consumer.
Store the new result beside the original with a new producer identity. The
affected inventory supplies the requalification list; it does not replace
those gates. A complete historical census requires the original campaign
archives, which are distinct from the small receipts committed in this repo.
