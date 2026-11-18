# Supported smaller windows: 900-second cap reached

This independently frozen attempt reduced native training windows to 32 records
and 16 decisions. The real pinned native plan required 56 scored windows for a
complete epoch over the same 32 admitted episodes. The frozen experiment SHA-256
was `c1d64b8bae519938ab717e2ed59ecf5b0009353c96b62210515ccdc5869d5c6f`.

**54 of 56 real optimizer updates completed before the 900-second process cap.**
The native metrics record 16,786 supervised lexical tokens; the last completed
update had a native elapsed time of 877.0246186660024 seconds. The next update
was still running when the wrapper's original 900-second subprocess timeout
terminated it. No memory-related termination was observed in this attempt.

No trained checkpoint was durable: the latest pointer still referenced the
exact zero-update phase-start checkpoint. Therefore these observations do not
establish a restored trained model, complete 32-episode training exposure, or
any selected execution result. The pre-update native plan is a schedule, not a
checkpoint exposure receipt. Observed updates must not be confused with weights
that survived interruption.

[report.json](report.json), [partial-training-receipt.json](partial-training-receipt.json),
[train-config.json](train-config.json), and [native-window-plan.json](native-window-plan.json)
are unmodified originals. The first and last native update lines are also copied
byte-for-byte. [training-metrics-extract.json](training-metrics-extract.json)
retains each of the 54 updates' measured gradients, losses, denominators,
counters, and times, explicitly as a derived extract. [index.json](index.json)
pins the full original logs and metrics retained in the private follow-up archive.

This result demonstrated that the smaller supported windows could run beyond
the first full-episode attempt's SIGKILL, but the original time budget was too
short to finish the epoch. It does not establish that more bounded CPU time is
impossible. A subsequent **new** prospective declaration increased the cap to
1,500 seconds before launching the same 56-window plan from the same initialized
base. Its hash is `550f7d516d4f177067cd2c3d0d7324cd4ad1c8545f34d5d47515c54ed2960530`.
The original declaration and failed run remain unchanged.

The later runner also reserves up to 30 seconds inside its wall budget for the
pinned native SIGTERM handler to save a paused checkpoint. That reliability fix
was not retroactively applied to this already-running 900-second attempt.
