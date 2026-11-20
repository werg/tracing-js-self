# Frozen producer regression

Producer commit: [`b66c19be960f114b69787746b2487e6f23a73577`](https://github.com/werg/tracing-js-self/commit/b66c19be960f114b69787746b2487e6f23a73577).
Full Git tree: `447832396b33feea21d39c8d2b7b54b1a5659dc3`. Runtime: Node `v24.22.3`.

This receipt records the full local producer regression, generated-contract checks, and eight native reference-fixture checks after the graph receipt repair. It is engineering validation of this exact implementation revision. It does not establish model accuracy or end-to-end independent consumer admission.

## Results

| Check | Command | Result | Elapsed |
| --- | --- | --- | --- |
| Full Node regression | `node --test --test-concurrency=4 test/*.test.js` | 1784 tests: 1778 passed, 6 skipped, 0 failed, 0 cancelled | 551.257 s |
| Generated contracts | `npm run contracts:check` | 5 of 5 checks passed | 27.557 s |
| Reference fixture | `node fixtures/reference/reference-fixture.mjs` | 8 of 8 checks passed | 0.129 s |

All commands exited with code 0. The run started at `2026-11-20T13:08:51.322092+00:00` and finished at `2026-11-20T13:18:30.812044+00:00`. Total elapsed time was 579.086 seconds. `TMPDIR` was explicitly set to `/workspace/scratch/1d835fe8168d/tmp`.

## Conditional skips

The skipped checks remain skipped in this receipt. The first requires exact external consumer/tokenizer paths; the other five require a configured served native orchestration environment. Separate native qualification receipts, if provided, are independent evidence.

- actual pinned ByteCodec reproduces the frozen gallery and meters exact v7/context bytes — Exact external consumer/tokenizer paths were not supplied
- native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native bounded context resumes the exact captured cell despite compact callback history — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native coordinator budget cancellation leaves no selected guest, effect, or live track — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native rejected semantic child preserves its committed bytes and cancels its waiting parent — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- actual initialized-weight native coordinator preserves rejected bytes and token costs with no fixture fallback — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates

## Identity and retained evidence

The detached worktree retained the same commit, full Git tree, top-level tree/blob identities, and empty tracked-change status before and after every command. No implementation files changed during validation.

- Source tree: `470d249806c89c314b127c8c22972c0999d012b8`.
- Test tree: `5813de34225719d4bb395dba8771398d7868f0df`.
- Tool tree: `1c1c2e043dea1c43a54b4cf31cf64cf81c12b0ea`.
- [Code manifest](code-manifest.json): 720 tracked Git blob identities across source, tests, tools, scripts, entry points, fixtures, and package definitions.
- [Test inventory](test-files.json): all 294 files selected by `test/*.test.js`.
- [Summary](summary.json): exact commands, runtime, UTC timings, results, skip details, Git identities, and stdout/stderr SHA-256 hashes.
- [File inventory](files.json): SHA-256 and byte counts for the retained files, excluding the inventory itself.
- [Validation runner](run_validation.py): the command and receipt collection procedure.

| Command | Standard output | Standard error |
| --- | --- | --- |
| unit | [unit.stdout.log](unit.stdout.log) | [unit.stderr.log](unit.stderr.log) |
| contracts | [contracts.stdout.log](contracts.stdout.log) | [contracts.stderr.log](contracts.stderr.log) |
| reference | [reference.stdout.log](reference.stdout.log) | [reference.stderr.log](reference.stderr.log) |

An earlier local run at `d0a4fe5` predates the graph receipt repair. This evidence set records the repaired commit shown above; its results are not reassigned to a later revision.
