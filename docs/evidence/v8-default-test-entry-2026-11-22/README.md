# Ordinary test entry and source staging regression

The full prototype workflow at producer `e8cd1475dc89648bc00e2d69afc55042bc6eece1` failed on Node 20, 22 and 24: [run 45015560555](https://github.com/werg/tracing-js-self/actions/runs/45015560555). Each job reported 2,742 tests, 2,706 passes, nine failures and 27 skips. The complete original logs are retained unchanged after decompression (jobs 137187331903, 137187331678 and 137187332174 respectively).

Eight failures came from original-module reference controls reaching `vm.SourceTextModule` through ordinary `npm test` without its required `--experimental-vm-modules` flag. The dedicated module gates already enabled that flag. Both ordinary `test` and `test:semantic-v8` now enable it; no case is removed or skipped.

The ninth failure was an obsolete fault-injection boundary. The staging optimization deliberately stopped deep-cloning every private historical context during publication. The atomicity test still tried to fail that removed deep clone, so it observed no exception. It now injects one failure at the actual append-only index allocation in `commitPrepared`, after the detached transition succeeds. It requires the entire live prefix to remain identical after the failure, then commits successfully and confirms that a subsequent fork sees the committed index. Production staging code is unchanged.

The three directly affected test files passed locally with the required VM module flag and actual paired native runtime: **21 leaf cases, zero failures/errors/skips**, 43.707 seconds. `focused.xml` retains the complete JUnit result. The full ordinary Node 20/22/24 matrix must still rerun at the correction commit; the focused result is not a whole-suite pass.
