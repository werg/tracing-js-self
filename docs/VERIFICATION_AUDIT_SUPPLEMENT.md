# Verification and recovery audit supplement — 2026-11-18

The completed audit supplement preserves raw verification evidence and failure/recovery history alongside the separately delivered datasets and models. It is **audit evidence, not a prepared training dataset**. Inputs retain their original dispositions and producer/consumer pins. Packaging performed no new source generation, native admission, model inference or optimization.

The compact machine-readable receipt is [verification-audit-supplement-2026-11-18.json](evidence/semantic-v5/verification-audit-supplement-2026-11-18.json). The archive's own `release-manifest.json` contains every selected file's byte count and SHA-256, the audit-only schema, completed-run references and explicit exclusions.

## Verified artifact

| Property | Exact result |
| --- | --- |
| Archive | `deliverables/final-audit-supplement/semantic-audit-supplement.tar.gz` |
| Compressed bytes | **67,052,493** |
| Archive SHA-256 | `fab00bb4ec0a30bc8dbf086ac1705d5def9611523516462a5b2ad2ee594170e5` |
| Audit identity | `44576af1d9a8e78baf71cbf1eabfe3778fbaf6571c3d11006034dad6492101ea` |
| Original evidence selected | **821 files / 299,161,679 bytes** |
| Inventoried files with three audit metadata files | **824 files / 299,412,055 bytes** |
| Total regular archive members | **825**, including `release-manifest.json` |
| Release-manifest SHA-256 | `c04840dd52b640ca0ed37458cb4dc3beba95fb42623707002078cc88198578fc` |
| Final source-selection SHA-256 | `c878dad43d89958eddd1f5c6691bc7d10fc9d1c65f1e88d38f8a57337938ac47` |
| Declared archive budget | 512 MiB; the verified artifact is below this limit |
| Archive write and full member verification | 11.151367 seconds |
| Writer/verifier child peak RSS | 21,225,472 bytes |

The archive is complete, stable and durably saved; the parent delivery agent confirmed successful upload and finalization. This repository receipt deliberately contains no delivery-service file IDs or transport metadata. Delivery did not alter the archive's content or identity.

## Included source inventory

These categories count the 821 original evidence files; the additional archive metadata is separate.

| Evidence category | Files | Original bytes |
| --- | ---: | ---: |
| D failures, recovery, selection and native-subset evidence | 120 | 55,133,550 |
| E original failed batch and corrected-selection proof | 73 | 84,026,748 |
| F original campaign, timeouts, retries and regressions | 357 | 60,764,750 |
| G historical failed qualification | 8 | 216,275 |
| H frozen qualification, native inputs and initialized coordinator | 160 | 61,642,187 |
| Separate later CI routing diagnostic | 67 | 32,154,716 |
| Merge and historical-reader reviews | 16 | 833,823 |
| Focused regressions and native/model cost evidence | 11 | 4,112,147 |
| Audit tooling, inventories and independent review | 9 | 277,483 |

D evidence includes original baseline failures and recovery, the unsafe-number canonical diagnosis, capture and Number-conversion reproductions, failed verifier routing, exact native alias-equivalence proof, final token sampler, and the native subset's negative/reader/derive/package receipts. Its original completed large source/prepared payloads remain in the already delivered D archives.

The complete original rejected E all-12 batch is retained because it directly demonstrates why candidate admission and batch preparation have different failure modes. Its successful representative-selection proof remains a separate outcome. F retains its complete compact campaign, original timeout state, retries, reviewed recovery and exact native alias checks. The full epoch's context-cost JSON and focused parameter TDZ, closure, propagation and asynchronous-helper logs are also included.

## Qualification outcomes remain separate

**G remains a failed historical qualification.** Its 870-test invocation recorded 864 passes, one stale-assertion failure and five skips. The reference fixture and native capability sweep were not launched after that failure. Its raw unit/process logs and the intermediate published CI failure are preserved; later success does not replace those records.

**H is frozen at producer `881664b98ec9d484f9f4775d0b40a3a2b1b81174` and consumer `6b4382b9af3bef120ca3a95ae24d35154d4cd66b`.** Its full unit invocation recorded 932 passes, zero failures and five conditional skips out of 937 tests, followed by eight passing reference-fixture checks. Two actual Linux namespace-confinement cases passed. The finite capability ladder used its declared trusted-process reference mode and obtained 40 actual native admissions across 49 probes. Eight unsupported probes and one callback-abrupt reference refusal remain explicit; feature-level model evaluation remains untested for all 49.

All 120 retained H capability inputs, complete parsed receipt values and admitted private exports match their retention hashes. The later H orchestration follow-up separately ran the five previously skipped external-coordinator tests: all five passed, and their raw RPC evidence passed independent native validation. The archive includes the initialized checkpoint and served model needed to authenticate those checks. Weights remained unchanged, optimizer steps were zero, and the controlled cases and actual initialized-model refusal are distinguished. These results establish orchestration/accounting behavior, not learned execution.

The broad H Python regression run recorded 141 passes and six optional artifact-dependent skips. H then ran all 14 actual-artifact integrity tests using the original C checkpoint and original `277edd4` consumer with the H validator implementation. Those tests performed no model inference or optimization and did not rewrite the original experiment.

**The later CI routing diagnostic has its own pins and scope.** Producer `d15ddca47854ebdb92b23598dd720ccd1a18c822` and consumer `6b4382b9af3bef120ca3a95ae24d35154d4cd66b` admitted two registered real-source aliases individually. Direct native batch preparation admitted one and rejected the other for immutable episode-ID reuse. Exact-public selection reduced the pair to one unchanged representative, which passed normal native preparation. The original audit remained associated, and the unchanged 20%/10,000-token policy correctly rejected this one-component corpus; a deliberately undersized token cap also refused. The independent read-only scan found no identical source/input groups among the default 210 candidates. The diagnostic does not establish that the default lane failed, does not claim a full default native run, and does not claim remote CI success or a balanced training release.

The legacy-reader review is similarly bounded: 60 unchanged F native bindings and seven focused tests were verified using the exact producing format on a copied snapshot. No new native admission or model inference occurred. The copied CAS duplicate is excluded; original F campaign evidence and the five compatibility-review files are distinct.

## Verification and reproducibility

The wrapper uses the immutable H `package-semantic-release.py` helper, bound to SHA-256 `41df333a46012801ea114432f466fb320ca29ad62c8d5c03ae8798950c059ead`. The archive includes both that helper and the wrapper. All selected sources were hashed before writing; the writer detected byte changes during streaming and atomically published the archive; the verifier then read and checked every member, inventory name and audit identity without extracting it.

Seven synthetic/refusal checks against the merged helper passed. They cover byte-identical archives across separate output directories, changed-source refusal before output creation, pending-qualification refusal, and blocked private-transport, dependency, nested-archive and traversal inputs. All 583 pre-H evidence files and all 750 files in the H-complete staging snapshot remained unchanged. The 120 H capability files, 15 initialized/coordinator payloads and 66 indexed CI diagnostic files were checked against their original inventories. A separate agent reviewed scope, mandatory references and exclusions; its reviewed snapshot and README remain in the bundle.

After extracting the archive to `audit-source`, the same bytes can be rebuilt with the included files:

```sh
python audit-source/audit/package-audit-supplement.py \
  --workspace audit-source \
  --selection audit-source/audit/selection.json \
  --notes audit-source/audit/README.md \
  --packager audit-source/tracing-release-H/tools/package-semantic-release.py \
  --out rebuilt-audit
```

The writer normalizes tar/gzip metadata, so unchanged inputs reproduce the same archive bytes. The final immutable inventory and checksums, rather than discovery of a mutable directory, determine what is included.

Completed dataset/model archives, duplicate large prepared corpora, dependency installations, temporary caches, mutable worktrees and private upload metadata are excluded. The historical failed E preparation and the tiny CI diagnostic are intentional evidence exceptions to omitting redundant prepared payloads. Imported historical repository receipts do not imply that another conversation's binary archives were available or saved here. A later remote CI snapshot, if produced, remains a distinct receipt outside this archive cutoff.
