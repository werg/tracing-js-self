# Reconstructing split release archives

Some complete evidence archives exceed the per-file delivery limit. They are
split as binary byte ranges, with no recompression or changes to the original
archive. The ordered parts, exact byte counts and independent SHA-256 values
are in [the parts manifest](evidence/durable-archive-parts-2026-11-18.json).
The complete archive digest must match before extraction.

Download every part for the archive you need into one directory. From a checkout
of this repository, run (replace the directory paths with your local paths):

```sh
python tools/reassemble-release-archive.py \
  --manifest docs/evidence/durable-archive-parts-2026-11-18.json \
  --directory /absolute/path/to/downloaded-parts \
  --output-directory /absolute/path/to/reassembled \
  --archive tracing-js-self-release-C-audit-2026-11-18.tar.gz
```

Repeat with
`--archive tracing-js-self-optimization-evidence-2026-11-18.tar.gz`
for the complete model evidence. Omit `--archive` only when all parts for every
listed archive have been downloaded. Use `--verify-only` to check every part
and the concatenated archive hash without creating an output file.

The tool streams the parts in manifest order, checks each part and the full
archive, and publishes an output only after verification. It refuses to
overwrite an existing archive and removes its own partial file after failure.
It never extracts files. The archives' internal hashed member manifests provide
the separate payload verification described in the release runbook.

The C archive contains historical audit evidence, including refusals; it is not
a new native-prepared release. The model archive includes all optimization
attempts, raw negative rollouts, checkpoints and retrospective checks, preserving
the distinct producer identity of the initial two-step feasibility run.

