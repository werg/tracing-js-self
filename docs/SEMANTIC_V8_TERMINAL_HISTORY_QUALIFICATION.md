# Actual-model terminal-history qualification

`tools/qualify-v8-terminal-history.mjs` exercises durable cancellation with the
existing actual-model serving bundle and one dedicated native session per
scenario. It does not train or modify model weights. The tool derives the
initial request from the original source artifact's observed public prefix and
requires its parsed structure to equal the supplied request. That source
artifact is used only for request derivation before rollout. Source
correspondence, projection and replay are rechecked after the model record has
been selected and acknowledged.

Each scenario starts from the same producer-derived first request and records
one actual model selection. The ordinary selected driver validates the
original bytes and provenance, commits the record to the host state, and
requires the native commit receipt before history advances. The scenarios then
exercise three terminal outcomes:

| Scenario | Durable head | Native cancellation | Expected recovery |
| --- | --- | --- | --- |
| `closed-after-accepted` | Requested and closed markers both acknowledged | Positive native close receipt | `closed` |
| `requested-head-ack-lost` | Requested marker is fsynced independently; callback response is lost | Native cancel is never called | `requested` |
| `cancel-rpc-transport-died` | Requested and unknown markers both acknowledged | Cancel request is started, then the process transport is terminated before a close receipt returns | `unknown` |

For every case, a new Node process receives the initial position-one packet and
the independently read latest application head. It calls
`RegionSelectedModelDriver.restoreLatest` with tripwires on native initialize,
restore, checkpoint, selection, commit, cancel, and host service access. A
terminal disposition must return with every counter at zero. A shortened,
tampered, or omitted terminal head is not substituted by scanning the journal;
the head file is the sole application-supplied authority.

The transport-death case deliberately does not claim that the remote model
closed successfully. It starts the real native cancel RPC, kills the process
transport before a receipt can be returned, and requires an `unknown`
disposition without a positive `closeReceipt`. The lost-head-ack case is
separate: its requested marker reaches the fsynced external head, while the
callback throws before native cancellation can begin. The driver retains its
previous local head in that case.

If the actual first model output is malformed or refused, the tool writes the
full returned or provenance-bound refusal evidence and fails the positive
accepted-record requirement. It does not repair the record or turn the
selection failure into a cancellation success. A completed qualification
records the original selected record bytes, selection provenance, host/native
accepted cut, full terminal snapshot and chain, transport metrics, service
profile when the service could write one, and source/projection/replay
rechecks. Cumulative cost snapshots are saved in full; the scenario report
subtracts accepted-cut costs before reporting later RPC and compute deltas.
Peak memory is a maximum, not an additive cost.

Run it against a clean producer checkout and a clean paired consumer checkout:

```sh
node tools/qualify-v8-terminal-history.mjs \
  --megatoken /path/to/megatoken \
  --python /path/to/megatoken-venv/bin/python \
  --served /path/to/fitted-served-bundle \
  --source /path/to/original-source.json \
  --request /path/to/selection-request.json \
  --out /path/to/new-evidence-directory \
  --max-tokens 18 \
  --seed 17
```

The output directory must be new and outside both checkouts. It contains one
subdirectory per scenario with the exact older packet, accepted checkpoint,
full acknowledged history, external head bytes, terminal disposition, fresh
process gate output, actual record and selection evidence, runtime cost
snapshots, and the original service profile when available. The root report
states `heldoutTested: false`, `generalizationEstablished: false`, and
`completeSourceExecution: false`. These controls qualify terminal authority
and recovery ordering; they do not measure model quality.
