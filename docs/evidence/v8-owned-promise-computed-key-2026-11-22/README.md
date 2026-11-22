# Owned Promise computed-key repro

This is a single targeted differential reproduction of the owned-then lookup guard. It is evidence only; no producer or native source files are changed in this commit.

## Source and run identity

The pre-run snapshot records producer HEAD `53b478b76071d0fdc3d5e5dd21de1f7dd2d4c502`, tree `62e1b47b4f9eb7205ea11e03079cb39ec7d47b0f`, and `git archive` SHA-256 `56490fcb329fcc65fde325de1aeabbba65bdf95f837a667fad479e68f6edfbf5`. Native HEAD was `c192da5cd55f7a6380a89d497142441df456c04d`, tree `acc6b3dc0e634cc6f23c3127d85082ff390aec28`, archive SHA-256 `8ba993d99ad01533372857fe918a4087227452ccc18852a5f07648f5541f9a66`. Pre-run tracked diffs were empty. The producer status also showed pre-existing untracked evidence and `node_modules` directories.

The runner used Node `v24.22.3`. It imports code from `/workspace/scratch/9faed68167fb/async-return-producer`. The source worktree advanced to `385e762211d55448b6cac3d6d5a298d482e93681` around the evidence capture. The post-run snapshot and source hashes show the changed tree consists of evidence files and the three relevant producer source/test files have the same SHA-256 before and after. The exact Git HEAD at process launch was not recorded, so this bundle pins the pre-run snapshot plus unchanged relevant-file hashes rather than claiming a contemporaneous full-tree identity.

## Input and observed result

`computed-key-case.js` defines `thenKey` as the string `"then"`, then calls `Object.defineProperty(p, thenKey, ...)` on an owned Promise. The getter and returned then function append `g` and `t`; the adopted promise handler appends `2`.

The runner executes the same input in ordinary Node and through the producer’s `createRuntime` and `compileProtocolSourceV8` path. Ordinary Node returns `"gt2"`. The source adapter and producer projection both report `accepted`; the producer outcome is a guest `TypeError` with message `Object.defineProperty requires an owned ordinary object`, and it emits no async-resolution protocol events. This is an accepted source projection that disagrees with the ordinary Node result.

Raw stdout is retained in `raw-output.txt`; `process-exit-code.txt` records zero for the runner process. `pre-run/` and `post-run/` preserve full tracked-tree manifests, archive hashes, status/diff snapshots, and relevant source-file hashes.

## Reproduction command

From the workspace, run:

```sh
node /workspace/scratch/9faed68167fb/owned-promise-computed-key-review/run-computed-key-repro.mjs
```

The runner is preserved byte-for-byte as used for the captured result. `SHA256SUMS` covers every file in this evidence directory except itself.
