# Native CI repair qualification — 2026-11-18

The repaired producer `1e2e6a0de8952c4349edbeef46ab70c4a06f8157` passed all 15 focused tests and a complete three-case native collection/release smoke against consumer `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`.

## Repairs

The original five-lane CI run reached the campaign writer and failed because metadata reference sharing changed the alias-sensitive candidate digest after JSON serialization. Guest values already use canonical graph IDs; the repair strictly copies the remaining metadata as structural JSON without dropping undefined fields or changing guest undefined, sparse holes, special numbers, BigInts, null prototypes, cycles or aliases.

Only privately verified immutable registry snapshots can reuse a converted tree. Every cached tree is deeply frozen, no more than four are retained per live registry, and repeated occurrences inside one stored session remain distinct. The V8 worker path keeps metadata references without copying the registry. The existing registry CAS format remains intact: the native smoke stored exactly one registry object. Redundant source/input/fixture references now use the same canonical encoded task, including host-result graphs.

`--allow-refusals` is an explicit complete-disposition collection mode. The default collector still exits unsuccessfully if any candidate fails its required gate, and `--require-native` still requires the pinned consumer. The real-source CI lane uses both flags so its retained refusals can reach release packaging, which independently requires actual admitted examples. Neither status nor candidate identities are relabelled.

Fatal coordinator errors now abort detached worker groups, await their close events, retain interrupted work as `cancelled`, and close the campaign in `finally`. Artifact uploads exclude temporary worker/native files while retaining durable candidate and proof objects. An injected write failure tests the actual shutdown order.

Native CI now explicitly checks out the durable event head, and retains a separate receipt for the trigger revision, event head, actual producer, consumer and workflow attempt. Other workflows retain their existing integration-merge checkout behavior.

## Measured results

The final focused group passed 15/15 tests with zero failures or skips. It includes actual CAS writes and read-only resume for all 473 default recipe fixtures: 25 engineering, 48 training-v4, 126 benchmark-v1, 210 real-source and 64 generated-v1. The registry uses the same project and composition holdout flags as CI.

The native smoke admitted `counter-0`, `counter-1` and `checkpoint-source-reread` using Linux reference isolation. Its frozen registry contains 508 source variants, 199 families and 135 independent components; the campaign retained a single 339,897-byte compressed registry object. Packaging freshly checked all three source/native proofs and prepared three examples with 906 generated tokens. This small engineering set has no held-out members and does not enable family token caps.

The complete release archive was built and verified twice: 46 files, 5,052,896 bytes, SHA-256 `b18302be17ef07eb2a344d41416868c36c33f1c419aa1287eb0c3d3feffc92d9`. Its full original corpus, private evidence, prepared data and fresh environment/source/native receipts are retained in the separate archive. The compact files here retain exact identities and outcomes.

The original failed workflow and artifacts remain preserved under `docs/receipts/final-integration-2026-11-18/native-aa7b-failure`. Successor workflow 44321402524 was still pending when this local receipt was recorded; this receipt does not claim that the five-recipe hosted matrix passed. No optimization or learned-success claim is made.
