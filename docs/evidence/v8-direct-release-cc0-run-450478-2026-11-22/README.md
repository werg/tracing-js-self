# Direct release package and restore run

GitHub Actions run [45047889609](https://github.com/werg/tracing-js-self/actions/runs/45047889609), job `137290313101`, completed successfully at 2026-11-22 17:50:19 UTC. The exact tested pair was producer `cc0d61e98dc6252749f4a2a4c8b669d79b0f7efa` / native consumer `cdd01ac0dcd65d92e948cec39f7b5c156800206e`; their tree IDs and runtime pins are in `run-evidence.json`.

The hosted job log reports 88 passing Python controls and 83 passing producer JavaScript controls, with zero failures, errors, or skips. It qualified and admitted all 64 original source tasks: 48 train, 12 validation, and 4 test. It then recorded two optimizer updates in the ordinary lifecycle phase, zero package updates, zero restore updates, and zero decoder forward passes. Restore was run after the original runtime asset locators were removed; the report records comparison of actual checkpoint and served state.

The run-produced package report gives a 70,598,150-byte archive with SHA-256 `335c5996a1611858f475d97208bf42e1c025910306f0472b5f422b773e2797aa`. The uploaded evidence artifact is ID `14766156057`, 349,488,446 bytes, SHA-256 `806a2147e9fe3f142a4571fe98a6fae402bf3bec579269b46eea8b06f3453fce`. The job log reports its embedded original tar as 350,198,182 bytes, SHA-256 `514c133b76ef8e003eaf37b70b4ea8adf531dbc0bccbbd3e8492a6475426ffda`. Those are run-reported bytes and digests. This audit did not download the artifact or inspect its members.

The full job log is retained as deterministic gzip in `combined-job.log.gz`. The three final machine reports, API job-step metadata, API artifact metadata, and `manifest.json` are retained for review. This is the historical CC0 run on the exact pair above; it grants no qualification credit to later producer commit `69c4b92d` and its stricter 140-JavaScript/94-Python controls. The package population remains64 sources; the separate installed interoperability population has69 inputs.

## Scope and limits

The reports explicitly leave learned success null, default promotion false, and full target coverage false. Accepted-history recovery is unmeasured. The two ordinary lifecycle optimizer updates are not package or restore updates. This evidence describes package creation and restoration for the recorded 64-source run; it does not establish full training quality, a later source composition, release publication, or model promotion.

Run `python audit.py` from this directory to verify every retained file hash and compare the key run/report fields. The original 349 MB Actions artifact and archive were not downloaded here.
