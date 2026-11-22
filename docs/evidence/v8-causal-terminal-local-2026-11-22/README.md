# Causal child bootstrap and service-owned terminal close: local composition

The current composed producer passed **82 individual structural/builder/history
cases**, zero failures, errors or skips, in 122.583 seconds at local source
`4196057a`. The complete two-reporter output is retained. This population uses
controlled Node peers to inspect reconstruction and immutable application
history. It does not establish actual Python runtime behavior or Linux-clock
recovery. The interrupted earlier invocation has an incomplete 52-byte JUnit
header; no case count is claimed for it. A separate eight-case journal diagnostic
passed using the trusted copied `flock` binary. That diagnostic overlaps the
82-case population and is not added to it.

The current implementation composes the canonical causal child-bootstrap API
from `ae5fa0f1` with the terminal-close source from `5fc8e9e6`, the corrected
cancellation fixture, and service-owned close implementation `70643ebf`. It uses
only `durable-bootstrap-child` and `recover-bootstrap-child`, with the matching
child-bootstrap request/outcome/receipt schemas. Terminal close retains its own
exact immutable operation. Publication attempts fence transport authority even
when append/readback acknowledgement is lost. Known close recovery can return
only a nonresumable closed disposition.

Review reproduced a real implementation error in the service extension: the
recovery builder still required an absent service owner. Correction `b820fb85`
removes that stale restriction while retaining exact owner/session/reason/fence
validation. Its direct five-case builder suite includes service-owned success,
repeated reconstruction and missing/substituted/changed fence refusals. The
initial red output, corrected output, dependency setup error, optional-discovery
skips and mandatory-gate local refusal are retained under `service/`. No real
service effect is executed by those fixtures; actual service journals establish
only same-owner terminal fencing and its independent verification.

The earlier actual-native development controls in this directory use a distinct
API/source pair and are not claimed as current-source qualification:

- `ab247b37` (same executed source tree as local `2429dbe8`) paired with native
  `622c37c2`: 18 transport cases passed, zero failures/errors/skips.
- Earlier later-child development at `0cd9fa3b` with native `622c37c2`: 11 builder
  cases plus one actual two-child baseline passed; two real-clock loss/recovery
  cases skipped. The baseline preserves 11 selections, seven coordinator and
  four child selections, and 13 durable native requests.

These cohorts overlap and are never summed as new semantic source populations.
Full composition requires a newly frozen native source, actual Python transport
controls and complete Linux-clock history with every required case exercised.
The local host cannot supply genuine `/proc/self/ns/time` authority. Optional
ordinary test discovery skips unconfigured paired runtimes, while required
hosted flags refuse missing runtimes or clocks. Neither mechanism substitutes
clock authority, accepts unknown outcomes, or demonstrates learned quality.

`summary.json` records distinct source/runtime identities; `files.json` records
immutable hashes for every retained evidence file. The complete original failed
terminal hosted gate is retained separately in
[the original 55-native/95-producer report](../v8-terminal-hosted-5fc8-2026-11-22/README.md).
