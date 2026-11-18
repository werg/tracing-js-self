# Linux reference isolation and resumable campaign ownership

The independent source reference can execute outside the owned JavaScript
frontend. `node:vm` is therefore never treated as a security boundary. The
optional `linux-namespace/1` profile confines the entire native reference
process, including its original-source, operation-instrumented and
branch-instrumented runs.

```sh
TMPDIR=/absolute/writable/temporary/directory \
  node tools/generate-effectful-training.mjs --recipe generated-v1 \
  --reference-isolation linux-namespace --jobs 2 --out corpus/out/isolated

# For an admitted export, rechecking uses the same isolation policy.
# Native admission additionally requires the usual pinned consumer options.
TRACING_REFERENCE_ISOLATION=linux-namespace \
  node tools/verify-effectful-admission.mjs /path/to/admitted-example.json

node --test test/reference-isolation.test.js
```

The default `trusted-process` mode still accepts reviewed authored and pinned
sources only. Enabling reference isolation does not authorize arbitrary source
through the owned teacher, native consumer, or acquisition tooling. It protects
the specific native-reference boundary. No public learner schema changes.

## Enforced boundary

The launcher uses unprivileged Linux user, mount, network, IPC, UTS and PID
namespaces. It builds a private root beneath the selected writable temporary
directory. Only the exact Node executable, runtime libraries, source modules,
operation catalog, package metadata, parser dependencies and reference worker
are mounted into it. These mounts are read only. The host workspace, repository
history, home directories, datasets and credentials are absent.

The root is read only, with a separate 64 MiB temporary filesystem. A scrubbed
environment carries only `PATH`, `TMPDIR`, `LANG`, `LC_ALL` and `TZ`. The source
receives no credential, proxy, `NODE_OPTIONS` or Python-injection environment.
The reference runs as PID 1 in its own PID namespace, with every capability set
cleared and `no_new_privs` enabled.

A seccomp filter denies socket creation and networking, process creation,
namespace and mount changes, ptrace and cross-process memory calls, kernel
keyrings, module loading and other kernel-control interfaces. Node's required
threads remain supported. The network namespace has no configured external
interface even before seccomp is applied.

The kernel enforces a 1 GiB virtual address-space bound, a CPU limit derived
from the reference deadline, a 64 MiB file-size bound, 64 file descriptors and
zero core-file size. Node runs with `--jitless` and a 256 MiB V8 heap bound; JIT
disablement avoids the executable CodeRange reservation that otherwise makes
the address-space limit impractical. The parent independently enforces wall
time and output-byte limits. The private temporary filesystem is an additional
bounded kernel allocation; the address-space limit is not presented as a
measurement of peak resident memory.

Setup requires Linux, usable unprivileged namespaces, util-linux `unshare` and
`mount`, Python 3 and libseccomp. There is no privileged fallback and no silent
fallback to `trusted-process`. Missing isolation primitives yield explicit
reference-isolation failures. The profile, launcher hash, runtime configuration
and reference policy are part of candidate/campaign identity, so an ordinary
cached receipt cannot be reused after changing modes.

The regression test probes the OS boundary directly through Node's filesystem,
network and process APIs, verifies actual `/proc` capability/seccomp/resource
state, and checks a complete locally verified episode with original and
instrumented references. On a host that disallows namespace creation, that
integration test reports an explicit skip. A skipped test does not qualify an
isolated release on that host.

## Campaign durability

Campaign storage requires the operating system's `flock` utility. One writer
holds a lock on an inherited file description for the lifetime of the store.
The kernel releases that lock on normal close or process death; there is no
stale PID-file deletion race. Concurrent generation or materialization against
the same directory fails immediately. Do not remove `.campaign.lock` while a
campaign may be active, because the lock belongs to that stable inode.

The append-only log is fsynced with its directory. Torn tails are preserved and
trimmed durably on resume. Every committed entry rechecks its source/input/
fixture objects, candidate digest, result status, attempt number and hash-chain
predecessor before reuse. Cancelled work is incomplete and is retried by plain
`--resume`; actual semantic refusals remain cached unless `--retry-failures` is
explicitly requested. The manifest reports coordinator and worker peak RSS
separately. Those individual peaks are not a simultaneous process-tree total.
Generation throughput includes process startup, native-environment inspection,
source construction and registry freezing. `preparationMs` and `collectionMs`
partition that elapsed time; final manifest publication and process exit occur
after the recorded measurement. Reused admissions do not count as newly
generated learner tokens.

Global source registries can be copied into verified, deeply immutable views.
Only those internally branded views reuse their verified digest and indexed
family lookup. Mutable inputs, shallowly frozen objects and caller-supplied
digests still undergo full content verification. This avoids repeatedly hashing
megabytes of unchanged provenance during candidate expansion without making
object identity an authority for mutable evidence.
