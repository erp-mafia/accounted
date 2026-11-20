/**
 * A learned single pair books the moms its learned booking carried
 * (crm#1632). A pair learned from Swish sales (D 1930 / K 3001 / K 2611,
 * stored as vat_treatment standard_25, vat_account 2611) used to book every
 * later sale gross on 3001 with no utgående moms: the replay wrote a moms line
 * only for money out, always on 2641.
 */
import { describe, it, expect } from 'vitest'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'
import {
  buildMappingResultFromCounterpartyTemplate,
  upsertCounterpartyTemplate,
} from '../counterparty-templates'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import { outputVatTreatmentOfAccount, vatAccountNature } from '../vat-entries'
import { roundOre } from '@/lib/money'
import type { CategorizationTemplate, CreateJournalEntryLineInput, Transaction } from '@/types'

const sek = (amount: number, over: Partial<Transaction> = {}) =>
  makeTransaction({ amount, amount_sek: amount, currency: 'SEK', exchange_rate: 1, ...over })

function book(over: Partial<CategorizationTemplate>, tx: Transaction, vatRegistered?: boolean) {
  const match = { template: makeCategorizationTemplate(over), matchMethod: 'exact_alias' as const, confidence: 0.9 }
  const result = buildMappingResultFromCounterpartyTemplate(match, tx, 'aktiebolag', vatRegistered)
  return { result, lines: buildTransactionEntryLines(tx, result) }
}

/** Each account's [debit, credit], one line per account in these entries. */
function legs(lines: CreateJournalEntryLineInput[]): Record<string, [number, number]> {
  return Object.fromEntries(lines.map((l) => [l.account_number, [l.debit_amount, l.credit_amount]]))
}

function expectBalanced(lines: CreateJournalEntryLineInput[]) {
  const debits = roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))
  const credits = roundOre(lines.reduce((s, l) => s + l.credit_amount, 0))
  expect(debits).toBe(credits)
  expect(debits).toBeGreaterThan(0)
}

const salePair = (over: Partial<CategorizationTemplate>): Partial<CategorizationTemplate> => ({
  counterparty_name: 'swish inbetal',
  counterparty_aliases: ['swish inbetal'],
  debit_account: '1930',
  credit_account: '3001',
  category: 'income_services',
  ...over,
})

describe('the moms side of an account', () => {
  it.each([
    ['2611', 'standard_25', 'income'],
    ['2621', 'reduced_12', 'income'],
    ['2631', 'reduced_6', 'income'],
    ['2641', null, 'expense'],
    ['2645', null, 'expense'],
    ['2614', null, 'expense'],
    ['3001', null, null],
  ] as const)('%s: treatment %s, nature %s', (account, treatment, nature) => {
    expect(outputVatTreatmentOfAccount(account)).toBe(treatment)
    expect(vatAccountNature(account)).toBe(nature)
  })

  it('has no nature without an account', () => {
    expect(vatAccountNature(null)).toBeNull()
    expect(vatAccountNature(undefined)).toBeNull()
  })
})

describe('a pair learned from sales books utgående moms (crm#1632)', () => {
  it.each([
    { treatment: 'standard_25', vatAccount: '2611', revenue: '3001', gross: 1250, net: 1000, vat: 250 },
    { treatment: 'standard_25', vatAccount: '2611', revenue: '3001', gross: 99, net: 79.2, vat: 19.8 },
    { treatment: 'reduced_12', vatAccount: '2621', revenue: '3002', gross: 1120, net: 1000, vat: 120 },
    { treatment: 'reduced_12', vatAccount: '2621', revenue: '3002', gross: 100.94, net: 90.12, vat: 10.82 },
    { treatment: 'reduced_6', vatAccount: '2631', revenue: '3003', gross: 1060, net: 1000, vat: 60 },
  ] as const)('$treatment: D 1930 $gross, K $revenue $net, K $vatAccount $vat', ({ treatment, vatAccount, revenue, gross, net, vat }) => {
    const tx = sek(gross)
    const { result, lines } = book(salePair({ credit_account: revenue, vat_treatment: treatment, vat_account: vatAccount }), tx)

    expect(result.direction_mismatch).toBeUndefined()
    expect(legs(lines)).toEqual({
      '1930': [gross, 0],
      [revenue]: [0, net],
      [vatAccount]: [0, vat],
    })
    expect(lines).toHaveLength(3)
    expectBalanced(lines)
  })

  it('takes the moms side from the learned direction when the pair stored no moms account', () => {
    const { lines } = book(salePair({ vat_treatment: 'standard_25', vat_account: null }), sek(1250))
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '3001': [0, 1000], '2611': [0, 250] })
  })

  it('still books a pair learned with no moms gross', () => {
    const { result, lines } = book(salePair({ vat_treatment: null, vat_account: null }), sek(1250))
    expect(result.vat_lines).toEqual([])
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '3001': [0, 1250] })
  })

  it.each(['exempt', 'export', 'reverse_charge'] as const)('books a sale learned as %s gross', (treatment) => {
    const { result, lines } = book(salePair({ credit_account: '3305', vat_treatment: treatment, vat_account: null }), sek(1250))
    expect(result.vat_lines).toEqual([])
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '3305': [0, 1250] })
  })

  it('books the sale gross for a company that is not VAT-registered', () => {
    const { result, lines } = book(salePair({ vat_treatment: 'standard_25', vat_account: '2611' }), sek(1250), false)
    expect(result.vat_lines).toEqual([])
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '3001': [0, 1250] })
  })

  it('takes the 26x1 back, not 2641, on a pair learned from refunds to customers', () => {
    // D 3001 / D 2611 / K 1930: learned in the expense direction by its bank side.
    const refundPair = salePair({ debit_account: '3001', credit_account: '1930', vat_treatment: 'standard_25', vat_account: '2611' })
    const { result, lines } = book(refundPair, sek(-500))
    expect(result.direction_mismatch).toBeUndefined()
    expect(legs(lines)).toEqual({ '3001': [400, 0], '2611': [100, 0], '1930': [0, 500] })
    expectBalanced(lines)
  })

  it('reduces ingående moms, not utgående, on a pair learned from a supplier refund', () => {
    // D 1930 / K 5410 / K 2641: money in on a purchase account.
    const supplierRefund = salePair({ debit_account: '1930', credit_account: '5410', vat_treatment: 'standard_25', vat_account: '2641' })
    const { lines } = book(supplierRefund, sek(1250))
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '5410': [0, 1000], '2641': [0, 250] })
    expectBalanced(lines)
  })
})

describe('a pair learned from purchases books as before', () => {
  it.each([
    { treatment: 'standard_25', gross: 1250, net: 1000, vat: 250, label: 'Ingående moms 25%' },
    { treatment: 'reduced_12', gross: 112, net: 100, vat: 12, label: 'Ingående moms 12%' },
    { treatment: 'reduced_6', gross: 106, net: 100, vat: 6, label: 'Ingående moms 6%' },
  ] as const)('$treatment: D 6200 net, D 2641, K 1930 gross', ({ treatment, gross, net, vat, label }) => {
    const tx = sek(-gross)
    const { result, lines } = book({ debit_account: '6200', credit_account: '1930', vat_treatment: treatment, vat_account: '2641' }, tx)
    expect(result.vat_lines).toEqual([{ account_number: '2641', debit_amount: vat, credit_amount: 0, description: label }])
    expect(legs(lines)).toEqual({ '6200': [net, 0], '2641': [vat, 0], '1930': [0, gross] })
    expectBalanced(lines)
  })

  it('credits 2641 on a refund from the supplier, review-gated', () => {
    const { result, lines } = book({ debit_account: '6200', credit_account: '1930', vat_treatment: 'standard_25', vat_account: '2641' }, sek(1250))
    expect(result.direction_mismatch).toBe(true)
    expect(result.requires_review).toBe(true)
    expect(legs(lines)).toEqual({ '1930': [1250, 0], '6200': [0, 1000], '2641': [0, 250] })
  })
})

describe('learning a sale keeps its moms treatment', () => {
  /** Captures the insert of a new template (no existing one for the key). */
  function capturingSupabase() {
    const inserted: Record<string, unknown>[] = []
    const chain = {
      select: () => chain,
      eq: () => chain,
      contains: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async (payload: Record<string, unknown>) => {
        inserted.push(payload)
        return { error: null }
      },
    }
    return { supabase: { from: () => chain }, inserted }
  }

  it.each([
    { treatment: 'standard_25', vatAccount: '2611' },
    { treatment: 'reduced_12', vatAccount: '2621' },
    { treatment: 'reduced_6', vatAccount: '2631' },
  ] as const)('a sale booked at $treatment teaches $treatment on $vatAccount, and the next sale replays it', async ({ treatment, vatAccount }) => {
    const { supabase, inserted } = capturingSupabase()
    const first = sek(1250, { merchant_name: 'Swish inbetal', description: 'Swish inbetal', original_description: 'Swish inbetal' })
    const sale = buildMappingResultFromCategory('income_services', first, true, 'aktiebolag', treatment)
    expect(sale.vat_lines.map((l) => l.account_number)).toEqual([vatAccount])

    await upsertCounterpartyTemplate(supabase as never, 'company-1', first, sale, 'user_approved')

    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({ vat_treatment: treatment, vat_account: vatAccount })

    const learned = inserted[0] as unknown as CategorizationTemplate
    const next = sek(2500, { merchant_name: 'Swish inbetal' })
    const { lines } = book(learned, next)
    const vat = lines.find((l) => l.account_number === vatAccount)
    expect(vat?.credit_amount).toBeGreaterThan(0)
    expect(lines.find((l) => l.account_number === learned.credit_account)?.credit_amount).toBe(roundOre(2500 - (vat?.credit_amount ?? 0)))
    expectBalanced(lines)
  })
})
