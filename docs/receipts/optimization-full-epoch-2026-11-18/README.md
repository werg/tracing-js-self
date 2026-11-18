# Actual full prepared-epoch optimization diagnostic

The final bounded CPU attempt consumed **all 32 admitted prepared examples from
29 source families and all 9,379 generated lexical targets exactly once**, in
49 actual optimizer updates. The native trainer took 636.95 seconds, below its
900-second cap. The complete-execution criterion still failed: the trained model
and its base each completed zero of four held-in tasks.

## Resolved plan and actual exposure

This run explicitly configured 16 records and 32 scored decisions per native
window. Before launching the optimizer, the actual native `WindowStream` and
the fully resolved `TrainConfig` produced `native-window-plan.json`. The plan
retains each window index, its exact record IDs, source identity, expected scored
tokens, source counts, and terminal native cursor. `--require-full-epoch`
refused launch unless it covered every prepared member and target once.

After training, actual checkpoint source counts, its complete native cursor,
and the sum of measured lexical-loss denominators matched the frozen plan
exactly. `nativeWindowPlanMatched` is true. Window order is determined by the
native deterministic cursor contract; the engine does not emit an independent
per-window-ID execution log. `sourceExposure` reports actual 32-member,
29-family exposure separately from prepared corpus membership.

This is a completed epoch over this small prepared corpus. The native P1 stage
itself remains budget-incomplete: its normal large stage budget was deliberately
capped, and the native final metric truthfully reports `termination: step_limit`.

## Same actual base, masks, optimizer, and reloads

The initial checkpoint was copied byte-for-byte from the original zero-update
base, not reconstructed from a seed. Its `state.pt` SHA-256 is
`1e72b5c00d2554a1c0d5c732d48b0cf8936ddb1c5185dc56a10959fcd34d62db`.
The native trainer's phase-start model and optimizer masters matched it exactly,
with zero initial optimizer steps or moments.

The prepared corpus had 40,690 observed tokens with zero scored positions and
9,379 generated tokens with full supervision. Actual training scored those
9,379 lexical targets. Auxiliary reconstruction losses and history-ingestion
costs are reported separately by the native metrics.

All updates had nonzero encoder, shared, and model gradient domains. 311
parameter tensors changed; 315 optimizer owners had positive update moments.
All model parameters were finite. Reloaded checkpoint tensors and both exported
served model tensors matched exactly. The initialized base served model SHA is
`4ee47430d82fc7e6065bf8319165faca3d4c0d759039a873ac5f0cdc5e469d67`;
the trained served model SHA is
`853c12ec19ccd6add5850f76773fe4a781c923cfd4e7c226a1e7fc4071484103`.

## Free-running result and limits

Both fixed checkpoints ran the same four held-in cases through the actual
selected driver and native served model, with no injected teacher selections or
private expected outcomes in the inference request. All eight attempts failed
at their first candidate action. Four failed native rendering with
`SemanticSelectionError`; four failed trace syntax validation with `TypeError`.
Original bytes, decoder token IDs, serving profiles, and private expectations
remain in the raw artifacts.

All observed integrity-gate and cleanup counters were zero. Because no first
action succeeded, these observations exercise refusal and cleanup paths rather
than successful learned effects or error handling. `optimizationSmokePassed`
remains false solely because complete held-in execution did not succeed.
This small, newly initialized, one-seed P1 model is not a production SE/SC
checkpoint or evidence of transfer. The separate frozen test-family diagnostic
uses its own report and does not change this result.

The source producer was immutable
`c4296c271eec32c2f2ab4cd34c30fd8b61e6ba39`, and the consumer was
`277edd4a2983e81f5e2a71b34a7ce29348e4e7a0`. The runner was
`8541f7060fc074a220258dd058776339d33c309d`. No later consumer fix or source release
is substituted into this provenance. `index.json` checksums the copied evidence;
`full-artifact-index.json` checksums the complete original output, including
checkpoints and served bundles retained for separate packaging.
