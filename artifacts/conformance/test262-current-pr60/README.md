# Current Test262 observation for PR #60

This is a retained observation of the complete Test262 source inventory and a
deliberately bounded original-source execution. It does not set the population
for future campaigns. The normal acquisition tools continue to use the selected
checkout's actual Git tree, and the current inventory workflow follows upstream.

## Inputs and observed outcomes

- Producer: `5f321f0c634773bbccdb12b9ab6d18f69954f1ef`.
- Test262: `2a1ade303f72d3de80565c921d685222405c32ce`.
- Runtime: Node `v24.22.3`, V8 `13.6.233.17-node.63`.
- Acquired inventory: 54,159 files under `test/` and `harness/`: 53,801 tests,
  294 fixtures, 43 harness files and 21 resources.
- Required variant population: 103,360; unresolved metadata: 0; missing harness
  files: 0. This is an acquisition result, not an all-suite parse or execution.
- Executed selection: 20 original files, all 40 required strict/sloppy variants,
  and 120 retained attempts across the three requested stages. The other 103,320
  variants retain `not_selected` dispositions.

| Selected stage | Passed | Unsupported | Failed | Resource limited | Infrastructure error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Parse/static | 40 | 0 | 0 | 0 | 0 |
| Owned execution | 30 | 10 | 0 | 0 | 0 |
| Independent reference execution | 40 | 0 | 0 | 0 | 0 |

`selected-paths.txt` lists the exact original files. The selection exercises
iterator `next` lookup, normal and abrupt `return` lookup/closing, async-from-sync
continuation, and Promise tick/constructor-lookup observations. Original source
and harness bodies were preserved.

The run used two workers, a 60,000 ms worker wall budget, a 384 MiB worker heap,
20,000 owned steps, 1,048,576 source bytes and a 300 ms reference VM timeout.
The source, profile, implementation, environment, selection and budgets were
unchanged for completed resume. Resume retained 120 attempts and reproduced the
same complete compressed report bytes. `observation.json` records the hashes,
full population counts, exact policy and successful report integrity check.

Reference execution records ordinary Node/V8 diagnostic results. Source
correspondence and native trace validation remain unrun or blocked, as do trace
checkpoint restoration/admission/export/training/serving/usefulness ledger stages. The
observation's corresponding qualification claims remain false.

## The ten unsupported variants

The five sources below each have strict and sloppy variants. Diagnostic replay
recorded the first refused machine instruction in the unchanged original source
or harness; `unsupported-diagnostics.json` retains those locations and values.
These cases stop before the intended iteration observations.

| Original source under `test/language/statements/for-await-of/` | First unsupported operation |
| --- | --- |
| `async-from-sync-iterator-continuation-abrupt-completion-get-constructor.js` | Defining the Promise instance's `constructor` property requires owned Promise property storage. |
| `iterator-close-non-throw-get-method-is-null.js` | Original `asyncHelpers.js` reads `Object.prototype.hasOwnProperty`; both iteration and return-getter counters are still zero. |
| `ticks-with-async-iter-resolved-promise-and-constructor-lookup-two.js` | Reading `Promise.prototype` while setting up the constructor getter. |
| `ticks-with-async-iter-resolved-promise-and-constructor-lookup.js` | Reading `Promise.prototype` while setting up the constructor getter. |
| `ticks-with-sync-iter-resolved-promise-and-constructor-lookup.js` | Reading `Promise.prototype` while setting up the constructor getter. |

The Promise instance case exposed an error-classification defect during the
earlier observation: unsupported Promise storage generated a guest TypeError.
That could satisfy a runtime-negative test even though native property definition
is valid. The recorded producer now refuses that unsupported operation outside
guest exception handling. Primitive targets and primitive descriptors retain
their genuine guest TypeErrors. The exact original constructor-getter case now
stops at property definition with no fabricated guest throw.

Adding the missing Promise property/prototype operations and original harness
reflection adapters requires further owned semantics and independent checks.
These records do not establish an iterator-semantic failure for those cases.

## Compact retention and exact reconstruction

The full compressed report was about 17 MiB and the full catalog about 20 MiB.
The retained files here omit the deterministic unselected ledger rows and the
unselected catalog entries:

- `selected-catalog.json` contains the exact selected variants and required input
  identities, together with the full acquired inventory's digest and summary.
- `selected-report.json` contains every selected attempt and all other report
  metadata, plus the original complete report's compressed and JSON hashes.
- `observation.json` records the full accounting, runtime, policy, resume check,
  source archive identity and hashes of the compact evidence.
- `restore-report.mjs` accepts an independently reacquired full catalog with the
  recorded digest, reconstructs every unselected row, validates the full ledger,
  and requires the original complete report's exact JSON SHA-256. It executes no
  guests and creates no new conformance observation.

The retained reconstruction check reproduced both the 179,435,636-byte JSON
report and the 17,316,813-byte compressed report byte for byte, with zero guest
executions. `restoration-verification.json` records that result. This evidence
reconstruction does not qualify trace checkpoint restoration.

The selected files are explicitly marked as projections. They are not standalone
full catalogs or reports accepted by the campaign runner's `--check` command.
Use the restoration helper to obtain the complete historical report first.

From the recorded producer checkout with its locked dependencies installed:

```sh
node tools/catalog-test262.mjs \
  --suite-root /path/to/exact-test262-checkout \
  --revision 2a1ade303f72d3de80565c921d685222405c32ce \
  --out /path/to/output/catalog.json.gz
node /path/to/retained-evidence/restore-report.mjs \
  --catalog /path/to/output/catalog.json.gz \
  --selection /path/to/retained-evidence/selected-report.json \
  --out /path/to/output/restored-report.json.gz
```

`reproduce.sh` performs the acquisition, historical reconstruction, a separate
new original-source execution, completed resume and report integrity check. Run
it from an unchanged checkout of the recorded producer; the retained script can
remain in another PR checkout. Set `TEST262_SUITE_ROOT` to the exact Test262
checkout and `TEST262_OUTPUT_ROOT` to an output directory outside producer source.
New executions retain their actual local worker paths and environment, so their
artifact hashes can differ from this historical observation.

## Earlier resource limit remains historical

`historical-resource-limit.json` preserves the earlier observation at producer
`c71c5425e8ca84b9e62942990aefadea1a9b7163`, which used a 10,000 ms worker wall
budget. Its sloppy `for-of/iterator-close-via-continue.js` variant was recorded as
`resource_limited`. That complete campaign had 29 owned passes, 10 unsupported
variants and one resource limit, with 40 reference passes. Its completed resume
also retained identical report bytes.

The same original variant passed in the later, separately identified 60,000 ms
observation. Its earlier exhausted attempt is preserved with its original
producer, budget, disposition and report identity.
