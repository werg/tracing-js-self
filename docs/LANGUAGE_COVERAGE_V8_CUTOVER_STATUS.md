# V8 data preparation

## Current milestone

PR [#47](https://github.com/werg/tracing-js-self/pull/47) and paired native [#38](https://github.com/werg/megatoken/pull/38) deliver a bounded, independently checked V8 data-preparation pipeline. This is the current completion scope. Model performance, full training runs, production serving, default cutover and complete ECMAScript coverage are later work.

## Included behavior

- Original JavaScript and declared module/session requests are bound to generated artifacts, source identities and complete source registries.
- Producer execution and independent native checking agree for the declared supported source profiles.
- Prepared examples preserve causal contexts, generated targets, tokenizer bytes, loss masks and terminal boundaries.
- Related sources stay in the same frozen training, validation or test component. Refused, limited and unselected sources stay visible.
- Ordinary native admission/preparation and physical packing consume verified artifacts; installed-package checks cover the supported source population.

Profiles remain bounded and unsupported inputs refuse explicitly. Existing defaults remain in place; V8 is selected through its explicit APIs and preparation tools.

## Completion checklist

1. The current producer/native pair passes canonical-contract and fixture comparison, original-source checks, independent admission and physical packing for the declared data populations.
2. Source-binding, split, causal-context, tokenizer/mask, original-module packing and installed-package regression checks pass.
3. Ordinary repository checks pass. Existing implemented recovery and packaging retain their relevant regression coverage.
4. Current scope, validation and follow-up ownership are documented. This checklist does not expand whenever a future profile is discovered.

Small optimizer/resume tests may check loader and serialization wiring. Their output is not a model-quality criterion. No program-success rate, comprehension result, full model fit or production promotion is required to finish data preparation.

## Closeout repairs and validation

The retained conversion data was regenerated from the unchanged original inputs. All 24 case inputs, dispositions, boundaries and outcomes are preserved (19 qualified and five explicitly unqualified). Only the Promise-key case's compiler-capability metadata and derived source-artifact digest changed; public data and contexts did not. The producer and native fixture bytes are identical. [Hosted regeneration and preservation checks](https://github.com/werg/tracing-js-self/actions/runs/45061368646).

A direct regression now rechecks the same four stored artifacts used by native admission, making stale source metadata visible in the ordinary producer suite. The original-module packing workflow now compares fixture digests with the generated canonical contract instead of an obsolete literal; its actual scheduler and packing coverage remains.

Current check conclusions belong to the source pair actually tested and are reported on the PR. Earlier [combined recovery/Promise qualification](https://github.com/werg/tracing-js-self/actions/runs/45050666552) and [package/restoration qualification](https://github.com/werg/tracing-js-self/actions/runs/45050666481) remain valid evidence for their recorded inputs and revisions. A documentation-only edit does not require recreating evidence when the relevant code/input identity is unchanged. Executable or data changes require their affected checks.

## Deferred work

Fourteen independently closeable issues carry the remaining program. Data production needs only the semantic profiles selected for its next corpus, not every issue below. Later model work is dormant until the data stage is complete and is never a dependency of current data preparation.

| Issue | Work | Stage |
| --- | --- | --- |
| [#48](https://github.com/werg/tracing-js-self/issues/48) | Define the next V8 data corpus scope and reconcile the language inventory | Data preparation |
| [#49](https://github.com/werg/tracing-js-self/issues/49) | Qualify an original-source runner for the next script and module data campaigns | Data preparation |
| [#50](https://github.com/werg/tracing-js-self/issues/50) | Complete shared Promise, async and iterator continuations for an expanded data profile | Data preparation |
| [#51](https://github.com/werg/tracing-js-self/issues/51) | Expand ordinary references, objects, construction and collection data semantics | Data preparation |
| [#52](https://github.com/werg/tracing-js-self/issues/52) | Complete retained module graphs, persistent sessions and TypeScript provenance for data generation | Data preparation |
| [#53](https://github.com/werg/tracing-js-self/issues/53) | Expand owned binary memory, RegExp and standard-library data profiles | Data preparation |
| [#54](https://github.com/werg/tracing-js-self/issues/54) | Add a bounded dynamic-code and realm data profile | Later data profiles |
| [#55](https://github.com/werg/tracing-js-self/issues/55) | Qualify a bounded shared-agent and atomic-memory data profile | Later data profiles |
| [#56](https://github.com/werg/tracing-js-self/issues/56) | Add explicit weak-reference and finalization semantics for a bounded data profile | Later data profiles |
| [#57](https://github.com/werg/tracing-js-self/issues/57) | Qualify finite Node, browser and internationalization profiles for data generation | Later data profiles |
| [megatoken #39](https://github.com/werg/megatoken/issues/39) | Produce a reproducible V8 corpus through ordinary native admission and preparation | Data preparation |
| [#58](https://github.com/werg/tracing-js-self/issues/58) | Complete durable host and service recovery for a fixed ownership and lifecycle profile | Future runtime integration |
| [#59](https://github.com/werg/tracing-js-self/issues/59) | Qualify a coordinated V8 production migration, release restore and rollback | Future production cutover |
| [megatoken #40](https://github.com/werg/megatoken/issues/40) | After data preparation, run ordinary V8 training and independent model studies | Dormant future research |

## Coverage of the earlier seventeen workstreams

This table maps deferred obligations; it is not a new seventeen-row merge gate. Delivered increments stay delivered, and each issue closes on its own declared profile.

| Earlier row | Workstream | Follow-ups |
| --- | --- | --- |
| 1 | Frozen scope, denominators and parity | [#48](https://github.com/werg/tracing-js-self/issues/48), [#49](https://github.com/werg/tracing-js-self/issues/49), [#57](https://github.com/werg/tracing-js-self/issues/57), [#59](https://github.com/werg/tracing-js-self/issues/59) |
| 2 | Original-source conformance runner | [#49](https://github.com/werg/tracing-js-self/issues/49), [#52](https://github.com/werg/tracing-js-self/issues/52), [#54](https://github.com/werg/tracing-js-self/issues/54), [#55](https://github.com/werg/tracing-js-self/issues/55) |
| 3 | Shared execution state and recovery | [#50](https://github.com/werg/tracing-js-self/issues/50), [#58](https://github.com/werg/tracing-js-self/issues/58) |
| 4 | Direct V8 source certification | [megatoken #39](https://github.com/werg/megatoken/issues/39), [#50](https://github.com/werg/tracing-js-self/issues/50), [#59](https://github.com/werg/tracing-js-self/issues/59) |
| 5 | Independent native semantics | [#50](https://github.com/werg/tracing-js-self/issues/50), [#51](https://github.com/werg/tracing-js-self/issues/51), [#52](https://github.com/werg/tracing-js-self/issues/52), [#53](https://github.com/werg/tracing-js-self/issues/53), [#54](https://github.com/werg/tracing-js-self/issues/54), [#55](https://github.com/werg/tracing-js-self/issues/55), [#56](https://github.com/werg/tracing-js-self/issues/56), [#57](https://github.com/werg/tracing-js-self/issues/57) |
| 6 | Composable source projections | [#50](https://github.com/werg/tracing-js-self/issues/50), [#51](https://github.com/werg/tracing-js-self/issues/51), [#52](https://github.com/werg/tracing-js-self/issues/52), [#53](https://github.com/werg/tracing-js-self/issues/53) |
| 7 | Protocol, effect and lifecycle composition | [#50](https://github.com/werg/tracing-js-self/issues/50), [#58](https://github.com/werg/tracing-js-self/issues/58) |
| 8 | Ordinary native data and later training | [megatoken #39](https://github.com/werg/megatoken/issues/39), [megatoken #40](https://github.com/werg/megatoken/issues/40) |
| 9 | Future serving and live restoration | [#58](https://github.com/werg/tracing-js-self/issues/58), [#59](https://github.com/werg/tracing-js-self/issues/59), [megatoken #40](https://github.com/werg/megatoken/issues/40) |
| 10 | References, coercion and abrupt operations | [#51](https://github.com/werg/tracing-js-self/issues/51), [#50](https://github.com/werg/tracing-js-self/issues/50) |
| 11 | Promises, async and scheduling | [#50](https://github.com/werg/tracing-js-self/issues/50), [#52](https://github.com/werg/tracing-js-self/issues/52) |
| 12 | Collections, construction, Proxy and iteration | [#51](https://github.com/werg/tracing-js-self/issues/51), [#50](https://github.com/werg/tracing-js-self/issues/50), [#56](https://github.com/werg/tracing-js-self/issues/56) |
| 13 | Modules, sessions, TypeScript and host graphs | [#52](https://github.com/werg/tracing-js-self/issues/52), [#57](https://github.com/werg/tracing-js-self/issues/57), [#58](https://github.com/werg/tracing-js-self/issues/58), [megatoken #39](https://github.com/werg/megatoken/issues/39) |
| 14 | Binary memory, RegExp and intrinsics | [#53](https://github.com/werg/tracing-js-self/issues/53), [#55](https://github.com/werg/tracing-js-self/issues/55), [#57](https://github.com/werg/tracing-js-self/issues/57) |
| 15 | Edition long tail and environment profiles | [#54](https://github.com/werg/tracing-js-self/issues/54), [#55](https://github.com/werg/tracing-js-self/issues/55), [#56](https://github.com/werg/tracing-js-self/issues/56), [#57](https://github.com/werg/tracing-js-self/issues/57), [#50](https://github.com/werg/tracing-js-self/issues/50) |
| 16 | Data production and later studies | [megatoken #39](https://github.com/werg/megatoken/issues/39), [megatoken #40](https://github.com/werg/megatoken/issues/40) |
| 17 | Future coordinated default cutover | [#59](https://github.com/werg/tracing-js-self/issues/59), [#58](https://github.com/werg/tracing-js-self/issues/58) |

The named expansion packages are covered as follows: ordinary references/objects/construction (C01/C04/C09) → [#51](https://github.com/werg/tracing-js-self/issues/51); jobs/iterators/generators/disposal (C02/C07/C08/E05) → [#50](https://github.com/werg/tracing-js-self/issues/50); modules/TypeScript (C03/C14) → [#52](https://github.com/werg/tracing-js-self/issues/52); dynamic environments/realms (C05 and selected C12) → [#54](https://github.com/werg/tracing-js-self/issues/54); memory/RegExp/intrinsics (C06/C10/C11) → [#53](https://github.com/werg/tracing-js-self/issues/53), with weak collections in [#56](https://github.com/werg/tracing-js-self/issues/56); shared agents (E01) → [#55](https://github.com/werg/tracing-js-self/issues/55); weak references (E02) → [#56](https://github.com/werg/tracing-js-self/issues/56); host/Intl/addition profiles (E03/E04/E05) → [#57](https://github.com/werg/tracing-js-self/issues/57); source compaction and data costs (C13) → [#50](https://github.com/werg/tracing-js-self/issues/50) and [megatoken #39](https://github.com/werg/megatoken/issues/39); runner and interaction evidence (Q01/Q02) → [#49](https://github.com/werg/tracing-js-self/issues/49) and each selected profile's acceptance checks. Unselected future additions stay in the inventory.

## Documentation and history

- [Preparation and export](SEMANTIC_V8_TRAINING.md)
- [Installed-source qualification](INSTALLED_V8_QUALIFICATION.md)
- [Original-input binding](direct-v8-release-original-inputs.md)
- [Original broad program plan](plans/language-coverage-and-v6-cutover.md)
- [Language expansion roadmap](plans/language-coverage-expansion.md)
- [Previous implementation ledger at its original revision](https://github.com/werg/tracing-js-self/blob/438f418895913ebee642f46b32bed3ecdb846e82/docs/LANGUAGE_COVERAGE_V8_CUTOVER_STATUS.md)

The plans retain historical proposals; this milestone and the linked issues define current delivery. Original data and substantive evidence remain available. Completed dated investigation, model-fit and archival workflows are removed; reusable tools and maintained regression coverage remain.
