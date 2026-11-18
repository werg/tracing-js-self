# Read-only remote branch triage — 18 November 2026

Remote snapshot: **2026-11-18 13:25:59 UTC**. Analysis: **2026-11-18T13:28:40.981396+00:00**.
Repository: `werg/tracing-js-self`. Frozen comparison main:
`2aa694be86a6cda3b9d63fde739957d08f568961`, tree `273944ba36271402c9f90c98cef14c1bb9ad0958`.

The snapshot contains **31 remote branch heads**, including main. The symbolic
`origin/HEAD` alias is excluded. The [remote snapshot](evidence/repository-maintenance-snapshot-2026-11-18.json)
retains exact heads and GET endpoints. The [complete triage evidence](evidence/remote-branch-triage-2026-11-18.json)
retains merge bases, full unique commit lists and subjects, stable patch IDs,
matching main commits, per-path object/mode comparisons, and focused review notes.

This report changes no remote branch, issue, comment, protection or ruleset.
No historical branch code was executed. A branch that is old or lacks a matching
commit is not automatically obsolete, safe to delete, or missing from main.

## Method and interpretation

All comparisons use the recorded commit SHAs, not moving ref names. Git objects
were obtained with a normal fetch of remote branch heads, without pruning or
changing the remote. Local refs may advance while other work continues; that
does not revise this snapshot.

1. Count unique ancestors with `git rev-list --left-right --count MAIN...HEAD`
   and locate the exact merge base. A zero branch-ahead count proves the head
   is contained in main history; it does not prove its former behavior remains.
2. Compare each unique non-merge commit with all **1,039** main non-merge
   patches using `git patch-id --stable`, with binary/full-index diffs, external
   diff disabled and rename detection disabled. `git cherry MAIN HEAD` agrees
   with every per-commit match count. Merge/empty commits without a standalone
   patch are recorded separately.
3. Compare the complete merge-base-to-head patch with main commit patches.
   This detects whole-branch squash equivalents that per-commit matching misses.
4. For net paths changed on the branch, compare exact Git object IDs and modes
   with frozen main. Record equal content, equal deletion, different current
   content, and paths absent from main separately. Later intentional edits and
   removal of obsolete trace formats can explain differences.

Whitespace-insensitive patch equivalence is historical change evidence, not a
behavioral proof. Squashes, selective salvage, context changes, renames and
merge resolutions can prevent matches. Conversely, a historically matching
patch may later be altered or reverted. **Unmatched patch IDs remain review
candidates, not automatically missing features.**

## Ten heads already contained in main history

These branches have zero commits unique to the branch head. Preserve their exact
heads and check ownership, any active review and external references before a
future archival decision. This report does not perform that decision.

| Branch | Exact head | Main-only commits |
| --- | --- | ---: |
| `audit/grounded-effects-single-witness-path` | `e032f737830d2e46930e31af950b4e61b82c10c2` | 202 |
| `docs/semantic-execution-track-invocations` | `c560d90dd06a13d34dfc91a8f09defba7daa0aac` | 199 |
| `eliminate-legacy-trace-paths-20261025` | `4b45aaddf815f9fc48f35819f9894cd4e1e8e0e1` | 70 |
| `feat/semantic-execution-followups-20261025` | `5a413868639e8532e36dbd451804ab76f905005d` | 140 |
| `feat/semantic-execution-harness-v4-20261025` | `e486399c165fcc897ec40bbb2e81d83a6f4bd9d8` | 145 |
| `fix/semantic-v3-unified-hardening-20261024` | `f2da83dd4abfe884a281457ba3db2a53ce1809bc` | 252 |
| `owned-coercion-rejection-20261022` | `1f2b7d2f4b7a76276c108e78282f16eccea22e1b` | 870 |
| `semantic-reasoning-traces-20261025` | `0894066c149be5b281784b6d9ad1cda8dcee4515` | 107 |
| `work/natlang-bounded-20261022` | `4338da3f01eb3af6c18c6120b8939ea6e40fa9a7` | 840 |
| `work/promise-reactions-20261022` | `60b8494514c47c064cef62a90ec42867cdcb4726` | 847 |

## Nine branches with patch-equivalent integration evidence

Eight entire branch deltas match a commit on main. One single-commit branch
also matches directly. Most constituent commits lack individual matches because
main contains a squash; importing them again would not follow from these counts.

| Branch | Exact branch head | Matching main commit | Evidence |
| --- | --- | --- | --- |
| `feat/common-control-updates-20261023` | `1a3a0d465478ebe0b78bc7e7233f849aed72c215` | `98e06b088e2306f24d75abdd195b268cea4bf7d0` | Cumulative patch; 16 branch-only commits |
| `feat/semantic-trace-boundary-foundations-20261024` | `f4966c052c5ba7cb2b03656d237a6e19c966e8d2` | `ed3666c12270bca9a17e7c4ed580f6ff4f347099` | Single commit and cumulative patch |
| `fix/corpus-last-96-20261023` | `0f9a6d04c0f3d80857fff7243e0a8e02849ff96b` | `855f9f61645eaf16a3c3ce320224bbd6183d21fe` | Cumulative patch; 24 branch-only commits |
| `fix/corpus-rest-spread-complete-20261023` | `a369a26174856ed3bb60e069d245392e792a3d0f` | `570c8274cb2688e6e4a04756d219c54dffa1f14c` | Cumulative patch; 14 branch-only commits |
| `fix/corpus-trace-capabilities-20261023` | `d6827a9aa23059806cbe6d87c8d5217acf6803b2` | `94251276321604f1974eeb4db40f647902fe4055` | Cumulative patch; 6 branch-only commits |
| `fix/corpus-verified-traces-20261023` | `a90ff81b0f032235c92135e8bf7ef4122094a8cf` | `643b660f56ca460034d430b10c398b2d9597fbaf` | Cumulative patch; 47 branch-only commits |
| `fix/host-journal-integrity-20261022` | `adf1354e3e0aa3e1cf9564cfb3df6cc50505373d` | `9eb4d0cb7587551d3cc15b6ca39ab21b529b5173` | Cumulative patch; 15 branch-only commits |
| `fix/owned-array-sort-corpus-20261023` | `55ef645f63e8038cdaa2d6632d674160b10d90fb` | `0fc4bb3d15c9e39e9f00976960973311d67713c3` | Cumulative patch; 4 branch-only commits |
| `fix/salvage-pr9-pr11-integrity-20261023` | `dc96914512d63351a567396bb481f1c2808d091d` | `9e2b9c4f771ebc97df23454cc7e2b37b9bd9c621` | Cumulative patch; 6 branch-only commits |

## Four historical branches requiring content review

| Branch | Exact head | Unique commits | Focused finding |
| --- | --- | ---: | --- |
| `feat/semantic-choice-reasoning-20261025` | `b103d28cbaed1834c4b3938d892ce5d3b01d96a1` | 1 | One historical v3 readability document; its path is absent from current main. Review narrative intent against current v5 documentation. |
| `feat/spec-oracle-test262-baseline` | `bbbadb9321e922fa955128c030ba7dbf5a9378be` | 13 | Current oracle, selected Test262 runner and dependency lock already exist through different commits. A complete old-branch semantic equivalence claim was not made. |
| `fix/register-owned-template-substitution-20261023` | `c7e9c9a22c4540407cc8dc35cbe8b51543e5f2ad` | 1 | Main already registers template.substitute, version1, as primitive. This branch proposes algorithm; the different kind explains the unmatched patch. |
| `fix/remaining-corpus-classes-20261023` | `d7622455aa8d195ba36bdf5800ccaa2f6206b2fa` | 22 | 15 of17 changed files match main commit570c827 after rest/spread integration. Two differ; current main later evolves/removes old training paths. |

The template registration is present through main commit
`f2bf22d3763c9f9814ccb1ed976a08b4d7a12f40`. Reapplying the old branch would
change its declared operation kind; lack of a patch match is not a missing
registration. The remaining-corpus branch differs from historical main
`570c8274cb2688e6e4a04756d219c54dffa1f14c` only in
`src/semantic/normalize.js` and `src/training/causal-audit.js` among its 17
changed paths. That is substantial content integration evidence, but not an
assertion that every historical detail should be retained in v5.

The oracle branch predates the current independent oracle boundary and locked
installation. Issue [#13](https://github.com/werg/tracing-js-self/issues/13)
was **open** in the snapshot. Its isolated manifest/lock and lock-enforcing
installation are present on the frozen main through commits
`d9a8cbe` and `d1d7b1a`; full SHAs and file hashes are in the evidence. The
lock contains the exact engine262 dependency with integrity metadata. The
current spec workflow uses `npm ci --prefix tools/spec-oracle`, without
`--package-lock=false`. No issue closure or claim of a newly executed CI pass
follows from this code inspection.

## Seven current-session branches

These heads were created or updated during the active 18 November work. Review
them after their intended integration finishes. They are not classified as stale
merely because their ancestry differs from the recorded main head. The table
lists main-only and branch-only commit counts; full patches, merge commits and
content comparisons are retained in the JSON evidence.

| Branch | Exact observed head | Main-only | Branch-only |
| --- | --- | ---: | ---: |
| `codex/real-source-semantics-20261118` | `f0ff9c9c9a04a899b7bc99d23cdde90a6308bf4c` | 33 | 67 |
| `codex/release-integrity-20261118` | `90510a7eb9e1f48b3622decce64df058ca11ccd1` | 33 | 24 |
| `codex/resumption-20261118` | `8a41f1a739fb78bc0383d1a01309d81ea83a97b9` | 2 | 10 |
| `codex/resumption-completion-20261118` | `58dd347f3f29c044bd2fd4b872c8f1c727fe2899` | 33 | 77 |
| `codex/resumption-integrity-20261118` | `237becbb3f1016db399eacf9cc07d2fda58bdd8b` | 33 | 57 |
| `codex/resumption-learning-20261118` | `977cafbe1031015fe5e70d3f655b7752ece17b30` | 33 | 14 |
| `codex/resumption-semantics-20261118` | `095da723b254fdf1c8748ca7a1c1bc6fc1466021` | 33 | 6 |

In particular, the current resumption branch can advance while this report is
written. Its observed head is not a claim about a later pull-request head. The
single remaining branch is the frozen `main` baseline stated above; all 31
snapshot heads are therefore accounted for.

## Follow-through

Use [RELEASE_GATES.md](RELEASE_GATES.md) for the intended merge/release checks.
A maintainer can later verify intended integration, outstanding reviews and
external references before authorizing archival. If a missing behavior is
actually demonstrated, port a bounded fix with current tests; do not restore an
old production exporter merely to eliminate a patch difference.

No branch deletion, issue closure, outgoing message, protection change or
ruleset change was part of this triage. No new corpus, native qualification,
optimizer run or model result is claimed.
