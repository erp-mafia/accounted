#!/usr/bin/env bash
# Smoke unit checks for hosted-huvudbok (no Docker / no secrets).
set -euo pipefail
cd "$(dirname "$0")/.."
npx vitest run \
  lib/obx/__tests__/ledger-mode-and-timing.test.ts \
  lib/obx/__tests__/registry.test.ts \
  lib/bookkeeping/__tests__/commit-gates.test.ts \
  lib/workspace/__tests__/date-tools.test.ts
echo "OK: hosted-huvudbok unit smoke passed"
