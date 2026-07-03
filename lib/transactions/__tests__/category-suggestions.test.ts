import { describe, expect, it } from 'vitest'
import {
  buildMerchantHistory,
  getSuggestedCategories,
  merchantHistoryFor,
} from '../category-suggestions'
import type { Transaction } from '@/types'

/**
 * P2-1 (mcp_optimization_plan): suggestions must carry signal tied to THIS
 * transaction. The old company-wide frequency fallback emitted an identical
 * ~0.5 four-way spread on every transaction — noise agents correctly
 * distrusted. History is now counterparty-keyed with provenance; when no
 * source matches, the honest answer is an empty list.
 */

const tx = (overrides: Partial<Transaction> = {}): Transaction =>
  ({
    id: 'tx-1',
    company_id: 'company-1',
    date: '2026-06-01',
    description: 'KORTKÖP POLARN O PYRET',
    amount: -500,
    currency: 'SEK',
    merchant_name: 'Polarn O. Pyret',
    ...overrides,
  }) as Transaction

describe('buildMerchantHistory / merchantHistoryFor', () => {
  const rows = [
    { merchant_name: 'Polarn O. Pyret', category: 'expense_office' },
    { merchant_name: 'polarn o. pyret', category: 'expense_office' },
    { merchant_name: 'Polarn O. Pyret', category: 'expense_consumables' },
    { merchant_name: 'DNB Bank', category: 'expense_bank_fees' },
    { merchant_name: null, category: 'expense_other' },
    { merchant_name: 'Ghost AB', category: null },
  ]

  it('groups case-insensitively by merchant and ignores null merchants/categories', () => {
    const map = buildMerchantHistory(rows)
    expect(merchantHistoryFor(map, 'POLARN O. PYRET')).toEqual({
      expense_office: 2,
      expense_consumables: 1,
    })
    expect(merchantHistoryFor(map, 'DNB Bank')).toEqual({ expense_bank_fees: 1 })
    expect(merchantHistoryFor(map, 'Unknown Vendor')).toEqual({})
    expect(merchantHistoryFor(map, null)).toEqual({})
  })
})

describe('getSuggestedCategories — counterparty history', () => {
  it('returns an empty list (not a fabricated spread) when nothing matches', () => {
    const result = getSuggestedCategories(
      tx({ merchant_name: 'Helt Okänd Motpart', description: 'XYZ 123' }),
      [],
      {},
    )
    expect(result).toEqual([])
  })

  it('surfaces merchant history with provenance and occurrence-scaled confidence', () => {
    const result = getSuggestedCategories(tx({ description: 'XYZ 123' }), [], {
      expense_office: 3,
      expense_consumables: 1,
    })
    expect(result.length).toBe(2)
    expect(result[0]).toMatchObject({
      category: 'expense_office',
      source: 'history',
      confidence: Math.min(0.85, 0.5 + 3 * 0.06),
    })
    expect(result[0].match_reason).toMatch(/3 gånger tidigare för denna motpart/)
    expect(result[1].category).toBe('expense_consumables')
    expect(result[1].match_reason).toMatch(/1 gång tidigare/)
  })

  it('caps history confidence at 0.85', () => {
    const result = getSuggestedCategories(tx({ description: 'XYZ 123' }), [], {
      expense_office: 50,
    })
    expect(result[0].confidence).toBe(0.85)
  })

  it('filters history to the transaction direction', () => {
    const result = getSuggestedCategories(
      tx({ amount: 1000, description: 'XYZ 123' }), // income direction
      [],
      { expense_office: 5 },
    )
    expect(result).toEqual([])
  })
})
