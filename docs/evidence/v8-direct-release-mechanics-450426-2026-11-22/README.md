# Direct V8 package/restore mechanics run 450426

This is a compact record of the successful package/restore mechanics run. It is **not** a current-pair qualification: it predates the original task-to-artifact binding check, and its native source predates the latest consumer pin. The original GitHub artifact remains available; this directory intentionally stores only compact reports and source/artifact metadata, not the 349 MB wrapper ZIP, the 350 MB inner tar, training/model weights or checkpoint bytes.

- Run `45042619619`, job `137270202685`, conclusion `success`.
- Producer `596a3b8e61011dcfd38fcf28ff5bef4cb6242975`, tree `8fd526d8e7804d79fd0205e5b2086051130bc5b9`.
- Native `d4afac5bb7261aa7ef85c1d65d3ae6dcaf6caeef`, tree `3e6d58624f5557bb5b4877a260e504a572dd90a4`.
- The outer artifact was 349,298,043 bytes, SHA-256 `a0c829a0b2d7548a256103eecee7a42e01711d2ebdd9826adb45eb87878f2a96`; inner tar was 350,012,196 bytes, SHA-256 `41652e86625b90a785d904a6be8a7e34b0cf11296898d2148637c701c4a50b5f`.
- The release-control JUnits had 25 Node leaves and 79 Python leaves, with zero failures, errors or skips.
- The qualification selected and admitted 64 sources with a 48/12/4 split. The ordinary lifecycle made two optimizer updates; packaging and restoration made zero. Full target coverage remained false, learned success was null, and live history recovery was unmeasured.
- Package archive was 70,579,166 bytes, SHA-256 `b6b1c8abbf280b01e4b86a60cfb3e4a654f7cdfe898103fb8399fca74739eb6c`. Restore verified 351 files / 303,143,185 bytes. Both native reports bind the global-step-2 checkpoint and served export; 64 source artifacts and 64 prepared episodes were retained. The manifest includes the zero-byte `source-qualification/progress/.campaign.lock`.

## Binding boundary

The retained snapshot and exact file inventory establish campaign attempt/file authority, but producer `596a3b8` did not run `bind-original-64-source-tasks`. The qualification result has no `originalTaskArtifactBindingsVerified` field. Consequently this run is mechanics-only evidence and must not be described as task-to-original-artifact or record-binding qualification.

A later post-binding run `45044587251` on producer `790f525c280b34a66ef8269aa7148bd9966b8639` and the same older native `d4afac5...` succeeded; its output reported `originalTaskArtifactBindingsVerified=true`, 64 sources, two lifecycle updates and zero package/restore updates. The final main-pair package run `45045811024` at producer `7c20124f3d89dfe1a8d5e892238e7b7f92589720` with policy-pinned native `ddda9a7339297e6074765a001743e2bb569e0eb9` passed the task-binding/history step but was still running source qualification/package/restore at last observation. The associated combined recovery/Promise run `45045811229` had structural and Promise jobs passed, with terminal, commit, bootstrap and transport lanes not yet all complete.

`manifest.json` binds the exact retained compact files by artifact member path, byte length and SHA-256, along with the source pair, workflow artifact metadata, job-log hashes and qualification limits.
