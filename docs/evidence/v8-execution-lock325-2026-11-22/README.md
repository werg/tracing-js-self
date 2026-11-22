# Process-lifetime execution lock: actual cross-process evidence

Exact producer `325145dc32b2515cf176d1dd6da6c47a85cb20e8` passed
[run 45002354342](https://github.com/werg/tracing-js-self/actions/runs/45002354342),
job 137146437955, on Ubuntu 24.04 with util-linux flock 2.39.3.

All six individual controls passed with zero skips: separate-process exclusion
and explicit release; SIGKILL release with stable inode; a child retaining the
same locked open-file description after supervisor release; independent
session/stream namespaces; missing-helper and symlink refusal; and refusal of
a group/world-writable helper. An additional public-entry check verified all
eight existing/new storage exports remained available.

The source/export blob is an exact append to the prior main storage entry.
An erroneous uncommitted intermediate export blob was rejected during review
and never entered the candidate. The checked helper must be an absolute trusted
executable owned by root or the current user, without group/world write access.
No lock inode is unlinked or replaced, and no TTL/PID test grants ownership.

This is a trusted-local Linux storage prerequisite. It is not wired into
orchestration restore authorization and does not establish native request
outcomes, acknowledged history, complete post-state recovery, distributed
ownership or permission to replay a pending child. A fresh process's zero
pending count remains insufficient evidence about its predecessor.

`full-pass.log` is the complete successful hosted log. `index.json` records
the exact implementation/test file identities and explicit scope limits.
