/**
 * Phase 2's exit check of the building-blocks plan (the posting port design,
 * 2026-10-16):
 *
 *   "the reversal hooks become a registry and the ledger to invoicing imports
 *    in the boundary ratchet go to zero."
 *
 * Every posting goes through the posting port (src/lib/posting), so a block's
 * own posting rules no longer have to sit in the ledger kernel, and the
 * ledger no longer reaches into the invoicing or supplier-invoices blocks.
 * This file asserts the three halves of that sentence on the code as it is:
 *
 *   1. the boundary scan finds no `ledger -> invoicing` and no
 *      `ledger -> supplier-invoices` import, and boundary-baseline.json
 *      records neither pair, so boundary.test.ts fails on the first new one;
 *   2. the reversal hooks are a registry: engine.ts imports the static hook
 *      list (lib/composition/reversal-hooks) and that list covers every
 *      source type whose storno must run a business-state mirror;
 *   3. the posting port has no bypass: the posting-port-bypass guard finds no
 *      edge outside the port and its baseline in antipatterns-baseline.json
 *      is empty.
 *
 * Named as Phase 2's exit check in src/lib/modules/README.md.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boundaryReport, compositionSeamReport, scanLibImports } from './import-scan'
import { REVERSAL_HOOKS } from '@/lib/composition/reversal-hooks'
import { REVERSAL_MIRROR_REQUIRED, selectReversalHooks } from '@/lib/bookkeeping/reversal-hooks'
import { countEdges, findPostingPortBypasses } from '@/scripts/checks/posting-port-bypass.mjs'

const LIB_ROOT = join(__dirname, '..', '..')
const SRC_ROOT = join(LIB_ROOT, '..')
const REPO_ROOT = join(SRC_ROOT, '..')

const EXIT_PAIRS = ['ledger -> invoicing', 'ledger -> supplier-invoices'] as const

describe("Phase 2's exit check", () => {
  // The scans below walk the whole tree: well past vitest's 5 s default on a
  // loaded CI runner.
  it('the ledger imports nothing from invoicing or supplier-invoices, and the baseline allows nothing', { timeout: 60_000 }, () => {
    const report = boundaryReport(scanLibImports(LIB_ROOT))
    for (const pair of EXIT_PAIRS) {
      expect(report.edgesByKey[pair] ?? [], `${pair} edges`).toEqual([])
      expect(report.kernelToBlock[pair] ?? 0, pair).toBe(0)
    }

    const baseline = JSON.parse(readFileSync(join(__dirname, 'boundary-baseline.json'), 'utf8')) as {
      kernelToBlock: Record<string, number>
    }
    for (const pair of EXIT_PAIRS) {
      expect(baseline.kernelToBlock[pair] ?? 0, `baseline ${pair}`).toBe(0)
    }
  })

  it('the reversal hooks are a registry that engine.ts imports statically and that covers every mirror', () => {
    const seams = compositionSeamReport(SRC_ROOT)
    expect(seams.importers).toContain('lib/bookkeeping/engine.ts -> lib/composition/reversal-hooks')

    expect(REVERSAL_HOOKS.length).toBeGreaterThan(0)
    for (const sourceType of REVERSAL_MIRROR_REQUIRED) {
      expect(selectReversalHooks(REVERSAL_HOOKS, sourceType).length, sourceType).toBeGreaterThan(0)
    }
  })

  it('nothing outside the posting port calls the engine posting functions, and the baseline is empty', { timeout: 60_000 }, () => {
    const { bypasses } = findPostingPortBypasses(REPO_ROOT)
    expect(bypasses).toEqual({})

    const antipatterns = JSON.parse(
      readFileSync(join(REPO_ROOT, 'scripts', 'checks', 'antipatterns-baseline.json'), 'utf8'),
    ) as { postingPortBypass: { count: number; files: Record<string, string[]> } }
    expect(antipatterns.postingPortBypass.count).toBe(0)
    expect(countEdges(antipatterns.postingPortBypass.files)).toBe(0)
  })
})
