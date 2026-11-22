# Explicit physical source authority: composed controls

Producer source `c3442d672745e67a1607f390dbe996a231f03b47` preserves separate
`caseId`, `sourceId` and artifact-path fields throughout release descriptors.
The physical identity comes from the independently verified original task and
frozen registry correspondence. Native source
`a8cf158882913fcf920f71b4f1efa85270d13e41` independently requires that explicit
identity to match each artifact before fresh preparation. Workflow-only commit
`985c9aef551b2547d633a6e84e3b2875ec1c3cca` requires the complete resulting counts.

| Observation | Result | Original output |
| --- | --- | --- |
| Producer archive/descriptor controls plus native verifier controls in one invocation | **88 passed = 19 producer + 69 native**, zero failures, errors or skips; 12.89 seconds | `python.log`, `python.xml` |
| Task binding, complete campaign history and progress controls | **83 executable leaves**, zero failures, errors or skips; parent containers excluded | `node.log`, `node.xml` |
| Unchanged original frozen 64-source packet | 64 task bindings and 64 recorded native correspondences; 64 explicit source IDs emitted into the descriptor | `original-packet-controls.json`, `original-descriptor.json` |
| Preserved original task/source swap | Refused; original journal bytes unchanged | `original-packet-controls.json` |
| Preserved admitted/native-only swap | Refused; original journal bytes unchanged | `original-packet-controls.json` |

The actual source controls include a digest-suffixed physical source identity
whose case label differs, refusal of missing/incorrect explicit identities,
dataset split substitution, normalized ancestry, host settlement order and
actual source-admission RNG behavior. Zero, omitted `randomSeed` with guest seed
19, explicit null and matching guest declarations have positive source evidence.
Conflicting null/19 and zero/19 declarations refuse at source admission and at
the release correspondence boundary. A whitespace-only source-file mutation
also refuses against the exact campaign byte inventory.

The [original-input authority document](../../direct-v8-release-original-inputs.md)
maps all eighteen controls from the independently proposed producer `729a0550`.
It explains the two deliberate semantic corrections: explicit null does not
fall back to guest seed 19, and the existing original module-request plus fresh
relinking profile continues to qualify its supported cases. No duplicate Python
source interpreter or blanket module refusal was introduced.

## Reproduction and limits

The Python command uses the locked Python 3.12.14 / Torch 2.10.0 CPU environment,
with `PYTHONPATH` explicitly pointing to the measured native checkout:

```sh
python -m pytest -q \
  /path/to/producer/tools/native-consumer/test_release_v8.py \
  tests/test_semantic_v8_release_verifier.py \
  --junitxml=python.xml
```

The JavaScript command uses Node 24.22.3:

```sh
node --test --test-concurrency=1 --test-reporter=spec --test-reporter=junit \
  --test-reporter-destination=stdout --test-reporter-destination=node.xml \
  test/v8-release-campaign.test.js test/qualification-progress.test.js \
  test/v8-release-task-binding.test.js
```

The original packet comes from the separately preserved primary artifact ZIP
with SHA-256 `6dc909ecc1c1ed7401fa5ceb1cba7006c07641d530a1550f16a7870af3e483af`.
Its original source/assets are reused in explicitly synthetic coherent journals
for correspondence controls; this check performs no fresh native admission or
optimizer update. The two red packets were preserved independently before their
respective corrections and are not replaced by newly convenient negatives.

The bounded native verifier tests include actual controlled checkpoint/export
state checks. These controls and original packet comparisons do not replace a
new exact-pair full 64-source admission, lifecycle, package and restoration run.
The older `596a3b8e`, `790f525c` and later main-pair runs retain their original
identities and limitations. There is no learned-quality, default-promotion,
full-language or checkpoint-348 serving claim here.

`proof.json` records the exact counts, source revisions and SHA-256 of every
retained output file.
