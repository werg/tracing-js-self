# Frozen bootstrap gate reached its CI job wall-time limit

Run **45032886414**, job **137240150945**, ended with GitHub conclusion
`cancelled` at the configured 35-minute job limit. No agent requested
cancellation or edited that run. Its exact source pair remains:

- Producer `e5d53e47b39ccc1699db6da0c6f53bb703b3dce2`.
- Native `56cce3b80423b0cb70c3a096d867561066e3a211`.

The native JUnit proves **151 passed, zero failures/errors/skips**, in 334.081
seconds. The producer phase ran from 14:38:33 to 15:06:52 UTC, then was
cancelled. Its JUnit contains only a 52-byte XML opening header, and the raw log
has no producer case events because that reporter buffered them. The completed
and unfinished producer populations are therefore **unknown**. This is not a
170-case pass, and it must not be reported as zero completed cases either.

The preceding `ae5` run had 166 passes and four fixture startup failures in its
170-case producer population, with 1069.418485 summed case seconds. Its native
phase took 253.312 seconds; the same 151 native cases took 334.081 seconds here.
The corrected wrappers also allow the later-child positive cases to execute
their full work instead of failing at startup. These observations establish
that CI wall time needs separate treatment from semantic execution bounds;
they do not identify which producer cases completed in this cancelled run.

Workflow-only successor
`4371410e0026a5c70246b484f99b01da3994a6fb` changes only the investigation
workflow. It explicitly checks out and asserts the **same producer `e5` and
native `56c` source pair**, requires the same 151 native and 170 producer cases,
and uses a finite 60-minute CI job limit. Streaming spec output and separate
JUnit output retain visible progress even if another CI interruption occurs.
The workflow also publishes both checkout identities and its own revision.
Production caps, individual test deadlines, semantic/model bounds, and all
source/test implementation bytes remain unchanged. That new run requires its
own observed result; this archive makes no claim about it.

The retained `host-bootstrap-history.xml` is intentionally incomplete evidence,
not a valid report. `manifest.json` records its exact bytes and hashes alongside
the complete native report, compressed raw job log, ZIP digest, and successor
identity. Earlier failed gates and the wrapper invocation proof remain in
`../v8-bootstrap-fixture-correction-20261122/`.
