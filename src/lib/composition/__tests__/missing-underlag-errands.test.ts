/**
 * The missing-underlag errands plug-in (../missing-underlag-errands.ts)
 * against the ledger's contract (lib/reports/missing-underlag-errands.ts):
 * owned by the module of the leaf it calls, importing only that leaf, and
 * calling it unchanged, with the arguments the ledger passes. The errand
 * itself is pinned by lib/receipt-hunt/__tests__/agent-worklist.test.ts.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaves = vi.hoisted(() => ({ verifikatNextStepKinds: vi.fn() }))
vi.mock('@/lib/receipt-hunt/agent-worklist', () => ({
  verifikatNextStepKinds: leaves.verifikatNextStepKinds,
}))

import { MISSING_UNDERLAG_ERRANDS } from '../missing-underlag-errands'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAF = 'receipt-hunt/agent-worklist'
const supabase = { sentinel: 'client' } as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MISSING_UNDERLAG_ERRANDS', () => {
  it('is frozen, owned by the module of its leaf, and imports only that leaf', () => {
    expect(Object.isFrozen(MISSING_UNDERLAG_ERRANDS)).toBe(true)
    expect(MISSING_UNDERLAG_ERRANDS.module).toBe(moduleForLibPath(LEAF))
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/missing-underlag-errands.ts')
      .map((edge) => edge.to)
    expect(imported).toEqual([LEAF])
  })

  it('kinds: verifikatNextStepKinds with the same arguments, its result untouched', async () => {
    const kinds = new Map([['je-1', 'no_purchase']])
    leaves.verifikatNextStepKinds.mockResolvedValueOnce(kinds)
    const rows = [{ journal_entry_id: 'je-1', description: 'Överföring', source_type: 'bank_transaction' }]
    await expect(MISSING_UNDERLAG_ERRANDS.kinds(supabase, 'company-1', rows)).resolves.toBe(kinds)
    expect(leaves.verifikatNextStepKinds).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', rows)
  })

  it('kinds: passes a failure through untouched, so the close check decides what a failed read counts as', async () => {
    const failure = new Error('transactions lookup failed: timeout')
    leaves.verifikatNextStepKinds.mockRejectedValueOnce(failure)
    await expect(MISSING_UNDERLAG_ERRANDS.kinds(supabase, 'company-1', [])).rejects.toBe(failure)
  })
})
