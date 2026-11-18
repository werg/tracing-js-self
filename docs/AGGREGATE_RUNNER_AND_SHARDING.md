# Aggregate runner and deterministic generation shards

These tools extend the existing worker, source registry and CampaignStore.
They do not replace per-worker cancellation, immutable admission receipts,
global splitting, native preparation or release packaging.

## Current qualification

The [recorded host preflight](evidence/aggregate-runner-preflight-20261118.json)
is **unavailable**, with no workload launched. This workspace does not expose
a cgroup-v2 filesystem, its ordinary scratch directory is not a dedicated
capped filesystem, and the user systemd manager is inaccessible. No aggregate
kernel-exhaustion test or reproducible image qualification was possible here.
`profiles/release-environment.lock.json` retains `containerDigest: null`; this
work does not invent an image identity or upgrade historical qualification.

The existing V8 heap limit covers each worker's JavaScript heap. Detached
worker process groups support cancellation, and CampaignStore authenticates
and fsyncs completed attempts. None of these is an aggregate CPU, memory,
process/thread-count or filesystem-space limit.

## Fail-closed Linux runner

`tools/aggregate-campaign-runner.mjs` uses a transient systemd service with:

| Resource | Requested kernel/runner mechanism |
| --- | --- |
| CPU rate | `CPUQuota` and `CPUQuotaPeriodSec`, read back as `cpu.max` |
| Aggregate memory | `MemoryMax` plus zero swap, read back as `memory.max` and `memory.swap.max` |
| Processes and threads | `TasksMax`, read back as `pids.max` |
| Writable output | An existing dedicated tmpfs workspace with measured total capacity within the declared budget |
| Temporary files | A separate size-limited `/tmp` tmpfs |
| Other regular filesystems | `ProtectSystem=strict` and additional API-mount restrictions, verified from in-unit mountinfo |
| Deadline and descendants | `RuntimeMaxSec`, `KillMode=control-group`, `OOMPolicy=kill` and group termination |

The child launcher reads the actual cgroup membership and effective limit files
**inside the service before starting the requested executable**. It verifies
the workspace and temporary filesystem capacities, rejects other writable
regular filesystems, and checks that effective capabilities are empty and
`NoNewPrivs` is set. This is necessary because some systemd sandbox settings can
be unavailable on a host. A successful preflight alone grants no qualification.

There is no polling-only or per-worker fallback. An unavailable manager,
ordinary uncapped output directory, missing controller, unenforced property,
extra writable filesystem, or failed readiness check refuses the launch.
CPU quota is a rate ceiling; the wall-time limit supplies the separate duration
bound. Memory accounting includes memory-backed output and file cache, rather
than pretending to be only the sum of process RSS.

The workspace mount must be provisioned by the runner operator before use.
This tool does not mount filesystems, request administrator access, change
repository settings, pull images, or claim arbitrary-code isolation. Its
initial scope is reviewed pinned-source workloads on a qualified Linux host.
The host mount topology must remain fixed during a run. Socket families are
restricted and standard streams are the only inherited workload descriptors.

```sh
# A read-only prerequisite check. Exit 2 means unavailable.
node tools/aggregate-campaign-runner.mjs --preflight \
  --workspace /var/lib/tracing-campaign-quota \
  --receipt /path/to/aggregate-preflight.json

# On a separately provisioned and qualified host:
node tools/aggregate-campaign-runner.mjs \
  --workspace /var/lib/tracing-campaign-quota \
  --budget /path/to/aggregate-budget.json \
  --receipt /path/to/aggregate-result.json \
  -- /absolute/path/to/node /absolute/path/to/tools/generate-effectful-training.mjs \
  --out /var/lib/tracing-campaign-quota/campaign --jobs 4 --limit 100
```

The budget JSON has exactly these fields (the defaults shown here are a
configuration, not a qualified production capacity):

```json
{
  "cpus": 2,
  "memoryBytes": 2147483648,
  "pids": 128,
  "workspaceBytes": 536870912,
  "temporaryBytes": 67108864,
  "wallTimeMs": 3600000
}
```

The outer supervisor retains its readiness receipt, bounded-workspace stdout
and stderr logs, and available systemd result/resource properties. Existing
fsynced campaign records remain on the operator-owned workspace mount after a
service failure. A normal `--resume` recovers a torn final append using the
existing CampaignStore rules. No successful attempt is rewritten. Keep the
workspace mounted until the existing archive/restore workflow has copied it to
durable storage: tmpfs persistence across a process failure is not persistence
across a host reboot.

Host qualification still requires real exhaustion probes for memory, PID,
disk and deadline behavior, process-tree cleanup, recovery of a campaign
prefix, and an actual pinned runtime/image receipt. The local tests establish
budget construction, mount parsing and fail-closed behavior, not those absent
kernel measurements.

## Frozen global-registry sharding

`src/corpus/generation-shards.mjs` and `tools/generation-shards.mjs` add a
production-candidate work partition. Existing Test262 sharding remains a
separate native-reference diagnostic.

The plan includes one validated global source registry, the current producer
and environment identity, exact encoded tasks, a stable inventory digest,
frozen component/split assignments, and a deterministic hash assignment to
shards. Reordering enumeration does not change the plan. Changing source bytes,
arguments, source family, runtime identity, limits, registry, or a shard
assignment invalidates it. Changing shard count changes the work partition but
retains the same inventory identity.

Workers use the existing canonical graph transport, independent admission path
and atomic CampaignStore. Every attempt—including failures, cancellations and
retries—remains in its shard's authenticated log. A cancelled or incomplete
shard cannot produce a complete merged receipt. Resume reuses successful
receipts and finishes missing work; it does not reconstruct a new source split.

```sh
node tools/freeze-source-registry.mjs --out /path/to/registry.json
node tools/generation-shards.mjs plan --registry /path/to/registry.json \
  --recipe engineering --shards 2 --limit 4 --out /path/to/plan.json

node tools/generation-shards.mjs run --plan /path/to/plan.json --index 0 \
  --directory /path/to/runs/shard-0 --out /path/to/receipt-0.json
node tools/generation-shards.mjs run --plan /path/to/plan.json --index 1 \
  --directory /path/to/runs/shard-1 --out /path/to/receipt-1.json
node tools/generation-shards.mjs merge --plan /path/to/plan.json \
  --directory /path/to/runs --out /path/to/merged.json
```

The CLI recomputes the current producer source-tree/runtime identity before
running a shard. Create a new plan after code or environment changes. The
initial CLI supports local source qualification; the API additionally requires
the actual pinned native configuration when the plan declares a native policy.
Neither mode infers native admission from a successful local reference run.

Merge reloads and verifies each original CampaignStore, requires every planned
shard/candidate exactly once, checks the frozen task and split, and retains all
attempt evidence references. It reports exact-public duplicates globally;
**native deduplication and final preparation must still run after merge**.
Sharding never grants a release-admission shortcut.

For a control, create another plan from the same producer, registry, recipe and
limits with `--shards 1`, run it, and compare the merged reports:

```sh
node tools/generation-shards.mjs compare --single /path/to/single-merged.json \
  --sharded /path/to/merged.json --out /path/to/equivalence.json
```

The comparison checks final dispositions, public target digests, independent
reference/certification identities, and component/split assignments. It excludes
measured worker timing/RSS, log order and retry histories, which remain retained
in the reports. A mismatch is reported rather than silently normalized away.

Tests run actual one-shard and two-shard generation over the same small source
population, including a refusal; verify equal semantic identities; and interrupt
then resume a campaign without changing its committed prefix or repeating
successful attempts. They also reject missing/duplicate shards, source changes
and altered splits.

## Mechanism references

- [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html)
- [systemd filesystem and privilege controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
