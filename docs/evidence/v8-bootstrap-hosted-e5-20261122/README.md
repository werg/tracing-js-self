# Exact causal bootstrap and complete-history hosted qualification

[Run 45036948244](https://github.com/werg/tracing-js-self/actions/runs/45036948244)
completed successfully with **151 native and 170 producer leaf cases**, zero
failures, errors or skips. Job `137252701839` finished at 15:39 UTC on
2026-11-22. These counts were independently parsed from the downloaded JUnit
files. Node's aggregate reports 175 because it includes five parent containers;
the required and retained producer population is 170 leaf cases.

| Identity | Exact revision | Exact tree |
| --- | --- | --- |
| Tested producer source | `e5d53e47b39ccc1699db6da0c6f53bb703b3dce2` | `4e1f048e718daa1a7ff7617202de2eb086090153` |
| Tested native source | `56cce3b80423b0cb70c3a096d867561066e3a211` | `96ac16250743ac46d3f4b97d231bfcea8cc2a223` |
| Workflow definition | `4371410e0026a5c70246b484f99b01da3994a6fb` | `08729d76af7ed9a68f72409fcace2d00726c9db3` |

The workflow explicitly checked out the frozen producer source above, rather
than its own workflow commit. Its only changes were a 60-minute CI job limit,
streamed spec output beside the JUnit reporter, and explicit source identities.
The producer tests, implementation, native pin, semantic/model deadlines and
required populations were unchanged. Both checked-out source trees were clean
after qualification. The real Linux time namespace authority was required.

## Qualified scope

The native population consists of 42 durable commit cases, 12 request-journal
cases, 17 child-bootstrap cases, nine terminal-close controls, 16 launch controls
and 55 position-receipt cases. The child-bootstrap controls include all four
accepted separator spellings at the raw dispatch boundary; normalization
prevents the two mixed spellings from bypassing the durable-only guard while
retaining the original request bytes for causal supersession.

The producer population exercises complete selected orchestration history,
known create and child-bootstrap reconstruction, the intermediate
bootstrap-ready cut, the pending bootstrap fence, original ordinal and causal
create binding, lost and altered replies, repeated process loss, and a later
sibling creation/bootstrap with prior nonempty child and context history.
Adversarial controls bind owner, child, predecessor, complete native work and
execution budget. The durable transport fences after any attempted intent
publication, including a lost append acknowledgement or failed independent
readback before native dispatch. Commit and bootstrap share that storage
ambiguity defense. Recovery does not invent model selections or redispatch
completed host work, and the original execution clock and cumulative costs
survive acknowledgement and repeated restoration.

This is the exact causal-bootstrap qualification. The later combined
service-owned terminal-close history candidate, expanded predecessor controls,
Promise changes, input relocation and release tooling require their own exact
composition evidence. Native terminal-close controls in this cohort do not
qualify the later producer service-owned close path.

## Earlier records remain separate

Run `45032886414` used the same tested source pair but reached the earlier
35-minute CI cap. Its native population passed 151 cases. Its producer JUnit
contained only a 52-byte opening header and its raw log did not stream
individual cases, so the producer completed population remains **unknown**.
This later success does not reconstruct the missing population of that run.
The complete cancelled evidence remains in
`docs/evidence/v8-bootstrap-ci-budget-20261122/`.

The earlier `ae5/56` and superseded `32ef/b504` runs each had four producer
fixture failures. Their original raw results remain in
`docs/evidence/v8-bootstrap-fixture-correction-20261122/`. The producer `e5`
source fixes the two Python fixture wrapper signatures. That directory's
`corrected-source-map22.json` records the exact 22 scoped implementation,
declaration, test, policy and workflow paths relative to the original main
baseline. Apply its scoped changes with current-branch comparisons; do not
replace later recovery or release work with the whole older branch tree.

## Retained bytes

The original artifact is `14760813655`, `durable-bootstrap-history-controls`,
15,916 bytes, SHA-256
`6e54d520f3a76095f1382e65560b91b5a9791a219a1a9736965837624a77dfc8`.
Its four files, both parsed JUnits, streamed producer log, exact checkout
identity, complete raw job log and original ZIP are retained here.

`manifest.json` records original and stored hashes. Files ending in `.gz.b64`
decode with `gzip.decompress(base64.b64decode(bytes))`; the decoded bytes must
match the original hash. This documentation increment changes no executable
or test source and leaves both frozen feature and workflow branches unchanged.
