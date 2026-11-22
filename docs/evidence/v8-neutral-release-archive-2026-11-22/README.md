# Source-neutral archive extraction and preserved release controls

The archive-integrity implementation is available directly as
`tools/release_archive.py`, using only the Python standard library. It retains
bounded hashing and reads, canonical member names, complete membership checks,
deterministic tar/gzip bytes, duplicate/link/special-member refusal, compressed
and expanded size limits, exact input receipts, atomic archive publication and
verified extraction into a new private directory.

The reviewed source is producer
`99472fc4461fa0d37cea75fc62b40ae593b788a6`, tree
`1de8415391f6a5a904cce52f0f5bbd9d5f663fb6`. The executed local commit
`56841b15dc8440dc015495d8e681c851774696c3` has that identical tree.
The baseline is `28dcdbaba8c59ececba4c62de98baeb6cce551b3`.

## Preserved behavior and provenance

The existing package and restore commands keep their public function signatures,
command-line help, V6 schema/revision policy, environment checks, source/native
requalification and training-selection behavior. Their archive functions use
the extracted implementation. The package wrapper continues to honor its own
manifest-size setting, including the existing negative-test seam.

The wrapper's source includes the exact helper SHA-256. It bounds and hashes the
helper source, then compiles those same checked bytes. It does not reread a
potentially changed file or execute cached bytecode. There is no circular hash:
the standard-library-only helper has no dependency on the wrapper. When changing
the helper, its wrapper pin must change in the same source increment.

The helper is included in packaging and restoration implementation receipts.
The audit supplement's existing `packagerSha256` now transitively binds the
wrapper's dependency, and the supplement retains the helper source and its
receipt. A directly selected standalone archive implementation remains pinned
by its own source. The actual historical standalone baseline packager was also
exercised through the updated audit supplement; its code was unchanged.

## Checks and limits

The exact frozen baseline passed **33 test cases and 32 subtests**. The final
source passed **38 test cases and 32 subtests**, with zero failures, errors or
skips. The five added cases cover a fresh-process archive roundtrip with only the
neutral helper present, byte-identical direct/wrapper archive output and retained
V6 schema refusal, a substituted helper rejected before its source executes,
and both extracted-wrapper and standalone audit-packager routes. Existing
negative controls still cover corrupt or changed bytes, incomplete or duplicate
membership, traversal, links, special members, resource limits, unexpected
prepared data, training caps and source/runtime policy mismatch.

`ast-api-behavior.json` independently records:

- All **20 extracted functions/classes** preserve their original core AST,
  allowing only removal of the old `release.` namespace in the five restore
  functions and the explicit manifest-limit parameter in two archive functions.
- All **25 semantic wrapper functions** preserve their original AST, apart from
  adding the helper's implementation receipt at package/restore entry points.
- All **20 existing extracted public signatures** remain identical.
- Both command-line help outputs, original/current deterministic archive bytes,
  verification receipts and restored bytes/modes match.
- The helper's imports are exclusively standard-library modules, and an actual
  audit run with the original standalone packager still succeeds.

The original dependency-unavailable attempts are retained separately. Both lacked
`acorn` in newly isolated checkouts and produced seven failing test/subtest
results. The first was a development attempt during editing and is not a frozen
source baseline. The second used the exact clean baseline. After both checkouts
were pointed at the already-installed producer dependencies, the exact baseline
and final source passed. The intermediate extraction run is retained as a
development result, with no frozen-source qualification claim. `summary.json`
identifies every attempt and its role; no failed result is relabeled as passing.

Ruff passes for the five changed source/test paths with the pre-existing
non-executable-shebang rule `EXE001` excluded. Local Python, pytest, Node and npm
versions, dependency/lock receipts and raw logs/XML are retained; this is not a
claim of executing the hosted release environment lock.

This increment performs archive-control work only. It does not implement the
new V8 package/restore entry points, perform native semantic admission, run an
optimizer, qualify a complete release or establish learned behavior. Both
running hosted training campaigns retain their own frozen sources and evidence.
