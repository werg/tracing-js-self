# Complete original population and installed cache failure

The complete original population ran at producer
`25c8beb67d199451d57ae9a27625923c66f37ef2`, with the producer's committed native
policy. The exact checked-out consumer revision is retained in the full job log.

- Workflow: <https://github.com/werg/tracing-js-self/actions/runs/44963053549>
- Job: <https://github.com/werg/tracing-js-self/actions/runs/44963053549/job/137025965890>
- All **665/665** original cases passed source qualification, independent native
  admission, exact token measurement, and native packing.
- Flat measurement: **247,731 generated tokens**, including **214,539 detailed
  tokens (86.6016%)**, **7,642 terminal tokens**, and **8,706,372 observed/context
  tokens**. All 665 cases were measured; none was removed from the denominator.
- Native packing: **23,655 physical / 8,992 logical records**, **247,731 generated
  tokens**, **9,476,914 observed tokens**, and **zero packed terminal tokens**.
- The installed-package command then failed with `ENOTCACHED` while resolving
  Acorn during offline dependency archive retrieval. It did not reach the
  isolated application install or run the installed 665/66 case populations.
  This is a failed workflow, not an installed-package pass. Learned execution,
  serving cost, and default promotion remain unqualified.

`all665-installed-failure.log.gz.b64` is the complete decoded GitHub job log,
UTF-8 encoded, gzip compressed with `mtime=0`, and Base64 wrapped at 100 columns.
`SHA256.json` binds both the encoded file and its decoded log. No failure lines
or earlier successful measurements were removed. This log is permanent repository
evidence; it is not the entire multi-file Actions artifact.

The original Actions archive contains 5,338 files, is **678,392,079 bytes**, and
has SHA-256
`e2392fc836766a149c81676a9244c4763e390e0a5b642efd59ec2a2205171877`.
Its artifact ID is `14731554355`, and its retention is **30 days**:
<https://github.com/werg/tracing-js-self/actions/runs/44963053549/artifacts/14731554355>.
The archive was not downloaded into the disk-limited local checkout; the hash
and size above are reported by the upload step, not independently remeasured.

The correction retrieves each exact locked tarball URL through npm's supported
offline interface. It avoids the package-name metadata lookup while preserving
the lock's archive integrity. The isolated-cache regression seeds only a tiny
tarball, stops its local HTTP server, then performs offline archive retrieval
and the separate application install with another initially empty cache. Missing,
altered and truncated bytes refuse; dependency trees and lock evidence still
match the actual archives. The complete focused tooling selection passes **8/8**,
zero skips; `installed-cache-fix-8.log.gz.b64` retains the full rerun.

A new clean published revision must pass the complete installed gate before
that acceptance condition is closed.
