# Source-visible deterministic random input for the pinned corpus

The original VS Code `quickSelect` source uses `Math.random()` to select its
pivot. The existing real-source native benchmark pins a deterministic V8
fixture generator with seed **42** and the recurrence
`state = (1664525 * state + 1013904223) mod 2^32`, returning
`state / 2^32`. This is a declared test input, **not** a claim that all
ambient JavaScript randomness has been modeled.

The bounded owned machine now accepts an **explicit** unsigned 32-bit random
seed. Its serializable control state records every advance, and the public
observed source context includes the seed. Only **direct, zero-argument**
`Math.random()` call syntax is accepted. Unseeded calls, aliasing, computed
property references and additional parameters fail closed. The independent
V8 reference is initialized separately from the same fixture seed for final
observable graph checks and source operation/control audits. Exact replay
rebuilds each PRNG transition from the declared seed instead of trusting
recorded future results.

The serving controller independently checks each generated random value
against the public seed and advancing state, atomically rejecting forged
values. This is a narrow deterministic corpus fixture, not hidden native
entropy or a V8 fallback supplying interpreter operations.

**Evidence:** The 12 pinned `arrays.ts/quickSelect` invocations independently
passed owned execution, source-level operation/control audits, exact replay,
controller rollout and post-serialization recheck. The prior complete
corpus baseline was 924/936 locally verified; with these 12 cases the
expected new result is **936/936**, pending full GitHub CI.

All resulting `semantic-execution/2` episodes remain **locally verified
training candidates**, not admitted. The external megatoken consumer must
version and verify the new observed `randomSeed` field before any such
sample can enter training, and must not receive the private `sidecar`.
