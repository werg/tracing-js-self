# References, objects and collection semantics — issue #51

Working implementation record for <https://github.com/werg/tracing-js-self/issues/51>.
The paired consumer is <https://github.com/werg/megatoken>. This document records
what is actually implemented and checked; the umbrella issue remains open until
its broader construction, Proxy, collection and interaction work is complete.

## Starting point

- Producer main: `f7696e63258913e7bb8a450c67a708b70c3232ee`.
- Consumer main: `b432f97` (the merged Promise-object follow-up).
- Working branch in both repositories: `codex/issue-51-object-semantics`.
- No open PR existed in either repository when this work began.
- Current Promise reflection support is already present. Extend the same runtime,
  source projection, public trace and independent native checker in place.
- Learned execution and model training are deferred by the current direction in
  issue #48; ordinary source/native checks and data preparation remain in scope.

## Implementation checklist

- [ ] Carry ordinary inherited property existence through a shared `property.has`
  operation, including symbols, accessors without getter invocation, prototype
  traversal, absent versus undefined values, and authenticated source operands.
- [ ] Extend owned `Reflect.has` and check target validation/key conversion order.
- [ ] Support deletion and addition during ordinary `for…in`: retain the captured
  candidate sequence, skip deleted candidates, preserve inherited fallback, and
  never repeat a completed cursor. Keep unsupported prototype/enumerability
  mutations explicit rather than claiming a native result without evidence.
- [ ] Mirror these transitions in the independent consumer, with forged result,
  receiver, key and restored-state refusal tests.
- [ ] Exercise original-source/native agreement, replay, interrupted restoration,
  and affected ordinary preparation/contract paths across both repositories.
- [ ] Regenerate current affected contracts/data and record exact test receipts.
- [ ] Document remaining method/interaction gaps and continuation commands in
  both PRs, without describing partial umbrella coverage as completion.

## Recovery and coordination

Commit completed increments and push them promptly. The PR descriptions and
checkpoint comments are the durable work log; this file records implementation
decisions that need to survive a session interruption. Do not overwrite another
working tree or reset uncommitted changes from another contributor.

The producer runtime and its structural validator, the public semantic/source
path, and the native consumer must agree. Tests must independently execute
original source and must not accept unsupported execution as a guest exception.

Initial useful commands (run from the producer):

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test test/training-for-in.test.js test/semantic-protocol-enumeration-v8.test.js
node --experimental-vm-modules --test test/semantic-protocol-enumeration-source-v8.test.js
npm run contracts:check
```

All results below must be attributed to their actual code and inputs. Starting
point observations above are not verification of later changes.
