#!/usr/bin/env bash
set -euo pipefail
# Invoke this retained script while cwd is the clean recorded producer checkout.
TEST262_SUITE_ROOT=${TEST262_SUITE_ROOT:?Set the exact Test262 checkout path}
TEST262_OUTPUT_ROOT=${TEST262_OUTPUT_ROOT:?Set an output directory outside source}
TEST262_RETAINED_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
TEST262_TOOL_ROOT=$(cd -- "$TEST262_RETAINED_ROOT/../../.." && pwd)
test "$(git rev-parse HEAD)" = '7336d7bacdb7e53025cd8e66ed0d844b19c6ab19'
test -z "$(git status --porcelain)"
test "$(git -C "$TEST262_SUITE_ROOT" rev-parse HEAD)" = '2a1ade303f72d3de80565c921d685222405c32ce'
test -z "$(git -C "$TEST262_SUITE_ROOT" status --porcelain)"
mkdir -p "$TEST262_OUTPUT_ROOT"
TEST262_SELECTED_PATHS=$(paste -sd, "$TEST262_RETAINED_ROOT/selected-paths.txt")
node --max-old-space-size=2048 tools/catalog-test262.mjs \
  --suite-root "$TEST262_SUITE_ROOT" --revision '2a1ade303f72d3de80565c921d685222405c32ce' \
  --out "$TEST262_OUTPUT_ROOT/catalog.json.gz"
TEST262_ARGUMENTS=(
  --catalog "$TEST262_OUTPUT_ROOT/catalog.json.gz"
  --suite-root "$TEST262_SUITE_ROOT" --revision '2a1ade303f72d3de80565c921d685222405c32ce'
  --paths "$TEST262_SELECTED_PATHS" --stages parse,owned,reference
  --jobs 2 --worker-timeout-ms 60000 --heap-mb 384
  --max-steps 20000 --max-source-bytes 1048576 --reference-timeout-ms 300
  --out "$TEST262_OUTPUT_ROOT/new-report.json.gz"
)
node --max-old-space-size=2048 tools/run-test262-campaign.mjs "${TEST262_ARGUMENTS[@]}"
sha256sum "$TEST262_OUTPUT_ROOT/new-report.json.gz" > "$TEST262_OUTPUT_ROOT/before-resume.sha256"
node --max-old-space-size=2048 tools/run-test262-campaign.mjs "${TEST262_ARGUMENTS[@]}" \
  --resume "$TEST262_OUTPUT_ROOT/new-report.json.gz"
sha256sum --check "$TEST262_OUTPUT_ROOT/before-resume.sha256"
node --max-old-space-size=2048 tools/run-test262-campaign.mjs --check "$TEST262_OUTPUT_ROOT/new-report.json.gz"
node --max-old-space-size=2048 "$TEST262_TOOL_ROOT/tools/retain-test262-campaign.mjs" \
  --report "$TEST262_OUTPUT_ROOT/new-report.json.gz" --out "$TEST262_OUTPUT_ROOT/retained"
node --max-old-space-size=2048 "$TEST262_TOOL_ROOT/tools/diagnose-test262-campaign.mjs" \
  --report "$TEST262_OUTPUT_ROOT/new-report.json.gz" --suite-root "$TEST262_SUITE_ROOT" \
  --out "$TEST262_OUTPUT_ROOT/retained/unsupported-diagnostics.json"
node --max-old-space-size=2048 "$TEST262_RETAINED_ROOT/../test262-current-pr60/restore-report.mjs" \
  --catalog "$TEST262_OUTPUT_ROOT/catalog.json.gz" \
  --selection "$TEST262_RETAINED_ROOT/selected-report.json" \
  --out "$TEST262_OUTPUT_ROOT/restored-recorded-report.json.gz"
