# Published capture grammar consumer review — 2026-11-18

The bounded consumer review passed against published `werg/megatoken` commit `6e27a7c6529aa0778c5ea818432461db7cd05ea7` (tree `9c0a5e5a61e8b79d3fd03f461a84abec49ea72e8`). This is preparation for a separately published producer and its fresh native qualification; it does not change the identities of earlier release evidence.

## Actual checks

| Check | Observed result |
| --- | --- |
| Capture-binding, capture-name, harness-v5, contract-v5 and input-graph immutability tests | 81 passed, zero failures or skips; 9.06 seconds process wall time |
| Focused DiLoCo finish, stale, quorum, install and lease tests | 8 passed, 13 deselected; 20.22 seconds process wall time |
| New copied environment | 47 packages match the existing lock; exact production tokenizer bytes and ByteCodec identity verified |
| Copy isolation | 24,925 regular files in each environment; zero shared regular-file inodes |
| Earlier environment | Still imports clean consumer `6b4382b9af3bef120ca3a95ae24d35154d4cd66b` from its original checkout |
| Read-only historical capture inventory | 106 exports; 414 capture relations; 111 unique names; zero observed incompatible occurrences |

The semantic tests include the upstream source-certified VS Code `distinct` capture fixture with the actual production tokenizer. The upstream unit test passes a synthetic consumer revision argument; it is a native contract test, not a release admission receipt bound to a newly published producer.

## Exact scope and remaining qualification

Producer commit `53180e0b0dfbf6c9544b680f854a442db53bb0ab` requires capture aliases to satisfy its existing source-identifier predicate, matching the check already applied to captured cells. Consumer PR32 applies the existing dollar-normalized Python `str.isidentifier()` predicate to both fields and retains the source fixture and regression tests. Neither change alters the v5 format version or tokenizer.

The earliest published capture fix, PR head and merged consumer all include the intervening DiLoCo changes. Selecting an earlier PR commit would not remove that ancestry. The merged revision preserves upstream history, and the focused DiLoCo tests cover its changed unit behavior. No distributed-training run, convergence, production bootstrap qualification or model learning result is claimed.

The two identifier predicates are still not fully equivalent. ECMAScript permits U+200C and U+200D continuation characters that Python `isidentifier()` refuses. Four explicit counterexamples are retained in the raw inventory. None occurs in the 106 scanned exports. This remains a fail-closed profile limitation. The scan did not execute source code or rerun historical native admissions.

Only `contracts/native-admission-policy-v5.json` and `.github/workflows/megatoken-consumer.yml` require current executable consumer-pin changes. Historical H/E/F coverage, receipts, archived source and consumer pins remain unchanged. A new producer revision must receive its own official environment check and fresh finite native capability ladder.

## Evidence

`qualification.json` and `environment-preflight.json` are compact copies of the completed review. The environment receipt intentionally uses a preflight schema: the producer policy still pinned consumer `6b4382b...` during this review. It does not bypass or impersonate the official policy-bound environment checker.

The complete raw folder is `release-evidence-capture-grammar-2026-11-18`. Its `file-index.json` authenticates 12 completed evidence files totaling 144,475 bytes, including raw pytest/JUnit logs, reproducible runners, upstream delta review, and the 106-export capture inventory. The file index itself is an additional artifact. Temporary pytest directories and dependency environments are excluded from the audit archive.

Qualification SHA-256: `aec8079910d8042192e7a34d3cee23ae828efd7af6e65b114deacfdec3aafd61`.

File-index SHA-256: `fc6ece9e91f87b4e5ea42a9e5fb3d01fb7507837de1c81a7f7d55ea05d976d5c`.

Primary upstream references: [producer commit](https://github.com/werg/tracing-js-self/commit/53180e0b0dfbf6c9544b680f854a442db53bb0ab), [consumer PR32](https://github.com/werg/megatoken/pull/32), and [published consumer commit](https://github.com/werg/megatoken/commit/6e27a7c6529aa0778c5ea818432461db7cd05ea7).
