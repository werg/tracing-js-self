# Direct V8 release packaging and restoration

The direct V8 commands package and restore a bounded ordinary text model with
its complete retained qualification journal, prepared input, tokenizer,
checkpoint and served state. They use the neutral archive implementation and
the direct native V8 verifier. They never import the old semantic packager or
restorer, and never execute code supplied inside an archive as its verifier.

This is an isolated implementation candidate. The focused archive, identity,
lock and refusal controls pass; an actual fresh paired production-tokenizer
package/restore gate is still required. No production default, learned-quality,
accepted-history recovery, deployment or rollback qualification is implied.

## First explicit profile

The profile is `ordinary-single-rank-fresh-stage-text/1`. It requires one
prepared text root, one directly committed ordinary checkpoint, its matching
served export and a named native model preset with bound inline overrides.
Every selected source in the complete qualification journal must already have
source and native admission. Unselected cases, original failed attempts,
refusals, content-addressed journal objects and auxiliary files remain retained;
none can silently become an admitted source.

The native verifier rejects unbound packs, donor imports, teacher features,
text anchors, hindsight inputs, distributed or decoupled routes, stage/effort
mixtures and archived stage history. Its first profile cannot infer those
dependencies or omit them. The checkpoint input must be the concrete committed
directory, rather than a latest-pointer or repair-needing training root.

Partial checkpoint coverage is allowed only as explicitly measured partial
coverage. Missing or repeated physical targets do not become a complete
one-pass fit. A served export from a separate two-update lifecycle cannot be
paired with a different 348-update checkpoint, even if both came from one
workflow archive. Actual state and lineage checks bind the chosen pair.

## Package

Both source directories must be exact, clean checkouts. The producer checkout
must contain the invoked driver; the native checkout must contain
`scripts/verify_semantic_v8_release.py`. Qualification, recipe, prepared input
and checkpoint policy must name this same source pair. Old receipts are not
relabeled to a new revision.

Run in the locked environment with its exact Node, V8, npm, Python and native
package versions. Install dependencies from `npm-shrinkwrap.json` and
`tools/native-consumer/requirements.lock` before verification. The V8-specific
runtime lock is `profiles/release-environment-v8.lock.json`; it does not load a
V6 policy. Runtime receipts preserve the actual platform and runner/container
identity when available, without claiming a portable container image.

```sh
TZ=UTC LC_ALL=C.UTF-8 python tools/package-semantic-release-v8.py \
  --producer-root /work/tracing-js-self \
  --megatoken /work/megatoken \
  --python /work/locked-env/bin/python \
  --qualification /assets/source-qualification \
  --prepared /assets/prepared \
  --tokenizer /assets/tokenizer.json \
  --checkpoint /assets/training/checkpoints/SE-000000002 \
  --served /assets/served \
  --recipe /assets/original-training-recipe.json \
  --out /releases/new-v8-release
```

The output directory must not exist and must be outside all source and asset
inputs. Its parent must exist. `--source-recheck-timeout-seconds` optionally
sets the native per-source recheck subprocess bound from 1 through 900 seconds;
the default is 30. Source execution and model limits inside the retained
artifacts are not rewritten.

Packaging holds the original qualification journal's shared operating-system
lock through copying, source/data/model verification and archive creation.
An active writer, a missing original lock or a torn journal refuses; packaging
does not resume or repair the campaign. Every committed historical artifact
must still have its original bytes. Files are hashed before and after copying,
with fixed file-count, compressed, expanded and individual-member bounds.

The output contains `semantic-v8-release.tar.gz`, the matching external
`release-manifest.json`, `package-result.json`, an inspected payload directory
and the original verification stdout/stderr. `package-result.json` records the
archive's independently computed SHA-256 for subsequent restore. Keep this
checksum outside the archive with the release's trusted source identities.

## Bundled roles

| Role | Canonical path | Binding |
| --- | --- | --- |
| Complete qualification | `source-qualification/` | Every declared case, selected membership, journal attempt and retained byte |
| Prepared input | `prepared/000/` | Full episode, record, token, mask, split and index equivalence to fresh preparation |
| Tokenizer | `tokenizer/tokenizer.json` | Exact bytes and codec identity from the qualified native policy |
| Committed checkpoint | `training/checkpoint/` | Actual checkpoint payload, metadata, attachments, cursor, lineage and position census |
| Served export | `serving/` | Actual loaded tensors, configuration, tokenizer and transducer bank equal the named checkpoint |
| Original recipe | `training/original-recipe.json` | Unmodified original bytes |
| Portable recipe | `training/recipe.json` | Only codec, single dataset and output locators change; all other fields preserve their types and values |
| Descriptor and proofs | `release-inputs.json`, `proofs/` | Exact source pair, roles, original journal/native/environment reports and locator normalization |

The native recheck invokes fresh producer/source correspondence and native
validation, tokenization and packing for every selected source. Complete
reconstructed data semantics must match the bundled corpus. SQLite placement
and incidental JSON formatting are not semantic equality; the bundled and
regenerated corpora still each validate their own file seals.

The descriptor names each original `*.source.json` input, whose complete bytes
were bound into the preparation receipt. Its distinct admitted copy and native
receipt remain archived and journal-verified. Fresh preparation preserves the
bundled episode order after checking exact unique source membership; the
qualification report's registration order need not be the training input order.

The native report is written outside the immutable input root, then preserved
as proof before the final archive inventory is sealed. Its original input
inventory therefore does not include its own later report or the outer archive
manifest. Restore validates all archive members, including those proof files,
and independently hashes the entire restored root before and after the fresh
native check. It compares explicitly named semantic fields across relocation,
not temporary preparation paths, wall times or a self-referential report digest.

## Restore

Use trusted external checkouts at the manifest's original producer and native
commits. Neither archived scripts nor a self-authored "passed" report may
replace those implementations. The wrappers verify the exact adjacent driver
bytes before execution; that driver verifies its neutral archive helper before
execution. The manifest also retains the complete implementation and lock-file
receipts used to create the package.

```sh
TZ=UTC LC_ALL=C.UTF-8 python tools/restore-semantic-release-v8.py \
  --producer-root /work/tracing-js-self \
  --megatoken /work/megatoken \
  --python /work/locked-env/bin/python \
  --archive /releases/new-v8-release/semantic-v8-release.tar.gz \
  --expected-archive-sha256 <trusted-external-64-character-sha256> \
  --out /restored/new-v8-bundle \
  --evidence-out /restored/new-v8-verification
```

Both destinations must be new, disjoint directories. Archive identity,
membership and every byte are checked before extraction. Absolute paths,
traversal, duplicate members, links, sparse or special members, excessive
metadata and changed source bytes refuse. Extraction only creates regular
files with exclusive writes; it never applies archived permissions or calls
`extractall`.

Restore then verifies the complete journal and derives source membership from
it again, checks the original/portable recipe relationship, validates the
locked runtime and repeats the full native source/data/checkpoint/export
verification. It compares actual restored semantic state with the packaged
result and checks all restored bytes again. Only a completed operation writes
`restore-result.json` with status `verified`. A failed check retains its
original logs and any partial extracted directory; it writes no passing result
and never overwrites an existing destination.

This path performs zero optimizer updates and zero decoder forward passes.
Loading equal served state is a prerequisite for serving; it does not prove
accepted application-history recovery, external-effect deduplication or an
operational rollback. Those remain separate current-pair gates.

## Focused controls

`python -m unittest discover -s tools/native-consumer -p test_release_v8.py -v`
exercises actual archive creation/extraction and file locks, strict recipe and
manifest typing, complete selected-source authority, immutable inputs, external
checksum refusal, hostile paths and links, and fresh-process wrapper imports
with every legacy release file absent. The native verifier's controlled model
checks and the hosted real package/restore gate are separately counted; these
archive controls do not execute source admission or optimization.

## Manual package and restore gate candidate

`.github/workflows/v8-release-package-restore.yml` is manual-only and is not
triggered by publishing its source branch. Root composition must choose the
final producer/native pair before this workflow is run. It reads the exact
native revision and tokenizer identity from the producer policy, qualifies all
64 original SE support inputs, checks the frozen 48/12/4 split, and prepares
those original source files in sorted `sourceId` order. It then reuses the
ordinary lifecycle command without `--full-target-coverage`, packages the exact
`SE-000000002-periodic` checkpoint with its matching served export and
`training-config.json`, and restores after removing the original qualification,
prepared tree, tokenizer, lifecycle outputs and package staging tree.

The gate also rehashes a modified served-model archive and requires the sealed
member inventory to refuse it before native restore starts. Its success summary
keeps the two lifecycle optimizer updates separate from the zero-update package
and restore verifiers. Full one-pass training coverage, learned success,
default promotion, live history recovery and portable-container qualification
remain false or unmeasured. The workflow candidate has not been launched.
