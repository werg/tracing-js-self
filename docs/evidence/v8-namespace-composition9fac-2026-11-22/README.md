# Main-compatible namespace candidate: retained intermediate result

Exact producer `9facd09910c7e1f66167f1b57f8347273add184b`, composed on main
`e52855c`, passed 17 early source/runtime controls, 172 individual focused
JUnit controls including current service recovery, 40 namespace behavior/source
controls and 79 actual paired Python transport controls, all with zero skips,
in [run 45002195867](https://github.com/werg/tracing-js-self/actions/runs/45002195867).

The artifact evidence collector's added reporting code required formatter
changes. Its Ruff format check refused before the artifact test executed.
Because that check precedes the broad native manifest, the broad suite did
not execute. This is not a new artifact-admission failure: the earlier exact
`7607f97/bfa2e33` artifact test passed and is retained separately.

The full failure log, focused pass log and early-source pass log are retained.
The exact emitted formatter output has been committed in the next consumer
candidate; the next producer candidate also includes the separately qualified
kernel execution-lock prerequisite. Broad native and combined tests apply only
to the actual next executable revisions once completed.
