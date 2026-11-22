# Paired durable request crash and acknowledgement repair

This candidate preserves the published semantic/coordinator protocol and adds explicit controls for the remaining publication and ownership boundaries.

The producer journal repairs only a private temporary inode with exactly one official matching final intent, or a never-linked private temporary. Extra aliases and foreign destinations remain refused. Direct ordinal inspection performs cleanup before checking link count; independently read files and directories are fsynced. `maxLogBytes` bounds aggregate immutable intent bytes (64 MiB by default), separately from `maxBytes` per intent and `maxRequests` per scope.

Once producer admission starts, any missing acknowledgement stops the live selector. Attempt evidence retains the exact request identity for ordinal discovery, but no storage receipt is invented. A fresh process may inspect the immutable slot; if native never admitted it, explicit recovery refuses without selection replay or commit dispatch. Busy calls must refuse before changing local attempt or coordinator history.

Repeated coordinator acknowledgements reuse only receipt objects independently verified in that live transport. Caller-supplied accepted labels or rehashed restored receipts do not enter the private verification set. Explicit durable recovery may mark its one independently verified target; older unverified durable history refuses before another intent is published. Ordinary restored history continues to require native RPC verification.

Native candidate81ad96df212fe7ba70f876d57f8719a37bef79cc repairs intent, outcome and superseded-marker hardlink cuts. Its trusted inherited descriptor check also refuses released/unheld ownership instead of silently reacquiring it. Current scope remains trusted owner-private local Linux storage and an explicit native commit boundary. Generic host/composite takeover, distributed ownership and ambiguous native outcomes remain outside this primitive.

The isolated hosted workflow runs real subprocess crash controls, actual Python producer/native recovery, ordinary transport regressions, zero-skip JUnit validation, Ruff and immutable checkout checks. This file describes the candidate; its result must be read from the exact run and subsequent retained evidence, not assumed from implementation.
