# Final 47-case source, native, and lifecycle evidence

This package retains completed evidence across several independently pinned runs. The producer and consumer revisions differ between the 47-case source/native run and the later ordinary lifecycle. Each run keeps its own exact identities and status.

## Final 47-case source and native admission

The exact clean pair was producer `934a111cf952e084b599ddff6932ce34849550b6` (tree `bc7acaf449486f549e3411543630b500d268d916`) and consumer `f25fa325def722c5ec7d6ed7f9300ac235cf6e1a` (tree `8f856151793e3b2a2ae3609f13f34d209e426c55`). The population was 44 source scripts and 3 module graphs. Both source qualification and independent native admission passed for all 47 cases. The native policy is retained byte-for-byte and binds consumer `f25fa32` and the production tokenizer whose verified SHA-256 is `40fb9d7d7795b8bd305aeff39ce9963f3f450915b9553f2938e009be9a1fed60`.

Exact cost and native packing measurement passed for all 47 cases. The flat serializer measured 56,597 generated tokens, of which 55,388 (97.86%) came from detailed regions, 1,789 terminal tokens, 2,951,658 observed/context tokens, and 3,010,044 total tokens. Native training packing measured 6,920 physical and 1,948 logical records, 56,597 generated tokens, and 3,013,123 observed tokens. Compact/detailed coverage was 34/294 regions across 22 mixed and 25 wholly detailed cases. The detailed-token share remains high. Model learning and native serving are unmeasured; default promotion remains `not-qualified`.

The recorded worker bounds were two workers, 120-second worker timeout, 768 MiB worker memory, and 120-second native timeout. The exact population tasks, per-case source exports, admitted exports, native receipts, progress journals, cost artifacts, native policy, tokenizer bytes, and stdout/stderr are retained under the archive. The producer dependency tree was the already-installed lockfile-pinned Node dependency tree exposed through a worktree-local ignored symlink; the run metadata records that layout and package-lock digest. The symlink remained unchanged while qualification ran.

## Ordinary lifecycle and bounded accepted-record diagnostic

The ordinary lifecycle ran on producer `35be3b75d7eff768274afd034ff8b4215ddba77c` and consumer `f25fa325def722c5ec7d6ed7f9300ac235cf6e1a`. It froze all 47 cases, performed two optimizer updates, retained 315 moment owners (311 advancing between updates), and changed 300 master-weight tensors. Fresh-process restoration preserved the next selection across seven compared fields. The run acknowledged zero semantic model records; it does not establish learned execution success.

A separate bounded diagnostic at the same producer and consumer pair recorded 32 decoder updates at 18 generated tokens per update and one acknowledged Promise-create record. Fresh service restoration retained one session with zero host dispatches and an exact next output. The fitter itself makes no source-correspondence claim. A separately retained producer audit (`bounded-diagnostic-p35be3b7-f25fa32/producer-prefix-audit.json`) independently rechecks the original source/projection/public replay and verifies the exact accepted prefix, context and actual emitted payload. The full program is incomplete; held-out, generalization and external comprehension remain untested. This is a bounded accepted-record recovery measurement.

The five-case native orchestration check, eight unit controls, independent five-case Python validation, tokenizer controls, and full producer test suite are retained in separate folders. The producer suite completed 2,320 tests: 2,314 passed, zero failed, and six environment-gated cases were skipped. The verification report also records native differential disagreements separately from the test-suite pass count.

## Retained failures and limits

Earlier attempts are retained unchanged. The first ordinary attempt at producer `934a111` failed because the selected Python imported `megatoken` outside the pinned consumer checkout; the next attempt failed while serializing a circular object. The complete command report and both logs remain under `prior-attempts/ordinary-p934a111`. The first complete local installed-dependency consumer suite recorded 553/555 passed with two stale low-level callback-control failures and no runtime-source change; the exact result, JUnit XML, logs, identities, and tokenizer pin are retained under `consumer-ci-f25fa32-failed`. A hosted producer V8 workflow failure is retained separately. These failures remain distinct from later successful gates.

This evidence is historical for the revisions above. Later review reproduced typed native-action and model/request mismatches (`true` versus `1`) that Python equality accepted. Corrections are published in consumer `84dee6a` and `0351fe9607735898da441458fdf7182e20a9ace5`. This 47-case run remains evidence only for its recorded consumer bytes; qualification of the corrected pair is a separate run. The package does not relabel old receipts under newer consumer code. No full-edition conformance, held-out quality, default cutover, or native-serving success is claimed.

## Archive integrity and restoration

`inventory.json` identifies **515 files / 528,316,313 original bytes** in an archive of 179,006,563 bytes, split into 86 parts of at most 2 MiB. Identical files are retained as verified tar hard links. The archive verifier passed for all 515 members and the joined archive SHA-256 is `7dd052a8dd72bc90760360aa3de02fcbf62d716cf47a6c10623e9ac44ce4884a`. Verify the archive and every member without extracting:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/semantic-v8-final47-pair-934a111-f25fa32/inventory.json
```

To restore all files into a new directory:

```sh
python3 tools/restore-retained-evidence.py \
  --inventory docs/evidence/semantic-v8-final47-pair-934a111-f25fa32/inventory.json \
  --out /absolute/path/to/new-directory
```
