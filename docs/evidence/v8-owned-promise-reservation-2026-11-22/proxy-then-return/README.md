# Proxy `then` lookup review

This is a read-only targeted review of Promise resolution with a Proxy `get`
trap for `then`. The producer source snapshot was taken before the first
reproduction and is retained as `producer-full-working-diff.patch` plus the
four copied source files. The HEAD, dirty status, and source hashes are in
`native-script.txt`; the source hashes still match the copied files after all
three runs. The worktree was at producer HEAD
`3b5e36c9f5f8e97d9e188635d1ddd98d65444601` with uncommitted moduleworker changes.

The exact runs and raw stdout are:

- `reproduce_proxy_then_return.mjs` / `original-command.txt` /
  `captured-toolstdout.log`: an async entry returning the Proxy was refused
  because there was no separately supported non-entry async function.
- `reproduce_proxy_then_return_nested.mjs` /
  `new-repro-command.txt` / `new-repro-captured-toolstdout.log`: the native
  JavaScript baseline resolved the Proxy thenable to `9`; protocol compilation
  refused it with `Protocol v8: ordinary object or owned closure required`.
  The source helper reaches ordinary descriptor resolution for the Proxy, and
  that API rejects Proxy heap nodes rather than silently treating a trap as an
  absent `then` property.
- `new-repro-promise-then-alias.mjs` /
  `new-repro-promise-then-alias-command.txt` /
  `new-repro-promise-then-alias-stdout.log`: the native baseline observed the
  overridden Promise `then` and resolved to `9`; the owned runtime refused the
  aliased `Object.defineProperty` mutation with `Unsupported property receiver`
  before protocol compilation.

No test accepted the Proxy thenable or the aliased mutation. These refusals
support the current boundary; they do not establish behavior for unsupported
source forms or every possible mutation route. No source was edited and no
broad tests were run.
