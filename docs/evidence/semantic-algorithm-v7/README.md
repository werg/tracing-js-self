# Algorithm trace refactor: evidence

The [measured comparison](paired-e96dd4e/MEASUREMENTS.md) covers all eleven
unchanged gallery cases, 87 equivalence-family executions, and 28 negative
checks. It was produced from clean revision
`e96dd4e51d7977554f05dc1794272d5145c69663` with the actual pinned tokenizer.
The producer did not change during measurement.

- **98 cost cases:** 93 normalized, five independently checked v6 detailed
  fallbacks, zero failures.
- **Equivalence:** 87/87 executions converge in 19/19 input groups.
- **Negatives:** 28/28 pass, with zero observed false merges or unsafe admissions.
  Twenty-six are recognition refusals; two are independently executed pairs.
- **Unchanged gallery targets:** 1,307 → 1,154 tokens (−11.7%), including all
  fallbacks and three explicit-expression increases.
- **Actual JavaScript contexts:** 93/98 cases, 187 prediction boundaries.
  Native framing, cache/retrieval, and paired native serving costs are unavailable.

See the [raw comparison](paired-e96dd4e/comparison.json),
[generated ledger](paired-e96dd4e/comparison.md), and
[verification receipts](verification/README.md). Qualification covers the
bounded JavaScript engineering checks and exact token metering. Native v7
admission, comprehension, learning, and production promotion remain open.

## Original frozen baseline

`baseline-v6.json` was regenerated from the eleven unchanged gallery fixtures
at revision `8d11f38619b8443c988f79b177908649338b3897`, before changing the
producer. It contains exact source, input graphs, generated target strings,
observations, and independent source-check dispositions.

The frozen run has 11 cases, 107 generated records, and 3,861 generated UTF-8
bytes. These are byte measurements, not token estimates. Token counts are
explicitly unavailable in the original freeze because the pinned native
tokenizer was not supplied. The later paired run linked above supplied the
exact tokenizer and freshly reproduced the original 1,307-token gallery total.
Earlier pinned-tokenizer measurements remain unchanged in
`../semantic-target-gallery-v2/`.

This baseline does not grant native admission or demonstrate model learning.
Paired reports must retain all eleven cases, including detailed fallbacks and
refusals, and distinguish generated, observed, framing, and repeated serving
context costs. Historical artifacts keep their original version identities.
