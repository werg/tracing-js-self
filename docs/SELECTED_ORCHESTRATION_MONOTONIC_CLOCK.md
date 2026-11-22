# Same-boot orchestration deadline receipts

`createSelectedOrchestrationExecutionClock()` issues a JSON-safe receipt for a pending
orchestration fence. The receipt binds the issuing Linux boot UUID, the current
Linux time namespace, the monotonic timestamp, the elapsed budget already
consumed, and the unchanged timeout. A fresh process can add the monotonic time
since that fence only when it is in the same boot and time namespace. Reboot,
namespace change, changed timeout, backwards time, malformed data, or an
expired budget refuses recovery.

Capture samples `process.hrtime.bigint()` before asynchronously reading Linux
identity files. Its required synchronous callback computes elapsed budget at
that sampled monotonic instant. Since the receipt timestamp precedes those
reads, their time and every later delay are charged on resume. Keep the receipt
inside the independently acknowledged pending history cut; its unkeyed digest
detects accidental mutation, while the journal/head authority protects the
retained cut. This primitive does not provide a distributed lease or prove the
outcome of a native or host operation.
