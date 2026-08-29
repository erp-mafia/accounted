import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Transaction } from '@/types'

const getSuggestedCategories = vi.fn()
vi.mock('@/lib/transactions/category-suggestions', () => ({
  getSuggestedCategories: (...a: unknown[]) => getSuggestedCategories(...a),
  buildMerchantHistory: () => new Map(),
  merchantHistoryFor: () => ({}),
}))
const findCounterpartyTemplate = vi.fn()
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  findCounterpartyTemplate: (...a: unknown[]) => findCounterpartyTemplate(...a),
  formatCounterpartyName: (n: string) => n,
}))

import { gatherCandidates } from '../candidates'

// Permissive chainable supabase: every builder method returns the chain, and
// the chain is awaitable (resolves {data: []}) so the two list queries settle.
function mockSupabase(): SupabaseClient {
  const chain: Record<string, unknown> = {}
  for (const m of ['from', 'select', 'or', 'eq', 'is', 'not', 'neq', 'order', 'limit']) {
    chain[m] = () => chain
  }
  chain.then = (resolve: (v: { data: unknown[] }) => unknown) => resolve({ data: [] })
  return chain as unknown as SupabaseClient
}

const TX = { id: 't1', merchant_name: 'Biltema', description: 'Kortköp', original_description: 'BILTEMA' } as unknown as Transaction

function cpMatch(over: Record<string, unknown> = {}) {
  return {
    template: {
      debit_account: '5410',
      counterparty_name: 'Biltema',
      vat_treatment: 'standard_25',
      occurrence_count: 4,
      category: 'expense_consumables',
      ...over,
    },
    matchMethod: 'exact_normalized',
    confidence: 0.9,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  findCounterpartyTemplate.mockResolvedValue(null)
  getSuggestedCategories.mockReturnValue([])
})

describe('gatherCandidates', () => {
  it('puts the counterparty template first, carrying its own VAT', async () => {
    findCounterpartyTemplate.mockResolvedValue(cpMatch())
    const out = await gatherCandidates(mockSupabase(), 'c1', TX)
    expect(out[0]).toMatchObject({
      account: '5410',
      source: 'counterparty_template',
      vatTreatment: 'standard_25',
      confidence: 0.9,
    })
    expect(out[0].matchReason).toContain('4 tidigare')
  })

  it('derives VAT for rule/pattern/history suggestions from their category', async () => {
    getSuggestedCategories.mockReturnValue([
      { category: 'expense_bank_fees', label: 'Bankavgift', account: '6570', confidence: 0.8, source: 'mapping_rule' },
      { category: 'expense_software', label: 'Programvara', account: '5420', confidence: 0.6, source: 'pattern' },
    ])
    const out = await gatherCandidates(mockSupabase(), 'c1', TX)
    const bank = out.find((c) => c.account === '6570')!
    const soft = out.find((c) => c.account === '5420')!
    expect(bank.vatTreatment).toBeNull() // bank fees are VAT-exempt
    expect(soft.vatTreatment).toBe('standard_25')
  })

  it('de-duplicates by account, keeping the highest confidence', async () => {
    findCounterpartyTemplate.mockResolvedValue(cpMatch({ debit_account: '5410' }))
    getSuggestedCategories.mockReturnValue([
      { category: 'expense_consumables', label: 'Material', account: '5410', confidence: 0.56, source: 'history' },
    ])
    const out = await gatherCandidates(mockSupabase(), 'c1', TX)
    const fivefour = out.filter((c) => c.account === '5410')
    expect(fivefour).toHaveLength(1)
    expect(fivefour[0].source).toBe('counterparty_template') // 0.9 > 0.56
  })

  it('skips suggestions with no account and sorts by confidence, capped', async () => {
    getSuggestedCategories.mockReturnValue([
      { category: 'expense_other', label: 'x', account: null, confidence: 0.9, source: 'pattern' },
      { category: 'expense_office', label: 'Kontor', account: '6110', confidence: 0.5, source: 'history' },
      { category: 'expense_travel', label: 'Resor', account: '5800', confidence: 0.7, source: 'mapping_rule' },
    ])
    const out = await gatherCandidates(mockSupabase(), 'c1', TX, 2)
    expect(out.map((c) => c.account)).toEqual(['5800', '6110']) // no null, sorted desc, capped at 2
  })

  it('returns just the suggestions when there is no counterparty match', async () => {
    getSuggestedCategories.mockReturnValue([
      { category: 'expense_office', label: 'Kontor', account: '6110', confidence: 0.5, source: 'history' },
    ])
    const out = await gatherCandidates(mockSupabase(), 'c1', TX)
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('history')
  })
})
