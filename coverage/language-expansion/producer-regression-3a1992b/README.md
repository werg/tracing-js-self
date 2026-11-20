# Frozen producer regression at 3a1992b

Producer commit: [`3a1992b4462e8e2affa6baa04e9075ba3b01d04a`](https://github.com/werg/tracing-js-self/commit/3a1992b4462e8e2affa6baa04e9075ba3b01d04a).
Full Git tree: `903da3860401f5f1a174a933ac03a8c5ae558b1a`. Runtime: Node `v24.22.3`, npm `11.19.1`.

This is the full producer regression after the shared Promise resolver repair and direct/nested abrupt Number callback support. It records the exact implementation revision above. Later Number catch/finally, model-serving and study-tool changes require their own evidence. This receipt does not establish independent consumer admission, model accuracy or serving performance.

## Results

| Check | Command | Result | Elapsed |
| --- | --- | --- | --- |
| Full Node regression | `node --test --test-concurrency=4 test/*.test.js` | 1,800 tests: 1,794 passed, six skipped, zero failed or cancelled | 422.662 s |
| Generated contracts | `npm run contracts:check` | Five of five checks passed | 22.338 s |
| Reference fixture | `node fixtures/reference/reference-fixture.mjs` | Eight of eight checks passed | 0.153 s |

All commands exited with code zero. The run started at `2026-11-20T16:36:15.736545+00:00` and finished at `2026-11-20T16:43:41.630603+00:00`; total elapsed time was 445.492 seconds. `TMPDIR` was explicitly set to `/workspace/scratch/754a49249d01/producer-validation-tmp`.

## Conditional skips

All six skips remain skips. One requires exact external consumer/tokenizer paths; five require a configured served native orchestration environment. They are not counted as passes. Separate native and serving qualifications have their own pins and scope.

- actual pinned ByteCodec reproduces the frozen gallery and meters exact v7/context bytes — Exact external consumer/tokenizer paths were not supplied
- native compact coordinator runs async, callback and throwing children in one process with exact whole-task receipts — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native bounded context resumes the exact captured cell despite compact callback history — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native coordinator budget cancellation leaves no selected guest, effect, or live track — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- native rejected semantic child preserves its committed bytes and cancels its waiting parent — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates
- actual initialized-weight native coordinator preserves rejected bytes and token costs with no fixture fallback — Set MEGATOKEN_ORCHESTRATION_SERVED, MEGATOKEN_PYTHON and MEGATOKEN_REPOSITORY for native runtime gates

The original [summary](summary.json) is retained byte for byte. Its `skipLines` collector recognizes TAP `# SKIP`, while this run used the Node spec reporter. The independently extracted [skip inventory](skip-lines.json) identifies all six raw log lines and binds the log SHA-256; the summary's numeric footer counts already record all six skips.

## Identity and retained evidence

The detached worktree kept the same commit, full Git tree, top-level tree/blob identities and empty tracked-change status before and after every command. No implementation file changed during validation.

- [Code manifest](code-manifest.json): 722 tracked Git blob identities across source, tests, tools, scripts, entry points, fixtures and package definitions.
- [Test inventory](test-files.json): all 295 files selected by `test/*.test.js`.
- [Summary](summary.json): exact commands, runtime, UTC timings, counts, Git identities and stdout/stderr hashes.
- [Validation runner](run_validation.py): the original command and receipt collection procedure.
- [File inventory](files.json): SHA-256 and byte counts for all retained files except the inventory and checksum file.
- [Checksums](SHA256SUMS): the complete package except the checksum file itself.

| Command | Standard output | Standard error |
| --- | --- | --- |
| unit | [unit.stdout.log](unit.stdout.log) | [unit.stderr.log](unit.stderr.log) |
| contracts | [contracts.stdout.log](contracts.stdout.log) | [contracts.stderr.log](contracts.stderr.log) |
| reference | [reference.stdout.log](reference.stdout.log) | [reference.stderr.log](reference.stderr.log) |

## Interrupted predecessor

The earlier run at producer `f2fc6302f00fe5dc270964fb864e702f6b081686` was interrupted with exit code 130 when the synchronized abrupt Number changes arrived. Its raw summary, inventories and partial logs are preserved in [the history archive](interrupted-f2fc630.tar.gz), with exact archive/member hashes in [the history manifest](interrupted-f2fc630.json). No full-suite result is inferred from that partial output. Its counts are not combined with the completed regression above.
