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
outcomes, checkpoint files, logs, and actual costs are preserved in the final
receipt below. A lower training loss alone cannot pass the
execution gate; one memorized input cannot pass the 32-example or generalization
gates even if it completes.

The actual [native preflight](preflight-verification.json) subsequently verified
that the exported base and every initial parameter hash match the prior
initialized base exactly. The [native window plan](native-window-plan.json)
contains exactly one complete 48-token episode window; 256 updates would score
12,288 lexical tokens. [train-config.json](train-config.json) preserves the
unchanged resolved native settings. This preflight is not an optimizer or
execution outcome.


## Completed bounded result

The attempt completed all **256 real native optimizer updates** in
**1,097.5930905050009 seconds**, below the frozen 1,200-second cap. The native
SIGTERM checkpoint grace was not invoked. It supervised **12,288 lexical
tokens**, and the authenticated cursor records exactly **one source visited
256 times**, each visit covering its complete native episode window. The
checkpoint and served reload checks passed; 311 parameter tensors changed.
This remains one input and one independent component.

| Final paired held-in measurement | Fixed initialized base | Trained checkpoint 256 |
| --- | ---: | ---: |
| Complete execution | 0 / 1 | 0 / 1 |
| Valid complete trace | 0 / 1 | 0 / 1 |
| Original decoder tokens | 171 | 59 |
| Measured evaluation wall seconds | 9.33247691 | 7.12829539 |
| Cost per correct task | Undefined | Undefined |

The base's first selected model record failed trace JSON parsing. The trained
model's first native selection was refused because it did not render a complete
valid text action. Every original fragment byte (hex) and emitted token ID is
retained in the result and profile artifacts, including the failed selection.
Both token totals are complete, rather than unlabelled lower bounds. Neither
arm completed a canonical trace. All complete integrity receipts record zero
false admissions, leaked future observations, replay-native effects,
unauthorized effects, and untracked fallback; that is not execution success.

The first and last logged lexical losses were 12.148270924886068 and
11.060638427734375. These are optimizer objective measurements on the repeated
input, not task accuracy. The observed loss reduction did not yield even one
complete generated execution. P1 used its existing full learning rate of
`0.0002` throughout. No held-out tasks were executed, no checkpoint was chosen
using a held-out score, and no automatic extension or further attempt was run.

The initialized base still has the exact previously declared model digest.
The actual trained model SHA-256 is
`5fd090759a4e8667ceef041476af3465a98941be9add3ddacec914e0516d7c50`.
The full [summary](summary.json), unchanged [native report](report.json),
[optimizer verification](optimizer-verification.json), and
[original artifact index](index.json) retain the measured results. The
[post-run pointer check](final-pointer-verification.json) independently verifies
the latest metadata, state, and transducer file checksums; the original native
report separately verifies payload reload and authenticated source cursors.
The first and last native metric lines are copied byte-for-byte. Full original
metrics, checkpoints, served bundles, and prepared records are retained in the
separate private archive.

The narrow memorization execution gate failed. The 32-example optimization
smoke also cannot pass from a one-input diagnostic, and no generalization
claim follows. This result does not establish that longer training or a
suitable pretrained base cannot work; it establishes the outcome of this one
specified bounded attempt. The previous full-coverage 32-source experiment and
its held-out and pure-output results remain unchanged.
