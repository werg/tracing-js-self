# Durable custody of complete V8 evidence

`tools/retain-v8-evidence-plan.py` preserves the original Actions ZIP and every
complete job log for each explicitly pinned workflow attempt. It uses the
existing archive retainer unchanged, loaded only after checking its exact source
SHA-256. Archive content is never extracted or executed. Every ZIP, job log and
combined custody receipt is read back from an unpublished draft release and
checked against its expected size and SHA-256. Existing assets are reused only
when exact; they are never overwritten or deleted.

The plan at `profiles/v8-evidence-custody-2026-11-22.json` binds the original run,
attempt, producer/driver head, workflow path, conclusion, artifact ID/name and
ZIP byte identity. It also enumerates every original job with its exact source
attempt, name, conclusion and complete log byte identity. The API attempt-job
inventory must match this complete list with no missing, additional or repeated
jobs. Original run/job timestamps are checked against the frozen attempt.

The initial plan keeps two observations separate:

| Original observation | Custody scope |
| --- | --- |
| Failed original348 evaluation, run `45046754653`, source `f4bcf1e0bfde2dee398df3df692246b3e93dadef` | The failed conclusion and original outcomes stay failed. No learned-quality or serving qualification is created by archiving them. |
| Successful historical task-binding release gate, run `45044587251`, source `790f525c280b34a66ef8269aa7148bd9966b8639` | Exact earlier full64/two-update/package/restoration evidence. This source predates the later native-record and explicit physical-source identity corrections. |

The later `7c20124f` and final corrected composed-pair archives are added only
after their exact completed-run artifact metadata and complete log bytes are
observed. A planned or still running gate never receives guessed IDs, sizes,
hashes or a successful conclusion. Changing a plan's expected conclusion to
`success` cannot turn a failed source run into a valid custody operation: the
driver requires exact equality with both the source run and each original job.

## Running the scoped workflow

The `Preserve exact V8 archives and complete original job logs` workflow runs only
on `codex/v8-release-evidence-custody-20261122`, with the checkout frozen to the
triggering commit. It has read access to Actions and write access to repository
draft assets. The same branch/repository restriction is enforced in the driver.
It runs twelve local refusal/reuse controls before any network custody operation.

```sh
python tools/retain-v8-evidence-plan.py \
  --plan profiles/v8-evidence-custody-2026-11-22.json \
  --out "$RUNNER_TEMP/v8-evidence-custody"
```

Original logs are downloaded and checked before creating or changing a draft.
The existing retainer independently checks the original ZIP before creating a
draft and reads the retained ZIP back afterward. The companion then checks that
the draft remains unpublished and bound to the same source, uploads or reuses
the full logs, rereads them, and retains a deterministic combined receipt. The
receipt's asset name includes the immutable entry identity; workflow provenance
is recorded separately in the execution summary so reruns can reuse exact
assets without rewriting historical receipts.

Limits are explicit: at most eight archives, 2 GiB per archive and 4 GiB total;
at most 32 original jobs per attempt, 64 MiB per log and 512 MiB total logs; a
128 KiB plan; bounded metadata and validated HTTPS storage redirects inherited
from the pinned retainer. Repository credentials are used only for repository
API/upload hosts and are not forwarded to signed storage URLs. The workflow
uploads compact receipts and complete job logs as its own Actions artifact; it
does not upload a second copy of the large original ZIP there.

The current source and tests provide a concrete, reviewable custody operation.
Only a completed custody workflow with its read-back receipts proves durable
retention. This operation performs zero optimizer updates and creates no new
semantic, model-quality, production-release or default-promotion qualification.
