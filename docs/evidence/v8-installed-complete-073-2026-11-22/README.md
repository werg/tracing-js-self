# Complete installed V8 source and recovery qualification

The independent installed-package job **succeeded** at exact producer
`073870f0d6df912c79799956c09d5a5cc0c903a4`:
[run 44970930401, job 137051362704](https://github.com/werg/tracing-js-self/actions/runs/44970930401/job/137051362704).

Both unchanged declared populations completed:

| Population | Declared | Attempted | Source-qualified | Unqualified | Untested |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original | 665 | 665 | 665 | 0 | 0 |
| Interoperability | 66 | 66 | 66 | 0 | 0 |

The two populations overlap and are not summed as distinct cases. The gate
installs the package and its exact locked dependencies, blocks legacy public
entry imports, runs original-source/public checks, serializes/restores public
checkpoints, and performs ordinary live continuation against exact saved rows.
Both previously failing callback-owned join cases remain in the population and
pass after the complete-batch comparison correction.

The complete retained report says `coverageComplete:true`, `native:"untested"`
and `model:"untested"`. This result is installed source and recovery evidence;
it is not independent native admission or learned execution. Those gates are
separate. Earlier failed complete runs remain preserved without relabeling.

The Actions archive is [artifact 14734565262](https://github.com/werg/tracing-js-self/actions/runs/44970930401/artifacts/14734565262),
644,643,777 bytes. Its upload-reported SHA-256 is
`e4e035c7cb4cb05aff72a282a51ffe157261a28c8549121cee3b2d91040f2ed5`.
It has 30-day retention and was not downloaded or independently rehashed here.
The full text log is permanently retained in this directory.

Decode base64 and decompress gzip to recover the full 124,501-byte job log,
SHA-256 `4573c3abf8c4843cc707613b96bed70a16f3454587e5ca1a60c572d003e52693`.
`SHA256.json` binds both encoded-file and decoded-log bytes.
