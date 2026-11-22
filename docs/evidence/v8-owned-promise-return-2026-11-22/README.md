# Owned async Promise return source proof

This package records the bounded owned-Promise return source profile and its independent native replay. The source suite passed 22/22 checks on Node v24.22.3. It generated 12 source cases, and the independent native consumer validated all 12 cases across 309 contexts. The native receipts contain 193 detailed records, 112 protocol records, 4 region records, and no algorithm records. The source harness restored 47 retained async checkpoints. These are execution and interoperability controls only: admission is false, training admission is false, and optimizer updates are zero.

The complete per-case source artifacts and native receipts are in [nested-async-source-evidence.json.gz](nested-async-source-evidence.json.gz) (lossless gzip; the original filename, length and SHA-256 are retained in `compressed-evidence-inventory.json`). Exact source hashes, per-case context counts, restored cuts, run hashes, protocol controls, and contract digests are in [source-evidence-summary.json](source-evidence-summary.json). The raw full-suite output is [source-suite-22-of-22.log](source-suite-22-of-22.log).

Original JavaScript produced `qa` for the `Promise.resolve(1)` return with a competing reaction and `dqa` for an already-owned target Promise with two target reactions. Each trace contains the three explicit resolution records in order: enqueue, subscribe, settle. The original Node results and refusal messages for mutation controls are in [original-node-dispositions.jsonl](original-node-dispositions.jsonl); the original `dqa` source run is retained separately in [original-owned-fifo-dqa.log](original-owned-fifo-dqa.log).

The literal-key controls in this recorded cohort refuse own `then` overrides and accessors, `Promise.prototype.then` changes, `Promise.resolve` changes or shadowing, arbitrary thenables, async Promise callbacks, and external targets. Ordinary async functions with unrelated object writes and nested numeric returns remain source-eligible. The explicit producer and native reservation controls are retained in [protocol-js-6-of-6.log](protocol-js-6-of-6.log), [native-async-11-of-11.log](native-async-11-of-11.log), [reserved-identity-js-6-of-6.log](reserved-identity-js-6-of-6.log), and [reserved-identity-native-11-of-11.log](reserved-identity-native-11-of-11.log).

The producer and native contract files are byte-identical at digest `f8546a803d7b6e1faa696e92d6e4df3e48de34d40475dce7c166a1587a9eb472`. The fixture digest remains `56f7f36d3b25b3b11a208be3de337e637b9782e6759faea1e1ec107b0a90f0ce`; the interoperability digest remains `f5c2d5fd15ad3b84e9b17de771d2f72a58f3c7dee4969ded8a7eb9c3c449f661`. Older evidence directories retain their original contract pins.

## Earlier attempts

The `historical` folder preserves three raw observations that explain the final checks:

- The 19/20 run expected a plain `Promise.resolve(1)` async return to be rejected. That assertion became obsolete once the bounded exact-owned-Promise path was source-qualified.
- The first shadow test harness called the saved `Promise.resolve` function without its constructor receiver. Node returned `PromiseResolve called on non-object`; the harness was corrected to use `.call(Promise, ...)`.
- An early accessor attempt showed a real source projection gap: the runtime mishandled an own `then` accessor and the compiler accepted the resulting trace. The recorded source guard rejects that literal-key async Promise return before qualification; the subsequent computed-key counterexample below shows that this did not prove general safety.

## Subsequent independent counterexample — promotion blocked

After this frozen 22-case run, independent review demonstrated a computed-key bypass on the same executed source: `const thenKey = "then"; Object.defineProperty(p, thenKey, ...)` produces `gt2` in original Node, but the producer accepts a guest `TypeError` before resolution. This cohort remains valid only for its recorded cases; it does not establish source-guard completeness. Unknown keys, mutator aliases and indirect ownership need correction and fresh qualification. The separate general shared-resolution candidate is not covered by this run.

## Published source mapping

The executed local producer revision is `53b478b76071d0fdc3d5e5dd21de1f7dd2d4c502`; its implementation, tests and contract are preserved at published `7fe5a9d57fbf456f0165534f089116b4b5db7279`. Publication adds the exact native policy, documentation and unrelated production-route audit tools. The executed local native is `c192da5cd55f7a6380a89d497142441df456c04d`; published `859f7763c63afee48f40ec78bd280b0811bd9046` differs only in retained recovery documentation. The run is not relabeled as execution of those later publication commits.
