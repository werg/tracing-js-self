# V8 release driver: case labels and physical source IDs

This focused correction changes the package qualification driver’s final binding assertion. A task/case `id` is a logical label; the dataset registry `sourceId` may be a distinct digest-suffixed physical identity. The driver now joins verifier snapshot cases to qualification rows by case label, then checks that each binding uses that row’s exact physical ID and the registry’s unique membership and split. Missing, duplicate, unknown, or mismatched identities fail closed.

The previous expression compared `taskArtifactBinding.membership.sourceId` directly with the case `id`. The positive unit control demonstrates that this old condition is false for a valid `case-label` / `case-label:<digest>` pair. It then passes the new validator. Additional controls reject a substituted physical ID, a wrong case label, a missing binding, duplicate case rows, and two case labels claiming one physical source.

## Validation

- `python3 -m unittest tools/native-consumer/test_release_task_binding_driver.py`: 6 tests passed.
- `node --test --test-concurrency=1 test/v8-release-task-binding.test.js`: 55 Node tests passed; retained JUnit has 46 testcase elements, 0 failures/errors/skips. This existing suite includes source and module correspondence controls. The clean evidence checkout used a temporary symlink to the already installed `acorn` and `typescript` dependencies; the link was removed after the run.
- `python3 -m py_compile tools/qualify-v8-release.py tools/native-consumer/test_release_task_binding_driver.py`: passed.

The new pure Python controls do not run source qualification, native admission, or optimizer work. This evidence does not claim a complete 64-source campaign or a fresh native qualification.

## Workflow integration still required

The existing release workflow’s Python JUnit command explicitly selects `test_release_v8.py` and the native verifier suite (19 + 69 = 88 leaves). To execute the new six driver controls in CI, include `test_release_task_binding_driver.py` in that command and require 94 leaves (25 producer-side + 69 native verifier). This change deliberately does not modify the package workflow. The separate Node campaign count remains 83 for the current workflow source.
