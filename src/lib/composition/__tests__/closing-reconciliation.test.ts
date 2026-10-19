/**
 * The closing reconciliation plug-in (../closing-reconciliation.ts) against
 * the ledger's contract (lib/reports/closing-reconciliation.ts): owned by
 * the module of the leaves it calls, importing only those leaves, and
 * calling each unchanged, with the arguments the ledger passed it before the
 * plug-in point existed. The leaves are pinned by their own tests in
 * lib/reconciliation/__tests__.
 */
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const leaves = vi.hoisted(() => ({
  listReconciliationAccounts: vi.fn(),
  loadBalanceSheetSnapshot: vi.fn(),
  loadSpecificationAmounts: vi.fn(),
  listAttachmentRowsInRange: vi.fn(),
}))
vi.mock('@/lib/reconciliation/service', () => ({
  listReconciliationAccounts: leaves.listReconciliationAccounts,
}))
vi.mock('@/lib/reconciliation/manual-reconciliation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/reconciliation/manual-reconciliation')>()),
  loadBalanceSheetSnapshot: leaves.loadBalanceSheetSnapshot,
  loadSpecificationAmounts: leaves.loadSpecificationAmounts,
}))
vi.mock('@/lib/reconciliation/attachments-store', () => ({
  listAttachmentRowsInRange: leaves.listAttachmentRowsInRange,
}))

import { CLOSING_RECONCILIATION } from '../closing-reconciliation'
import { SPECIFICATION_PROVIDERS, type BalanceSheetSnapshot } from '@/lib/reconciliation/manual-reconciliation'
import { moduleForLibPath } from '@/lib/modules/resolve'
import { scanLibImports } from '@/lib/modules/__tests__/import-scan'

const LIB_ROOT = join(__dirname, '..', '..')
const LEAVES = ['reconciliation/attachments-store', 'reconciliation/manual-reconciliation', 'reconciliation/service']
const supabase = { sentinel: 'client' } as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CLOSING_RECONCILIATION', () => {
  it('is frozen, owned by the module of its leaves, and imports only those leaves', () => {
    expect(Object.isFrozen(CLOSING_RECONCILIATION)).toBe(true)
    for (const leaf of LEAVES) expect(CLOSING_RECONCILIATION.module, leaf).toBe(moduleForLibPath(leaf))
    const imported = scanLibImports(LIB_ROOT)
      .filter((edge) => edge.from === 'composition/closing-reconciliation.ts')
      .map((edge) => edge.to)
      .sort()
    expect(imported).toEqual(LEAVES)
  })

  it('listAccounts: listReconciliationAccounts with the same arguments, its result and failure untouched', async () => {
    const accounts = [{ account_key: 'manual:2350' }]
    leaves.listReconciliationAccounts.mockResolvedValueOnce(accounts)
    const options = { today: '2026-12-31', windowFrom: '2026-01-01', windowTo: '2026-12-31' }
    await expect(CLOSING_RECONCILIATION.listAccounts(supabase, 'company-1', options)).resolves.toBe(accounts)
    expect(leaves.listReconciliationAccounts).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', options)

    const failure = new Error('Kunde inte hämta kassakonton: timeout')
    leaves.listReconciliationAccounts.mockRejectedValueOnce(failure)
    await expect(CLOSING_RECONCILIATION.listAccounts(supabase, 'company-1', options)).rejects.toBe(failure)
  })

  it('balanceSheetSnapshot: loadBalanceSheetSnapshot(supabase, companyId, asOfDate)', async () => {
    const snapshot = { as_of: '2026-12-31' }
    leaves.loadBalanceSheetSnapshot.mockResolvedValueOnce(snapshot)
    await expect(CLOSING_RECONCILIATION.balanceSheetSnapshot(supabase, 'company-1', '2026-12-31')).resolves.toBe(snapshot)
    expect(leaves.loadBalanceSheetSnapshot).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', '2026-12-31')
  })

  it('specificationAmounts: loadSpecificationAmounts(supabase, companyId, snapshot, onlyAccounts)', async () => {
    const amounts = new Map([['1510', { amount: 11500, unconverted_fx_count: 0 }]])
    leaves.loadSpecificationAmounts.mockResolvedValueOnce(amounts)
    const snapshot = { as_of: '2026-12-31' } as unknown as BalanceSheetSnapshot
    const only = new Set(['1510'])
    await expect(CLOSING_RECONCILIATION.specificationAmounts(supabase, 'company-1', snapshot, only)).resolves.toBe(amounts)
    expect(leaves.loadSpecificationAmounts).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', snapshot, only)
  })

  it('specificationProviders: SPECIFICATION_PROVIDERS itself', () => {
    expect(CLOSING_RECONCILIATION.specificationProviders).toBe(SPECIFICATION_PROVIDERS)
  })

  it('attachmentRowsInRange: listAttachmentRowsInRange with the same arguments', async () => {
    const rows = [{ id: 'a1' }]
    leaves.listAttachmentRowsInRange.mockResolvedValueOnce(rows)
    await expect(
      CLOSING_RECONCILIATION.attachmentRowsInRange(supabase, 'company-1', '2026-01-01', '2026-12-31', { includeRemoved: true }),
    ).resolves.toBe(rows)
    expect(leaves.listAttachmentRowsInRange).toHaveBeenCalledExactlyOnceWith(supabase, 'company-1', '2026-01-01', '2026-12-31', {
      includeRemoved: true,
    })
  })
})
