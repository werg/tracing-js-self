# Independent retained-evidence completion audit

This audit checks the complete qualification evidence integrated at
`64239894b36607de1265b67c337f537f3fc9a163`. Its [report](report.json) records a
successful independent check of preserved bytes, receipt bindings, generated
token masks, and cost accounting. It performs **no fresh source or native
admission, tokenizer re-encoding, model inference, or training**.

The producing revisions remain producer
`012c9fe49a082319bf98ac0c571596da925741a4` and consumer
`39c4036564428e44cc89caf261f517d856482695`. The audit does not relabel those
executions as runs of the integration commit.

## Evidence checked

| Evidence | Independent integrity result |
| --- | --- |
| [Complete populations](../native-v8-012c9fe-all/README.md), introduced by `0ebbb1d3a3aeefee230bc70d591e472225534290` | Seven primary archives, 6,363 members, and all source/native receipt bindings for the separate 665-case expansion, 26-case interoperability, and 11-case gallery populations passed. All 8,651 physical prediction records passed byte, EOS, mask, and token-accounting checks. |
| Original orchestration provenance | All 2,122 members passed exact hash checks. The interrupted wrapper and its successful constituent stages retain their original dispositions. |
| [Independent dataset replication](../dataset-v8-012c9fe-independent/README.md), introduced by `2cebc6123c2d5c2b22795e0160f68899de6001d7` | All 115 archive members passed. The retained verifier checked 37 native receipt bindings, 1,021 complete examples, split isolation, causal prompt bytes, masks, and 33,850 generated tokens including EOS. |
| [Published dataset](../dataset-v8-012c9fe/README.md), introduced by `60fe332b7968c1c1f2fe696c642649bd301ad7c2` | All 100 archive members passed. All 87 core files—including dataset files and native transports/receipts—are byte-identical to the independent replication. This remains one 37-episode inventory. |
| Historical cost comparison | The 42 matched source/entry/input identities, every aggregate token total, all 703 pairing dispositions, and all eight individual flat-token regressions passed recomputation. |

The script verifies that the three evidence directory Git trees at their
introducing commits equal their trees at `6423989`. It binds the files actually
read to that revision's checksum manifests. It also checks equality of `src`,
`tools`, `contracts`, `fixtures`, `package.json`, and `package-lock.json` between
the measured producer and `6423989`. Exact Git object identities and the
verifier's own SHA-256 are retained in the report.

Population counts overlap and are not added into a unique-case total. These
checks establish preservation and consistency of the recorded qualification;
they do not independently repeat its semantic execution or tokenization.
Any separately retained live regression has its own execution identity and
scope and is not part of this report.

## Reproduce

With Python 3.12 and Git, from the repository root:

```sh
python coverage/language-expansion/completion-audit-6423989/verify.py \
  --output /path/to/audit-report.json
```

The output's parent directory must be writable. The script streams the large
population archives, temporarily extracts about 67 MB of dataset evidence
beside the output, invokes the retained dataset integrity checker, and removes
the temporary directory afterward. It needs the historical Git objects and
uses only the Python standard library; no network or model assets are required.
`--evidence-root` can select another copy of `coverage/language-expansion`, and
`--repository` can select the Git checkout that supplies the pinned objects.
With no arguments, it refreshes `report.json` beside the script.

## Separate fresh local producer regression

The [local regression receipt](local-regression.json) retains a new `npm test`
run: **1,838 passed, six explicit skips, zero failures or cancellations out of
1,844 tests**, followed by all eight reference fixture checks passing. All five
`npm run contracts:check` generators also passed. The original logs are retained
losslessly as `producer-npm-test.log.gz` and `producer-contracts.log.gz`; the
receipt records both compressed and original byte hashes.

The test command began at `ff0aa417` and completed after concurrent integration
of `6423989`. Source, tools, fixtures, contracts, tests, package files and workflow
Git objects are identical between those revisions. Documentation and evidence
changed during execution, so this is explicitly **not a clean final-commit run**.
The six skips are the external tokenizer/consumer test and five optional native
coordinator tests without their configured assets. Their separate retained
native evidence does not convert these skips into passes. The final hosted
checks in the PR retain their own checkout identities and results.
