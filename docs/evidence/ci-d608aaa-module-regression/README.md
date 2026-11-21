# Preserved hosted module-regression evidence

Producer `d608aaa4c76ade9bc54e00892ce2ff11a558324f`, workflow
[44944824666](https://github.com/werg/tracing-js-self/actions/runs/44944824666).
All three Node jobs failed the same stale assertion at
`test/test262-original-runner.test.js:233`: the original module's static live-cell
reads no longer need a namespace object after the imported-name scanner repair.
Original execution and independent reference assertions had already passed.

| Node | Job | Complete suite disposition |
| --- | --- | --- |
| 20 | 136969795350 | 2,459 pass, one fail, eight skips |
| 22 | 136969795088 | 2,459 pass, one fail, eight skips |
| 24 | 136969795695 | Original complete job log retained below |

The correction preserves every original source assertion, explicitly checks that
static reads receive no namespace-constructor capability, and adds a separate
real namespace observation using prototype, extensibility and key inspection.
That case verifies the capability belongs only to generated module source, with
structural validation, exact replay, JSON restoration and independent native
execution. It does not establish public/native namespace admission.

`manifest.json` gives compressed and uncompressed SHA-256 checksums for the exact
decoded logs returned by GitHub. Use Python's `lzma.decompress` or `xz -dc` to
read them. Failed historical results remain failed; new results must name their
own measured source revision.
