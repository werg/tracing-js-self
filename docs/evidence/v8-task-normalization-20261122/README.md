# Original-task normalization correspondence

This isolated review begins at producer `7c20124f3d89dfe1a8d5e892238e7b7f92589720` (tree `13a2497fdd19ca5de94c86ba24a54f04251e808f`). The original input fixture is encoded and decoded through the real generation boundary, then executed through the source or module producer. The binding helper is checked against that actual result. These controls perform no native admission, optimizer update, or model qualification.

## Initial controlled result

The unchanged helper produced **25 leaves: 7 passed, 18 failed, 0 skipped**. Seventeen failures demonstrate source/task normalization disagreement. One failure came from an invalid positive test fixture: importing a namespace and reading a statically known property did not activate the direct namespace profile, and the producer itself rejected null custody. That initial result and test source are preserved verbatim under `initial-red/`; it is not counted as a product defect.

The confirmed differences cover ordinary source null refusal and falsy fixture defaults, ordinary versus protocol ancestry aliases, inherited/random RNG disagreement, session seed/session-ID defaults and component ancestry, module nullable plan switches, and mixed host-protocol custody. Correction and subsequent exact results will be added as later increments.
