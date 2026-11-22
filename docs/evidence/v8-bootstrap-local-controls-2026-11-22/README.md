# Local child-bootstrap implementation controls

These raw outputs preserve the local implementation and corrections made on
22 November 2026. They are engineering controls, not the final exact-pair hosted
qualification. The mandatory hosted candidate is producer
`86b1ecc633cd2be324c4cac2cb990d409195a1f5` / native
`8cdec19dbac9af0ba7968ac3b1adb84e53ce0dbc`, in
[run 45025448089](https://github.com/werg/tracing-js-self/actions/runs/45025448089).
Its outcome must be read independently; this local evidence does not imply that
the hosted gate passed.

## Retained results

| Raw report | Result and boundary |
| --- | --- |
| `producer-bootstrap-controls-initial.log` | 51 passed, one failed, zero skipped, 52 Node-reported cases. Separating startup from the create acknowledgement exposed an accounting regression: a later startup failure must preserve the accepted create and record a post-commit failure. The implementation was corrected. |
| `bootstrap-builder.log` | Eight reconstruction controls passed, zero skipped. A controlled protocol peer supplies this evidence; it is not independent native reexecution. |
| `bootstrap-builder-driver-corrected.xml` | 12 leaf cases passed, zero failures/errors/skips. Includes the reconstruction controls and ordinary coordinator-driver controls, including the corrected acknowledged-create accounting. |
| `bootstrap-real-transport-initial.log` | Ten passed, one failed, zero skipped. Correct local stale-receipt refusal could finish before the peer created its own decoder log. The test incorrectly required that file to exist. |
| `bootstrap-real-transport-corrected.xml` | All 11 actual Python transport controls passed, zero failures/errors/skips. A missing log is allowed only on the local stale-refusal path after separately asserting zero native RPCs and zero model attempts. Positive paths still require actual logs. |
| `native-bootstrap.xml` | Initial four native bootstrap controls passed, zero skipped. |
| `native-bootstrap-controls.xml` | Expanded 13-case bootstrap suite passed, zero failures/errors/skips: identity/model/generation substitutions, wrong parent/budget replies, rehashed operation/attempt tampering, duplicate dispatch, unknown outcomes and fresh restoration. |
| `native-commit-recovery.xml` | Existing 33-case native exact-commit suite passed, zero failures/errors/skips. |

The suites overlap and must not be summed as independent source populations.
Original `.log` files accompany the native JUnit reports. `files.json` records
the exact sizes and SHA-256 hashes of every retained raw report.

## Provenance and limitations

The native first increment ran in the isolated local worktree at
`9c0e1c31c96d578a3e7ea42032af937384d9726a`; its published executable counterpart is
`8cdec19dbac9af0ba7968ac3b1adb84e53ce0dbc`. The expanded native controls ran at
`d9dd9998a001bcebb63e248a172c9735e7ddd600`. Their test and bridge changes were
subsequently composed with the separate router audit at native main `7f6245c`.
That later composition is not retroactively the revision of the earlier run.

Producer local commands ran during the implementation of the create/startup
split and subsequent test corrections. `reference-source-map.json` records
the resulting source at producer `ce642c10` and the two native local commits.
It is a reference map captured after those exploratory commands, not a claim
that every evolving earlier working tree had a clean final commit identity.
The frozen hosted gate supplies exact clean-checkout provenance for promotion.

The paired peer uses the production Python adapter and native durable journal,
but supplies deterministic final lexical decoder bytes. These controls establish
ordering, identity and state reconstruction; they establish no learned quality,
production asset readiness or wider language coverage. Optimizer updates: zero.

The local runtime cannot read `/proc/self/ns/time`. No clock authority was
fabricated and no production clock check was relaxed. Positive whole-history
clock/repeated-loss qualification is therefore hosted. Local process tests used
an exact copied `flock` executable with SHA-256
`231d0d5879ff18acd8edcedb791be807cc7507df4dcfd7a17269d54bbeef21e1`;
the copy has the required trusted file ownership. The original binary has the
same hash. The ownership check remains enforced.

## Lessons carried forward

- Child reservation and initialization are separate native mutations. Preserve
  the acknowledged complete application state between them and journal the
  initialization under a distinct request ordinal.
- A known later initialization supersedes recovery of the earlier reservation.
  An unknown initialization does not authorize replay or another dispatch.
- Repeated recovery must retain elapsed time, consumed model selections and all
  earlier recovery costs. It must not recreate a fresh budget.
- Native reconstruction alone cannot authorize host continuation. The exact
  latest independently acknowledged whole application history must also pass.

Terminal close, unknown external outcomes, distributed successor ownership,
broader semantics and the 17 complete acceptance packages remain open.
