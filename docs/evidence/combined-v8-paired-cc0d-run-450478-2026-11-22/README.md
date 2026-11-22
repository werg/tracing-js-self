# Exact combined paired qualification at cc0d61e9

GitHub Actions run [45047889597](https://github.com/werg/tracing-js-self/actions/runs/45047889597) completed successfully on producer `cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa` and native consumer `cdd01ac0dcd65d92e948cec39f7b5c156800206e`. The exact trees are recorded in `audit-result.json`. All six required lanes and the aggregate succeeded.

The retained JUnit XML files were independently parsed as leaf test cases and checked against the lane manifests. Recovery covered 165 native and 193 producer cases; Promise covered 106 native and 173 producer cases: 271 native plus 366 producer equals 637 leaves. All retained leaves have zero failures, errors, or skips. The per-file counts, lane artifact identifiers and original ZIP hashes, wheel hash, exact pair identity, and installed source-receipt count are recorded in the audit result and lane evidence. The original compressed aggregate log is retained.

This is the exact 637-case CC0 historical run. The newer 666-case gate adds 12 producer and 17 native cases (29 total) to these populations; this archive does not claim that expanded population. An earlier editorial sentence assigned all29 additions to the producer; the original637-case measurements above are unchanged. The separately completed installed run 45047897532 is already retained at `docs/evidence/v8-installed-cc0d-2026-11-22/` and is referenced here without duplicating its log or its 688,988,565-byte artifact.

The structural test lane included one controlled fixture with three first-phase optimizer updates and one update after a phase transition (four total). That proof is retained as `controlled-position-proof.json`. The total optimizer update count across the full suite is unknown; `learnedSuccess`, full target coverage, and module admission are not established. No lane ZIP or wheel payload is retained here. The large installed artifact was not downloaded.

`manifest.json` hashes every retained file except itself. XML digests and exact leaf totals are cross-checked by `audit.py`; rerun `python audit.py` from this directory to check retained XML and the manifest.
