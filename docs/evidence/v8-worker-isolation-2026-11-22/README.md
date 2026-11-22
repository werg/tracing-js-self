# Ordinary V8 generation-worker isolation

Local working integration based on producer `25c8beb67d199451d57ae9a27625923c66f37ef2`, 22 November 2026.

The dedicated import loader blocks the legacy effect verifier and session collector while an actual generation-worker subprocess collects ordinary V8 evidence and the original-reference variant. The complete generation selection passes **21/21**, zero failures, cancellations or skips. These are engineering controls, not complete source/native/token admission or learned-quality evidence. The exact published commit still requires its hosted gates.

Command (with `TMPDIR` pointing to the workspace temporary directory):

```sh
node --test test/generation-v8-worker-imports.test.js test/generation-process.test.js test/generation-dispositions.test.js test/generation-case-selection.test.js test/generation-shards.test.js test/native-generation-pins.test.js
```

Decode the complete retained log with `base64 -d < worker-integration.log.gz.b64 | gzip -d`.
