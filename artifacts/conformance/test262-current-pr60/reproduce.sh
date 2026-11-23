#!/usr/bin/env bash
set -euo pipefail
# Run from a clean producer checkout at 5f321f0c634773bbccdb12b9ab6d18f69954f1ef.
# Point this script at the retained files in another PR checkout if necessary.
# Dependencies must already match that checkout's package-lock.json.
TEST262_SUITE_ROOT=${TEST262_SUITE_ROOT:?Set the exact Test262 checkout path}
TEST262_OUTPUT_ROOT=${TEST262_OUTPUT_ROOT:?Set an output directory outside the source checkout}
TEST262_RETAINED_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test "$(git rev-parse HEAD)" = '5f321f0c634773bbccdb12b9ab6d18f69954f1ef'
test "$(git -C "$TEST262_SUITE_ROOT" rev-parse HEAD)" = '2a1ade303f72d3de80565c921d685222405c32ce'
mkdir -p "$TEST262_OUTPUT_ROOT"
TEST262_SELECTED_PATHS=$(paste -sd, "$TEST262_RETAINED_ROOT/selected-paths.txt")
node --max-old-space-size=2048 tools/catalog-test262.mjs \
  --suite-root "$TEST262_SUITE_ROOT" --revision '2a1ade303f72d3de80565c921d685222405c32ce' \
  --out "$TEST262_OUTPUT_ROOT/catalog.json.gz"
node --max-old-space-size=2048 "$TEST262_RETAINED_ROOT/restore-report.mjs" \
  --catalog "$TEST262_OUTPUT_ROOT/catalog.json.gz" \
  --selection "$TEST262_RETAINED_ROOT/selected-report.json" \
  --out "$TEST262_OUTPUT_ROOT/restored-retained-report.json.gz"
TEST262_ARGUMENTS=(
  --catalog "$TEST262_OUTPUT_ROOT/catalog.json.gz"
  --suite-root "$TEST262_SUITE_ROOT" --revision '2a1ade303f72d3de80565c921d685222405c32ce'
  --paths "$TEST262_SELECTED_PATHS" --stages parse,owned,reference
  --jobs 2 --worker-timeout-ms 60000 --heap-mb 384
  --max-steps 20000
  --max-source-bytes 1048576
  --reference-timeout-ms 300
  --out "$TEST262_OUTPUT_ROOT/new-report.json.gz"
)
node --max-old-space-size=2048 tools/run-test262-campaign.mjs "${TEST262_ARGUMENTS[@]}"
sha256sum "$TEST262_OUTPUT_ROOT/new-report.json.gz" > "$TEST262_OUTPUT_ROOT/before-resume.sha256"
node --max-old-space-size=2048 tools/run-test262-campaign.mjs "${TEST262_ARGUMENTS[@]}" \
  --resume "$TEST262_OUTPUT_ROOT/new-report.json.gz"
sha256sum --check "$TEST262_OUTPUT_ROOT/before-resume.sha256"
node --max-old-space-size=2048 tools/run-test262-campaign.mjs --check "$TEST262_OUTPUT_ROOT/new-report.json.gz"
