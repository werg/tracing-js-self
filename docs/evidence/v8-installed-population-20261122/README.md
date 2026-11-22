# Installed population: preserve 731 original inputs and qualify three additions

The installed gate at producer `7c20124f3d89dfe1a8d5e892238e7b7f92589720`
failed before running any source cases. [Run 45045817948](https://github.com/werg/tracing-js-self/actions/runs/45045817948),
job `137280068568`, retained the error `Declared installed population changed:
interoperability`. The gate still required 66 selected inputs after the canonical
Promise adoption implementation added three original source fixtures.

The correction is published at `30caf935b14cca76c555ec8eb903d57ea8407bc0`,
tree `98f648a9d94cbcedf5af8b3cc81a93a35afe8231`. The exact tested local commit
`f0d82c502273a889f6317906f38f2dea414280d8` has that same tree. No semantic
compiler, source fixture, native implementation or default changes here.

## Preserved inputs

An independent input-only comparison encodes every fixture with each checkout's
own `encodeGenerationTask`, then compares its complete encoded fixture JSON.
The prior checkout is local `b02a02aca4510169aa3bd341e82bd75ff83c2ef4`, whose
published equivalent is `53c86f35cd225e770c9b7a1aa35aa42f10d5f217`, tree
`3166cb586caa1aeb72afb20405e6028d850ea137`. The current input population was
read from exact `7c20124f`; the correction changes none of those inputs.

| Population | Before | Now | Removed or changed original inputs |
| --- | ---: | ---: | ---: |
| Original complete population | 665 | 665 | 0 |
| Selected interoperability population | 66 | 69 | 0 |
| Total declared rows across both named populations | 731 | 734 | 0 |

Exactly three selected sources were added:

- `source-promise-adoption-executor`
- `source-promise-adoption-async-return`
- `source-promise-adoption-reaction-return`

All 731 original encoded inputs have identical SHA-256 hashes. The five original
module graphs remain. The two named populations are separate test selections;
their sum is not a claim of 734 distinct source programs. The complete row maps
and original/current source identities are retained in
`input-correspondence.json.gz`. This comparison performs zero source executions,
native admissions, model calls or optimizer updates.

## Source correction and observed controls

The installed inventory now declares 665/69 in one exported, frozen constant;
the workflow reads the same explicit declaration. An unexpected future count
still fails, reporting expected and observed values. The fixture selection,
failure accounting, old inputs and source-level refusal rules are unchanged.

All **nine** existing installed-package control tests passed, with zero failures,
errors or skips, on the exact source tree above. The public worker control now
actually checks and continues all three new adoption sources, alongside its
original source/callback/module positives. Existing graph-transport, unchanged
original-reference, canonical-result disagreement, deliberate source refusal,
live callback completion and actual isolated npm-package integrity controls
remain present. Full raw spec/JUnit outputs are retained.

The control runtime is Node 24.22.3 and npm 11.19.1. This is the installed-package
gate's runtime, not a claim that the separate direct-release environment lock
(npm 11.9.0) was checked here. No native consumer or learned result is qualified.
The complete installed **665/69** hosted population still needs its own run;
nine controlled tests do not replace that full gate.

## Evidence

`manifest.json` records source/tree identity, exact command, counts and stored
file hashes. `original-hosted-job.log` is the complete decoded UTF-8 job log;
the run and job JSON retain the original preflight failure. `controls.log` and
`controls.xml` are complete local outputs. `audit-inputs.mjs` reproduces the
input comparison without editing either checkout or executing its source tasks:

```sh
node docs/evidence/v8-installed-population-20261122/audit-inputs.mjs \
  /path/to/prior-53c86-checkout /path/to/current-30caf-checkout \
  /path/to/new-input-correspondence.json
```

Both checkouts need their ordinary locked parser dependencies available. The
auditor refuses to overwrite its output, requires the declared 665/66 and
665/69 counts, and verifies exactly the three additions listed above.
