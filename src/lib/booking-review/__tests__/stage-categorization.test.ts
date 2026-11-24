/**
 * A blocked v1 categorization is staged with the box it books. Whether the
 * caller named that box or it was read off the underlag rides along, so the
 * approval holds a named box against the cost account's own box again.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockCategorize = vi.fn()
const mockInsert = vi.fn()
vi.mock('@/lib/transactions/categorize-core', () => ({
  categorizeTransaction: (...args: unknown[]) => mockCategorize(...args),
}))
vi.mock('@/lib/pending-operations/stage', () => ({
  insertStagedOperation: (...args: unknown[]) => mockInsert(...args),
}))

import { stageBlockedCategorization } from '../stage-categorization'
import type { CategorizeInput } from '@/lib/transactions/categorize-core'

const preview = {
  transaction: { amount: -1000, currency: 'SEK', date: '2026-07-10', merchant_name: 'SaaS', description: null },
  category: 'expense_software',
  reverse_charge_kind: 'non_eu_services',
  mappingResult: { debit_account: '5420', credit_account: '1930', vat_lines: [] },
  lines: [],
  underlag: null,
}

async function stagedParams(booking: CategorizeInput) {
  await stageBlockedCategorization({} as never, {
    companyId: 'company-1',
    userId: 'user-1',
    transactionId: 'tx-1',
    booking,
    actor: { type: 'api_key' },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
  })
  return (mockInsert.mock.calls[0]![1] as { params: Record<string, unknown> }).params
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCategorize.mockResolvedValue({ ok: true, dryRun: true, preview })
  mockInsert.mockResolvedValue({ id: 'op-1' })
})

describe('stageBlockedCategorization: the reverse-charge box', () => {
  const base: CategorizeInput = { is_business: true, category: 'expense_software', vat_treatment: 'reverse_charge' }

  it('marks a box the caller named as stated', async () => {
    const params = await stagedParams({ ...base, reverse_charge_kind: 'non_eu_services' })
    expect(params.reverse_charge_kind).toBe('non_eu_services')
    expect(params.reverse_charge_box_param).toBe('reverse_charge_kind')
  })

  it('does not mark a box read off the underlag as stated', async () => {
    const params = await stagedParams(base)
    expect(params.reverse_charge_kind).toBe('non_eu_services')
    expect(params.reverse_charge_box_param).toBeUndefined()
  })
})
