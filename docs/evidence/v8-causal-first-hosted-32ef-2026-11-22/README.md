# First causal-bootstrap hosted gate: retained failure and separate guard defect

[Run 45029326909](https://github.com/werg/tracing-js-self/actions/runs/45029326909)
executed producer `32efcddadf1cb441dc32ceb8263f6c3d9049fff9` with the exact native
revision recorded in `summary.json` and `executed-workflow.yml`. All **145 native
cases passed**, zero failures/errors/skips. The producer ran **170 leaf cases:
166 passed and four failed**, zero errors/skips.

Three failures expose the zero-argument controlled-decoder replacement when the
native fixture now calls it with a final-action argument: the actual two-child
baseline, later child-create lost-reply recovery, and later child-bootstrap
lost-reply recovery. The fourth is the same mismatch in the separate
service-cancellation fixture, surfaced during cleanup as an already-closed
native process. Both replacements are corrected in the combined producer
candidate `26676d44`. They require a new exact paired hosted gate; no failed leaf
is converted to a pass by this explanation.

Separately, after this source froze, actual execution proved that two mixed
hyphen/underscore spellings of raw child bootstrap could bypass its durable
operation guard. That independently reproduced defect blocks promotion even if
this historical workflow were passing. The subsequent normalized guard and
stronger native assertion composition retain their own source identities and
must be tested separately. This 145-case native pass predates that correction.

The complete decoded job log is stored without an added newline. The original
ZIP is independently checked against GitHub's SHA-256 digest; both JUnit reports
are unmodified. `files.json` records every retained byte count and hash. The
per-file leaf inventory in `summary.json` distinguishes this 170-case population
from the later combined 193-case gate, which adds terminal and service-owned
close controls. These are overlapping engineering controls, not distinct source
programs, language conformance coverage, or learned model successes.
