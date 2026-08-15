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
 * ~0.5 four-way spread on every transaction: noise agents correctly
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

  it('falls back to the description when merchant_name is null (card purchases)', () => {
    // Bank feeds only carry counterparty names for transfers; card purchases
    // arrive with merchant_name null and the merchant buried in a descriptor
    // whose tail (product, city) changes between charges. All of these are
    // one counterparty: the reported Anthropic no-signal bug.
    const map = buildMerchantHistory([
      { merchant_name: null, description: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO', category: 'expense_software' },
      { merchant_name: null, description: 'ANTHROPIC*CLAUDE SUB +14155551234', category: 'expense_software' },
      { merchant_name: 'Anthropic', description: 'irrelevant when merchant_name set', category: 'expense_software' },
    ])
    expect(merchantHistoryFor(map, null, 'ANTHROPIC* CLAUDE SUB LONDON')).toEqual({
      expense_software: 3,
    })
    expect(merchantHistoryFor(map, 'Anthropic')).toEqual({ expense_software: 3 })
  })

  it('anchors on original_description so user renames do not sever history', () => {
    // description is a mutable working title; a user renaming the row to
    // "Software" must not detach it from the raw bank descriptor identity.
    const map = buildMerchantHistory([
      {
        merchant_name: null,
        description: 'Software',
        original_description: 'ANTHROPIC* CLAUDE SUB SAN FRANCISCO',
        category: 'expense_software',
      },
    ])
    expect(merchantHistoryFor(map, null, 'ANTHROPIC*CLAUDE SUB +14155551234')).toEqual({
      expense_software: 1,
    })
    // Renamed title itself is NOT a key when the raw descriptor exists.
    expect(merchantHistoryFor(map, null, 'Software')).toEqual({})
  })
})

describe('getSuggestedCategories: mapping rules on custom accounts', () => {
  const rule = (over: Record<string, unknown> = {}) =>
    ({
      id: 'rule-1',
      company_id: 'company-1',
      is_active: true,
      merchant_pattern: 'Myrorna',
      description_pattern: null,
      mcc_codes: null,
      debit_account: '4020',
      credit_account: '1930',
      default_private: false,
      confidence_score: 0.9,
      priority: 10,
      source: 'user',
      user_description: null,
      ...over,
      // MappingRule carries many more columns; only the fields the suggestion
      // engine reads are modelled here.
    }) as never

  it('surfaces a rule booking on a custom account instead of silently dropping it', async () => {
    const result = getSuggestedCategories(
      tx({ merchant_name: 'Myrorna', description: 'MYRORNA BUTIK 1' }),
      [rule()],
      {},
    )
    // 4020 is outside the fixed category maps: the old reverse-lookup
    // returned null and the rule vanished with no diagnostic.
    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject({
      category: 'expense_other',
      account: '4020',
      source: 'mapping_rule',
      confidence: 0.9,
    })
    expect(result[0].match_reason).toMatch(/konto 4020/)
  })

  it('surfaces an unmapped INCOME account with the custom-account diagnostic', async () => {
    const result = getSuggestedCategories(
      tx({ amount: 100, merchant_name: 'Myrorna', description: 'SWISH MYRORNA' }),
      [rule({ debit_account: '3020' })],
      {},
    )
    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject({
      category: 'income_other',
      account: '3020',
      source: 'mapping_rule',
    })
    expect(result[0].match_reason).toMatch(/konto 3020/)
  })

  it('accumulates the user_description reason with the custom-account reason', async () => {
    const result = getSuggestedCategories(
      tx({ merchant_name: 'Myrorna', description: 'MYRORNA BUTIK 1' }),
      [rule({ source: 'user_description', user_description: 'Second hand-inköp till butiken' })],
      {},
    )
    expect(result.length).toBe(1)
    expect(result[0].match_reason).toMatch(/Matchad på din beskrivning: Second hand-inköp till butiken/)
    expect(result[0].match_reason).toMatch(/konto 4020/)
  })

  it('keeps the exact category for rules on accounts inside the fixed maps', async () => {
    const result = getSuggestedCategories(
      tx({ merchant_name: 'Anthropic', description: 'ANTHROPIC* CLAUDE' }),
      [rule({ merchant_pattern: 'Anthropic', debit_account: '5420' })],
      {},
    )
    expect(result.length).toBe(1)
    expect(result[0]).toMatchObject({
      category: 'expense_software',
      account: '5420',
      source: 'mapping_rule',
    })
    expect(result[0].match_reason).toBeUndefined()
  })
})

describe('getSuggestedCategories: counterparty history', () => {
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
