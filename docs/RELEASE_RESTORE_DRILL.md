# Private release restore and replay drill

`tools/restore-semantic-release.py` adds a restore/read/replay stage to the
existing private release verifier. It supports the gzip archives with schema
`semantic-private-release/1` produced by `package-semantic-release.py`.
It creates a new local directory and a separate receipt. It does not publish a
release, edit historical admissions, or create a newly qualified dataset.

## Inputs and source replay

Use the exact original archive, an independently retained archive SHA-256,
and a clean checkout of the release's original `producerRevision`. Install
that producer's locked Node dependencies before starting. The original
producer remains external to the restored archive; archived files are data
and are never installed or executed as verifier code.

Run the restorer from a checkout containing these tools:

```sh
python3 tools/restore-semantic-release.py \
  --archive /data/original/semantic-v5-release.tar.gz \
  --archive-sha256 ORIGINAL_SHA256_FROM_RETAINED_RECEIPT \
  --tracer-root /checkouts/exact-original-producer \
  --out /data/drills/new-restore-directory
```

The output directory must not exist; its parent must already exist. The
archive digest is a required input, so a different self-consistent archive
cannot silently replace the retained release. A checksum calculated only
from an untrusted replacement is not independent identity evidence.

The driver first bounds and verifies the complete archive without extracting
paths. It reuses `verify_archive` for every inventory entry, byte length,
content checksum, and the release identity digest. It rejects noncanonical
paths, traversal, duplicate members, symbolic links, hard links, sparse files,
and special files. Defaults are 2 GiB compressed, 8 GiB expanded, 512 MiB per
member, and 100,000 files. The corresponding `--max-archive-bytes`,
`--max-unpacked-bytes`, `--max-member-bytes`, and `--max-files` options allow
explicit bounds for another declared release. JSON metadata remains bounded.

Extraction copies only regular files into the new tree, with private file
modes. It does not apply archived permissions or call `extractall`. It checks
the archive again for changes across extraction and then verifies every
restored file. A failed partial destination is retained for diagnosis and
cannot be reused by a later invocation.

Before source replay, the driver checks the original producer revision and
tracked-tree cleanliness, all five archived dependency/policy lock files,
and the recorded Node/V8/npm/platform/architecture environment. It applies
the archived timezone and locale. The original source admission checker also
validates its detailed parser, implementation, runtime, and reference-isolation
identity; an incompatible historical profile fails explicitly.

The hosted producer and restore jobs install the npm version named in that
lock before installing dependencies. A Node distribution can bundle a newer
npm, so selecting the Node version alone is insufficient. Runtime failures
retain the expected and actual values and the mismatched fields before replay
is attempted; the original archive and its lock remain unchanged.

`restore-release-campaign.mjs` then imports **the original checkout's**
`CampaignStore`, `verifyReleaseCampaign`, and `recheckEffectfulAdmission`.
There is no fallback to the restorer checkout's runtime. It checks all durable
campaign objects, reconciles the original latest dispositions with the release
denominator, and replays every original `admitted` or `locally_verified`
attempt—including superseded positive attempts. Admitted attempts retain the
original native-binding requirement. Locally verified attempts use the
original local source gate and remain locally verified.

Original refusals, cancellations, failures, and other nonpositive dispositions
are retained in the per-attempt inventory without promotion or replacement.
A replay failure is recorded and the remaining attempts are still checked.
One failed positive attempt fails the drill. The source campaign and original
checkout are checked again after replay. The subprocess stage has a one-hour
default deadline, configurable with `--timeout-seconds`; each independent
reference has a 10-second default, configurable with
`--reference-timeout-ms`. A deadline terminates the subprocess group and
retains its logs.

## Optional original-policy native requalification

For native requalification, launch the driver with the Python interpreter
from the original locked consumer environment and supply the pinned consumer
checkout and tokenizer:

```sh
/original/environment/bin/python tools/restore-semantic-release.py \
  --archive /data/original/semantic-v5-release.tar.gz \
  --archive-sha256 ORIGINAL_SHA256_FROM_RETAINED_RECEIPT \
  --tracer-root /checkouts/exact-original-producer \
  --megatoken /checkouts/exact-original-consumer \
  --tokenizer /data/original/tokenizer.json \
  --out /data/drills/new-native-restore-directory
```

The existing original-producer environment checker runs again and compares
its actual receipt to the archived native environment. The native client
checks the exact clean consumer revision, selected Python import location,
tokenizer hash and identity, and policy. Every original admitted attempt then
gets a fresh native receipt and passes the original native admission gate.
Fresh receipts are separate evidence; the archive's existing receipts are
never rebound. Native checks do not promote locally verified or refused
attempts. A release with no admitted attempts does not get a vacuous native
qualification claim.

Without these native inputs, native requalification is explicitly `untested`.
Prepared dataset files are inventory-checked only: this drill does not train a
model, evaluate one, or reingest the prepared dataset into an optimizer.

## Receipts and interpretation

The restored directory contains:

- `release/`: the exact original inventory and release manifest.
- `restore.json`: archive identity, original producer, lock receipts, restorer
  file hashes, host/runtime information, phase, and final status.
- `checks/replay/campaign-verification.json`: complete original campaign read
  verification, including original dispositions and object references.
- `checks/replay/attempts.jsonl`: durable per-attempt source/replay results,
  original status, whether the attempt is latest, and optional native receipts.
- `checks/replay/report.json`: candidate/attempt denominators, original
  admitted/local counts, failed and verified replays, and preserved nonpositive
  attempts.
- `checks/original-source-replay.stdout.log` and `.stderr.log`: execution logs.

The report always states `freshMachineQualification: false`: the local tool
cannot establish that its host was newly provisioned. To qualify a fresh-host
restore, run it on a newly provisioned CI worker or host and retain that
independent provisioning/job identity together with this receipt. A local test
must never be described as a completed fresh-machine drill.

Successful historical replay establishes restoration under the original
producer and declared environment. It does not transfer that admission to a
new producer or policy. The strict-assignment affected-path audit remains a
separate step; affected historical rows need original-source/input
requalification or quarantine. This drill also retains the project's declared
trusted-source subprocess boundary; it does not certify a new OS sandbox.

## Local validation

```sh
node --test test/restore-release-campaign.test.js
python3 -m unittest discover -s tools/native-consumer -p test_release_restore.py
```

The tests exercise genuine original-source replay in a clean detached clone,
full archive extraction followed by subprocess replay, a superseded positive
attempt, unchanged non-admissions, an invalid original admission, omitted
refusals, wrong/dirty producers, mismatched locks, changed archive bytes,
traversal/link/special/duplicate members, expansion limits, and destination
reuse. Native admission fixtures in these tests are explicitly shape-only;
they do not assert an executed native consumer or fresh-host qualification.
