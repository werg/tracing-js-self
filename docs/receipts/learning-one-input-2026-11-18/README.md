# One-input memorization diagnostic

This is a separate, prospectively frozen convergence question: can repeated
complete-episode native optimization teach canonical selected-trace framing
and completion on one fixed admitted training input? It is not the 32-example
optimization smoke and supplies no held-out or generalization evidence.

The exact candidate is `flag-intersection-pure`, independently selected as the
shortest of all 43 admitted training candidates by actual native generated-token
count, with identity digest as the deterministic tie-break. It has 48 generated
tokens and identity
`569898a9c261c570ad0464bf942316169c04ebf516614b94a29feb81052625c7`.
Its source, replay, effects, and immutable admission identity were freshly
rechecked against the original producer. The candidate inventory and exact
receipt are retained in [the frozen declaration](frozen-experiment.json), whose
SHA-256 is
`fd224cb60e9922a05b6b7f40a2a9a9fe75378ade64412d8d3562ada672ee972c`.

The attempt is limited to 256 native P1 updates and 1,200 seconds, with complete
episode windows capped at 32 records and 16 decisions, one actual window per
update. It uses the original producer `dac57b1`, consumer `277edd4`, immutable
runner `1cdf23c`, the same initialization seed 17, optimizer seed 17, and exact
expected initialized model identity
`4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`.
All native optimizer, objective, decoder, and teacher contracts remain unchanged.
P1 uses its existing full peak learning rate; no warmup or unsupported optimizer
patch is introduced. The exact prepared window plan and actual source exposure
must agree before the repeated-input result can be interpreted.

Only final fixed-base and trained held-in selected execution is measured, with
128 tokens per native fragment and 120 seconds per arm. The declaration retains
validation/test membership for the existing frozen-schema contract, but those
cohorts will not be executed, ranked, or used for tuning in this diagnostic.
There is no automatic step or wall-time extension. The previously completed
56-update, 32-source trial and its frozen held-out score remain unchanged.

At declaration publication, no optimizer result is claimed. Original final
outcomes, checkpoint files, logs, actual costs, and any interruption will be
preserved in a later receipt. A lower training loss alone cannot pass the
execution gate; one memorized input cannot pass the 32-example or generalization
gates even if it completes.
