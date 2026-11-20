/**
 * The unbooked bank lines plug-in (../unbooked-bank-lines.ts) against the
 * ledger's contract (lib/bookkeeping/unbooked-bank-lines.ts): owned by
 * the module of the leaf it calls, importing only that leaf, and calling it
 * unchanged, with the arguments the ledger passed it before the plug-in
 * point existed. The predicate itself is pinned by
 * lib/transactions/__tests__/unbooked.test.ts.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaves = vi.hoisted(() => ({ countUnbookedBankTransactions: vi.fn() }))
vi.mock('@/lib/transactions/unbooked', () => ({
  countUnbookedBankTransactions: leaves.countUnbookedBankTransactions,
}))

import { UNBOOKED_BANK_LINES } from '../unbooked-bank-lines'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAF = 'transactions/unbooked'
const supabase = { sentinel: 'client' } as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('UNBOOKED_BANK_LINES', () => {
  it('is frozen, owned by the module of its leaf, and imports only that leaf', () => {
    expect(Object.isFrozen(UNBOOKED_BANK_LINES)).toBe(true)
    expect(UNBOOKED_BANK_LINES.module).toBe(moduleForLibPath(LEAF))
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/unbooked-bank-lines.ts')
      .map((edge) => edge.to)
    expect(imported).toEqual([LEAF])
  })

  it('count: countUnbookedBankTransactions with the same arguments, its result untouched', async () => {
    const counts = { total: 3, untriaged: 2, business_unbooked: 1 }
    leaves.countUnbookedBankTransactions.mockResolvedValueOnce(counts)
    const range = { fromDate: '2026-03-01', toDate: '2026-03-31' }
    await expect(UNBOOKED_BANK_LINES.count(supabase, 'company-1', range)).resolves.toBe(counts)
    expect(leaves.countUnbookedBankTransactions).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', range)
  })

  it('count: passes no range when the ledger passes none', async () => {
    leaves.countUnbookedBankTransactions.mockResolvedValueOnce({ total: 0, untriaged: 0, business_unbooked: 0 })
    await UNBOOKED_BANK_LINES.count(supabase, 'company-1')
    expect(leaves.countUnbookedBankTransactions.mock.calls[0]).toEqual([supabase, 'company-1'])
  })

  it('count: passes a failure through untouched, so the lock guard fails closed', async () => {
    const failure = new Error('untriaged transaction count failed: timeout')
    leaves.countUnbookedBankTransactions.mockRejectedValueOnce(failure)
    await expect(UNBOOKED_BANK_LINES.count(supabase, 'company-1', {})).rejects.toBe(failure)
  })
})
