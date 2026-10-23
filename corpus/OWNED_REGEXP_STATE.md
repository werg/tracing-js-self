# Bounded RegExp follow-up: 36 more pinned real-source executions

The owned training profile now supports *only* two further deterministic,
exactly-pinned RegExp behaviors. It neither delegates arbitrary guest regular
expressions to native V8 nor returns hardcoded output for a corpus case.

- **VS Code `isBasicASCII` (12/12):** the exact anchored
  `/^[\\t\\n\\r\\x20-\\x7E]*$/` source literal is allocated as an owned,
  versioned RegExp identity in a static global binding. Its bounded `.test`
  scans UTF-16 code units to implement the permitted character class. The
  initial RegExp identity, source and flags are included in the *observed*
  model-visible context; the controller never invents a static object later.
- **VS Code `lcut` and `rcut` (24/24):** the exact `/\\b/g` expression
  performs owned, ASCII-word-boundary matching and updates `lastIndex`
  with versioned, source-observed property writes. Explicit guest
  `lastIndex += 1` is also a normal mutable property operation. The
  controller validates those writes from the authoritative event journal.
  No RegExp state is silently stored in a host object.

The focused 36-invocation native-provenance audit yielded **36/36 locally
verified**, with independent V8 outcomes, source operation/control evidence,
exact archive replay, public model-controller rollout and post-serialization
recheck. Locally, the entire Node regression suite passed **442/442** tests.

This raises the expected pinned full utility corpus to **876/936** locally
verified and the two-index smoke to **146/156**. The PR CI gates now enforce
both measured floors; do not report them as final until the complete six-shard
CI audit has finished. All exported episodes remain **not admitted** to any
external training system. `sidecar` contains private evidence and is never
model-visible context.

**Still unresolved:** five function families, twelve inputs each:
`quickSelect` (randomness/owned reference mismatch),
`format` and `format2` (global regexp replacement callbacks),
`escape` (callback replacement and switch control),
`containsRTL` (large Unicode character-range matcher and mutable
module initialization). These must retain explicit refusal unless their
effective computations can be independently verified and replayed.

## Further pinned owned replacement and Unicode coverage

The next change set independently checked all **48/48** invocations of
`format`, `format2`, `escape`, and `containsRTL`, in addition to the
36 RegExp cases above. Exact pinned literal patterns are scanned with bounded
owned source-ordered logic; replacement functions execute as ordinary guest
frames, with real captures, returns and traceable control flow. The pinned
Unicode matcher is parsed from source-code escape ranges, including surrogate
alternatives, rather than delegated to host RegExp.

The combined measured full-corpus target is **924/936 locally verified**
(154/156 initial two-index smoke). CI enforces these as minimum verified
thresholds; count failures and unsupported semantics rather than concealing
them. **The remaining 12 invocations are all VS Code `quickSelect`**,
which requires explicit independently reproducible `Math.random` input
and trace evidence. No generic native-V8 fallback should be introduced.

These are **locally verified owned candidate traces**, *not* admitted
megatoken episodes. The external native Episode consumer's schema has not
yet been extended for the optional `staticRegExps` observed-source metadata.
That field is omitted on ordinary episodes to preserve the existing importer
contract; the new RegExp-using episodes require an explicit versioned schema
change and end-to-end consumer tests before admission.
