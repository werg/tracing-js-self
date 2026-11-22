# Registered production surfaces and migration dispositions

This inventory freezes producer `2cb668c233be139e37d3e5a78c8d4ab8a544cd62`
and native `6ef4794048a4d2ab0e732ccfd61c5cc3e7c3c822`. It records **205
canonical registrations**, each assigned exactly once to one of **23 reviewed groups**.
It also retains hashes for **191 producer** and **155 native** executable,
configuration and workflow candidates. These are different denominators:
one source can register several commands, and some catalog files are helpers
or tests rather than production entrypoints.

| Registered surface | Count |
| --- | ---: |
| Package targets, including browser/default/types/import conditions and bin | 36 |
| npm commands | 52 |
| General owned-runtime CLI commands | 5 |
| Python console entry | 1 |
| Native argparse commands and groups | 46 |
| Python module launchers | 9 |
| Legacy and V8 canonical semantic JSONL operation names | 12 + 22 |
| Additional accepted V8 separator spellings, mapped to those names | 8 |
| Default and explicitly versioned stream producers | 12 |
| Raw canonical training stage definitions, plus retained shared defaults | 10 |

The complete source identities, registration values, stage definitions and
file hashes, shared stage training defaults and eleven supplemental release/launch input receipts are in [registered-surfaces-corrected.json](registered-surfaces-corrected.json).
[reviewed-dispositions-corrected.json](reviewed-dispositions-corrected.json) binds all 205 entries
to their purpose, current disposition and remaining migration gate. The audit
rejects omitted, invented or multiply assigned registrations, changed source
or catalog bytes, mismatched review identity and false parity claims.

The real native argument parser was also constructed independently from the
exact clean checkout. All **46** command/group paths and their assigned
handlers matched the static inventory, with zero commands dispatched.
See [the reproducible check](check-live-cli.py) and its
[corrected result](corrected-live-cli-audit.json).

The corrected focused controls pass seven cases plus 20 explicit subtests,
with zero failures/errors/skips. They exercise
conditional package exports, nested command registration and literal loops,
unknown dynamic/alias/helper refusal, added/removed/changed registrations,
complete review ownership and the separation of inventory from semantic
qualification. [Corrected JUnit](corrected-inventory-controls.xml) and
[complete corrected log](corrected-inventory-controls.log) are retained. The local runtime was
Python 3.12.14 and pytest 9.2.0; the native repository declares pytest <9.
These standard-library inventory checks do not claim a locked native semantic
qualification and do not load a model or perform optimization.

## Reproduce

Run from the producer checkout, with both exact commits available locally:

```sh
python tools/audit-production-routes-v8.py \
  --producer . --native ../megatoken \
  --producer-revision 2cb668c233be139e37d3e5a78c8d4ab8a544cd62 \
  --native-revision 6ef4794048a4d2ab0e732ccfd61c5cc3e7c3c822 \
  --verify docs/evidence/v8-production-routes-2026-11-22/registered-surfaces-corrected.json \
  --review docs/evidence/v8-production-routes-2026-11-22/reviewed-dispositions-corrected.json
python docs/evidence/v8-production-routes-2026-11-22/check-live-cli.py \
  --native ../megatoken
python docs/evidence/v8-production-routes-2026-11-22/check-review-corrections.py \
  --producer . --native ../megatoken
```

The first command reads immutable Git objects and may run from a later clean
documentation checkout. The independent live-parser check requires the native
worktree itself to be clean and at the recorded revision. A new revision or
registration requires a fresh inventory and explicit review, not relabeling
this receipt.

## Independent review and correction

The first published inventory omitted eight accepted separator spellings from
its canonical V8 method names and silently ignored unsupported registration
helpers nested in conditionals/loops and a direct registration inside `try`.
The original frozen parser still matched all 46 recorded command paths; the
issue was an overly broad refusal claim in the discovery tool. The exact
[red review](independent-review-red.json) is retained unchanged. The original
inventory, reviewed groups, six-case report and live-parser result remain as
separate historical files.

The corrected inventory lists every accepted spelling beside its canonical
operation, rejects the reproduced nested/dynamic/alias/helper forms, retains
shared stage defaults explicitly and binds nine producer release/dependency/
policy inputs plus the native Dockerfile and package declaration. The container
recipe still needs an operator-qualified immutable base image for production;
recording its source is not a deployment qualification. The executable
[correction check](check-review-corrections.py) compares all eight spellings
against the frozen real dispatcher using a fake adapter and refuses all three
original nested-registration probes; its [green result](independent-review-green.json)
retains zero model loads, command dispatches and host dispatches. The whole-tree pins
remain unchanged, and no runtime or command handler was dispatched.

## Limits and next decisions

This closes a registration-discovery gap in the former four-category matrix.
It does **not** establish complete semantic parity, every symbol behind a
public package entry, every possible embedding caller, external deployment
configuration or all behavior combinations. The vendor spec-oracle tree is
outside the production candidate catalog. A registered command is not proof
that its inputs, output, restoration or learned behavior are qualified.

The reviewed source still has legacy selected training/Natlang defaults, a
mixed semantic export, an older default semantic stream, legacy release
packaging/restoration and separately opted-in V8 routes. Shared owned-runtime,
media, retrieval, storage and model infrastructure must not be removed merely
because they share an older module name or model version. All final cutover
and 17-package acceptance claims remain open.

The native source here includes the first terminal-close and alternate
bootstrap implementation. The later predecessor-bound bootstrap reconciliation
must refresh those operation names and source identities. Neither the ongoing
training campaigns nor their frozen inputs were changed by this inventory.
