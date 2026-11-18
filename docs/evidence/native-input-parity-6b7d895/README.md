# First repaired input comparison

The [hosted job](https://github.com/werg/tracing-js-self/actions/runs/44381362527/job/135074150829) passed at producer checkout `6b7d895e79469a9ea0e4d9dfb1c850f957c918f5` and companion `548ab7eb32a1a4bbc9071f429c49ef5f1b778188`.

`candidate.json` and `native-input-parity.json` are the original downloaded artifact bytes. `provenance.json` retains the archive checksum, individual file checksums and hosted job identity. The local-only candidate and its source receipt contain a null producer revision; that field has not been filled in after the fact. The workflow explicitly checks out its pull-request head, which supplies the separate execution identity.

Both paths supplied two identical observed records, the same 580-byte framed instruction and the same declared execution purpose. Capture stopped before neural execution: tokenizer IDs, recurrent state and conditional distributions were unmeasured; model selections and optimizer updates were zero. This is not native admission or a learned-execution result.

Later changes also align physical context announcements. This receipt remains evidence for its original pair of revisions and must not be rebound to a later consumer.
