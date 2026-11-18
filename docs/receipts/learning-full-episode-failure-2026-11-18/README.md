# Full-episode native training attempt: interrupted

This separate exploratory declaration attempted to expose all 32 admitted
training episodes through the pinned native optimizer. The native pre-update
plan verified exactly one scored window per episode, using the supported
`max_window_records: 256` and `scored_decisions: 256` settings. The largest
episode contained 6,825 transcript tokens. The declared checkpoint was step 32,
and the training wall limit was 900 seconds.

**The actual training child exited with signal 9 (SIGKILL) after two logged
optimizer updates and 913 supervised lexical tokens.** The updates took about
8 and 37 seconds respectively. The process was not stopped by the 900-second
timeout. Kernel OOM counters were unavailable, so the exact cause of the
SIGKILL is not established by this receipt. A resource problem is plausible,
but the receipt makes no proven-OOM claim.

No trained checkpoint was saved after those two updates. Only initialization
and the exact phase-start checkpoint were durable. No trained serving export,
held-in rollout, held-out comparison, or learning success exists for this
attempt. A complete pre-training window plan is not measured exposure.

[report.json](report.json), [training.log](training.log), and
[training/metrics.jsonl](training/metrics.jsonl) are the original unmodified
failure evidence. The older runner's top-level `optimizerSteps: 0` had not yet
been replaced by its end-of-training verification; the two completed updates
are visible in the original metrics. [partial-training-recheck.json](partial-training-recheck.json)
is an explicitly labeled subsequent extraction distinguishing observed updates
from durable checkpoints. Later runner versions record this distinction on the
failure path directly. The original failed report remains unchanged.

The frozen experiment SHA-256 was
`30d6fafb57dfa9a31c33dd9d960949274e5a0821c8f2735dee1dfc22752c187d`.
The producer and consumer were the same immutable versions as the original
64-step diagnostic. Every selected export was freshly source/native checked
during preparation. [index.json](index.json) binds the copied originals.

A follow-up declaration reduced the supported window bounds to 32 records and
16 decisions, with 56 native windows planned for one complete epoch over the
same 32 episodes. It has a different frozen hash and its own output directory;
its result must be reported separately. It cannot turn this interrupted attempt
into a successful training or coverage result.
