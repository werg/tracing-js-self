# Composed original request and physical source release controls

The integrated producer source is `69c4b92db31056b8b2a26461207f7358e523b720`, tree `6834462b2c0917619154bb82ea42ddfe59e8cf5f`, paired with native `33031866fc7e2d20156a454064aeafd4ef79ccf3`, tree `443d7b3699da44d21fb6381ad325330aaedeff62`. Tests ran on clean local producer commit `6b9defa02b382b03eb2b7547547d3e4ac649953d`, whose complete tree is identical to the published source; API publication changes commit metadata, not the tested tree. Both source trees were clean. The producer's native policy is unchanged from its preserved `02add9d9` parent.

## Complete measured population

- **140 executable JavaScript leaves passed, zero failures/errors/skips**, retaining all 83 selected-main leaves plus the normalization, exact-read and effective-request controls. The five-file command matches the updated hosted gate, with VM modules enabled. The Node reporter includes 15 additional parent containers; those are not counted as cases.
- **94 Python cases passed, zero failures/errors/skips**: 19 producer archive controls, 6 physical-source driver controls and 69 native verifier controls. Runtime imports use this exact native checkout via `PYTHONPATH=src:.`. The existing native controlled byte-codec training fixture is retained; this mixed population is not described as a zero-update run. It is distinct from the required 64-source, two-update ordinary package lifecycle.
- Source checkpoints before and after the controls were clean. There was no actual 64-case source qualification, package creation/restoration, learned evaluation or full language conformance run in this local group. The newly required hosted package gate must independently complete at its exact source revision.

## Local environment and original failure

Local Node is 24.22.3, Python 3.12.14 and Torch 2.10.0+cpu. Local pytest is 9.2.0 and npm 11.19.1, differing from the hosted lock's pytest8.4.2 and npm11.9.0. These local results do not claim the hosted locked runtime.

The initial JavaScript command omitted the workspace temporary-directory setting. The original 140-leaf report contains 100 passes and 40 setup failures: 37 campaign and 3 progress controls could not create a directory under unavailable `/tmp`. All original logs, XML and exit status remain byte-for-byte in `initial-no-tempdir/`. With the existing workspace `TMPDIR` and existing advisory-lock test helper explicitly supplied, the unchanged source passed all140 leaves. No product assertion, source file or gate population changed to obtain the corrected result.

The exact runtime/source identity, original and corrected reports, exit statuses and independently parsed executable counts are retained. `SHA256SUMS.json` binds every imported original output. These controls close the bounded original-request and case/physical-ID correspondence issues; all17 full product acceptance packages remain open and V6 remains the default.
