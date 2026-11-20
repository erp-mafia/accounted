/**
 * The reconciliation sign-offs plug-in (../reconciliation-signoffs.ts)
 * against the ledger's contract (lib/reports/reconciliation-signoffs.ts):
 * owned by the module of the leaves it calls, importing only those leaves,
 * and calling each unchanged, with the arguments the ledger passed it before
 * the plug-in point existed. The leaves are pinned by
 * lib/reconciliation/__tests__/signoff-store.test.ts.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaves = vi.hoisted(() => ({ getLatestSignoffs: vi.fn() }))
vi.mock('@/lib/reconciliation/signoff-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reconciliation/signoff-store')>()),
  getLatestSignoffs: leaves.getLatestSignoffs,
}))

import { RECONCILIATION_SIGNOFFS } from '../reconciliation-signoffs'
import { mapSignoffRow } from '@/lib/reconciliation/signoff-store'
import { bankAccountKey } from '@/lib/reconciliation/schemas'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAVES = ['reconciliation/schemas', 'reconciliation/signoff-store']
const supabase = { sentinel: 'client' } as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('RECONCILIATION_SIGNOFFS', () => {
  it('is frozen, owned by the module of its leaves, and imports only those leaves', () => {
    expect(Object.isFrozen(RECONCILIATION_SIGNOFFS)).toBe(true)
    for (const leaf of LEAVES) expect(RECONCILIATION_SIGNOFFS.module, leaf).toBe(moduleForLibPath(leaf))
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/reconciliation-signoffs.ts')
      .map((edge) => edge.to)
      .sort()
    expect(imported).toEqual(LEAVES)
  })

  it('latest: getLatestSignoffs(supabase, companyId), its result and its failure untouched', async () => {
    const signoffs = new Map([['bank:ca-1', { through_date: '2026-08-31' }]])
    leaves.getLatestSignoffs.mockResolvedValueOnce(signoffs)
    await expect(RECONCILIATION_SIGNOFFS.latest(supabase, 'company-1')).resolves.toBe(signoffs)
    expect(leaves.getLatestSignoffs).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1')

    const failure = new Error('Kunde inte hämta avstämningssigneringar: timeout')
    leaves.getLatestSignoffs.mockRejectedValueOnce(failure)
    await expect(RECONCILIATION_SIGNOFFS.latest(supabase, 'company-1')).rejects.toBe(failure)
  })

  it('fromRow: mapSignoffRow, öre rounding included', () => {
    const row = {
      id: 's1',
      account_key: 'manual:2350',
      through_date: '2026-12-31',
      external_balance: '-250000.004',
      ledger_balance: -250000,
      unexplained_difference: null,
      note: null,
      signed_by: 'u1',
      signed_at: '2027-01-10T08:00:00Z',
      reopened_at: null,
      reopened_by: null,
      reopen_reason: null,
    }
    expect(RECONCILIATION_SIGNOFFS.fromRow(row)).toEqual(mapSignoffRow(row))
    expect(RECONCILIATION_SIGNOFFS.fromRow(row).external_balance).toBe(-250000)
  })

  it('bankAccountKey: the key bankAccountKey files a cash account under', () => {
    expect(RECONCILIATION_SIGNOFFS.bankAccountKey('ca-1')).toBe(bankAccountKey('ca-1'))
    expect(RECONCILIATION_SIGNOFFS.bankAccountKey('ca-1')).toBe('bank:ca-1')
  })
})
