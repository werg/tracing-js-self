# Service outcome synchronization race

An independent actual-I/O review reproduced an outcome durability gap in the
original `DurableSelectedServiceJournal.read`. The old reader is identified by
Git blob `14629fa22f00270f976540a9b9665b9d2bba4a2b`; the initial strict fenced
journal was reviewed from this increment's working tree.

The retained [before output](outcome-sync-before.json) is the original probe's
unchanged stdout. Its ordering is deliberate:

1. The winner's service claim is durably acknowledged.
2. The duplicate's claim is also acknowledged, including its directory sync.
3. The winner links its outcome and pauses before the outcome directory sync.
4. The duplicate reads the newly visible outcome.
5. The probe injects `EIO` into outcome-directory synchronization for both writer
   and reader, then lets the writer fail its acknowledgement.

The original basic reader returned the result with **zero** directory
synchronizations after the outcome link. The strict fenced reader attempted a
new synchronization and refused the result on `EIO`. The basic reader now does
the same. A previous claim acknowledgement cannot durably acknowledge a future
outcome link.

The independent [after output](outcome-sync-after.json) records both readers
refusing the result with `EIO`, each after attempting one reader directory sync.
The publisher acknowledgement also fails in both cases. The original before
output is retained separately rather than replaced by the successful control.

The [portable probe](outcome-sync-probe.mjs) retains the original I/O interception
and ordering, with only repository-relative imports and the system temporary
directory substituted for workspace-specific paths. The regression in
`test/semantic-durable-service-v8.test.js` additionally runs this ordering through
both actual service wrappers in isolated processes. It checks that both callers
refuse the unacknowledged result and that, once synchronization recovers, a fresh
wrapper returns the retained result with exactly one original service call.

The final [service integration log](service-integration.log) records **83/83
passing tests**, with zero failures, cancellations or skips, in 3,037.103904 ms.
It covers the new fence controls, both service wrappers and the affected durable
action/host recovery, lifecycle, region receipt, selected-intent and harness
continuity tests. Its SHA-256 is
`34ca84b5e8ffba42b9f5f25f7eae97e05441872b5966d66bc7cc21fc0a39803c`.
The [evidence manifest](evidence.json) retains the exact command, base revision,
scoped working-tree provenance, service/test byte identities and all artifact
hashes. This measurement is not a claim about a clean full-repository or paired
consumer run.

```sh
node docs/evidence/service-fence/outcome-sync-probe.mjs
node --test test/semantic-service-fence-v8.test.js \
  test/semantic-durable-service-v8.test.js
```

These are controlled POSIX service-boundary and failure-injection results. They
do not demonstrate arbitrary remote transaction rollback, production deployment,
or cancellation of work already admitted by a service fence.
