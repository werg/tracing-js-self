# Installed independent V8 entry and dependency evidence

## Published implementation and exact tested source

- Public entry: `455b44d06e3b6fddb5f3ed39b5a3f3be0a1c91a9`.
- Publishable dependency evidence: `9d85e301e6674b97a1ac960d5efb87e572e4137e`.
- Integrated policy/ledger tree: `39ac1657b8905739bf11e1d55adb63b20d936043`
  (`a013e5f598401f50fefcadea96f214332e057cd2`), pinning native consumer
  `1ddcc6110d70703f6b08244d53ec461047677bec`.
- Exact separately tested API patch: `3c5a1b6a756af2a6d3534ea5765e17c9a3db02ae`.
- Exact separately tested packaging patch: `ce8118d327eb865cd8270c2578528e81b7254bce`.

The two original patch commits are retained in `source/implementation.bundle`,
with published producer `19eba4f4ef273e15c126d6a35cb38db05156e2d1` as its sole
prerequisite. Publication preserved intervening concurrent work; local test
results retain their actual source trees rather than adopting later commit IDs.

## Results and limits

The API patch passes **34/34** Node controls. The packaging patch passes
**57/57** Node controls across 11 affected files and **33/33** Python release
controls, with zero failures, skips or cancellations. Fresh normal npm installation
and subsequent private-cache offline installation pass. The four installed
registry tarballs are retained here and independently verified against the exact
root lock's SRI values. The Darwin-only optional package is explicitly absent.

The root lock rename is byte-identical: SHA-256
`951a0286f32416f73e72b9fd05af80cf86ded5fbed16fbfde5ff0a2aef3fdc88`.
Dependency versions and integrity pins are unchanged; the oracle's separate
lock is unchanged. `packageLockDigest` retains its historical receipt-field
name and hashes the exact canonical `npm-shrinkwrap.json` bytes.

The installed gate uses real npm pack/install of the required runtime assets
with the repository's exact package metadata. It removes 18 historical clients,
then exercises the supported `tracing-js-self/semantic/v8` entry for direct
projection/replay, one disclosed native test-service call, mixed continuation,
and complete original-source checks/rechecks for pure, host-effect and protocol
examples. Forged native receipts and altered or omitted dependency evidence
are refused before native admission. Dependency directories, freshly verified
through npm ci, are repacked for the offline installed-client test; those local
archive bytes are not confused with the separately retained registry archives.
Large historical evidence is excluded from its runtime staging; this is not a
complete release archive qualification.

The later integrated tree passes **4/4** public-entry checks and the unchanged
complete contract check. Its first attempt passed three tests but the installed
case could not create `/tmp`; the original failure is retained. Repeating that
gate with a writable temporary directory passes all four. Contract stdout was
returned by the executor; its structured result is retained, not an invented
byte-exact log. `checks/verification-published.json` states this distinction.

Original missing-export, aggregate dependency, missing-lock and empty-cache
attempts remain in `checks/`. No output or previous receipt is repaired or
resigned. These gates do not establish whole-population parity, independent
native source admission, learned execution, default cutover or completed
packages 3/4. The full665 campaign is a separate measurement.

## Restore and inspect

Concatenate `complete-run.tar.gz.part-*` in filename order. Verify each part
and the resulting archive against `inventory.json`, then extract it into a new
directory. Every member has an exact byte length and SHA-256 in that inventory;
all members were restored and checked before publication.

In a producer checkout containing the bundle prerequisite, `git bundle verify`
on the restored bundle verifies ancestry; `git fetch` from that bundle makes
the two original test commits available. Their standard test files contain the
complete executable controls. `checks/verification-api.json` and
`checks/verification-packaging.json` retain commands, identities, logs and scope.
Use a writable temporary directory when reproducing under a restricted host.

`registry/dependencies.json` maps each original dependency archive to its lock
integrity, SHA-256 and version. `source/npm-shrinkwrap.json` preserves the exact
lock bytes. `source/package-evidence.py` retains the packaging procedure and
original workspace locations; it is provenance, not a portable path map.

Archive: **28 members**, **8,562,245 uncompressed bytes**, **8,513,773 compressed bytes**, **5 parts**.

SHA-256: `639e237126ceb0ee55c6c4c7d03408d891c8ce0b1b0413c3810658f4c4cae275`.
