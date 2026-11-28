import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assistantSuggestionFromRead,
  categoryForAccount,
  firstSentence,
  readIsFresh,
  storeRead,
  type AssistantRead,
} from '../read'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { categorizeBodyFor } from '@/lib/bookkeeping/proposal'
import { buildMappingResultFromCategory } from '@/lib/bookkeeping/category-mapping'
import { buildTransactionEntryLines } from '@/lib/bookkeeping/transaction-entries'
import { reconcileRcBasisWithCostLines } from '@/lib/bookkeeping/rc-basis-reconcile'
import { chartVatTreatmentsOf } from '@/lib/bookkeeping/vat-entries'
import { toProposalLines } from '@/lib/bookkeeping/proposal-preview'
import { makeTransaction } from '@/tests/helpers'

/**
 * The lines the booking posts for a suggestion on a purchase, as the review
 * previews them: its categorize body through the category builder, the
 * override on the business side (applyAccountOverride), the line assembly.
 */
function previewedPurchase(s: SuggestedTemplate, amount: number) {
  const body = categorizeBodyFor(s)
  const tx = makeTransaction({ amount, amount_sek: amount, currency: 'SEK', exchange_rate: 1 })
  const mapping = buildMappingResultFromCategory(
    body.category!, tx, true, 'aktiebolag', body.vat_treatment, null, undefined, body.reverse_charge_kind,
  )
  if (body.account_override) mapping.debit_account = body.account_override
  return toProposalLines(tx, buildTransactionEntryLines(tx, reconcileRcBasisWithCostLines(mapping, chartVatTreatmentsOf([]))))
}

const read = (over: Partial<AssistantRead> = {}): AssistantRead => ({
  transaction_id: 'tx-1',
  underlag_key: null,
  has_underlag: false,
  account: '6570',
  category: null,
  vat_treatment: 'reverse_charge',
  reverse_charge: true,
  confidence: 0.7,
  model_confidence: 'high',
  agreement: 1,
  from_candidate: false,
  reasoning: 'Stripe fakturerar från Irland. Omvänd moms gäller.',
  candidates: [{ account: '6570', label: 'Bankavgifter', vatTreatment: 'exempt', source: 'pattern', confidence: 0.3 }],
  model: 'm',
  ...over,
})

describe('readIsFresh', () => {
  it('is fresh while the transaction still has the document it was read with', () => {
    expect(readIsFresh({ underlag_key: null }, { document_id: null })).toBe(true)
    expect(readIsFresh({ underlag_key: 'doc-1' }, { document_id: 'doc-1' })).toBe(true)
  })
  it('goes stale when a receipt is matched after the read', () => {
    expect(readIsFresh({ underlag_key: null }, { document_id: 'doc-1' })).toBe(false)
    expect(readIsFresh({ underlag_key: 'doc-1' }, { document_id: 'doc-2' })).toBe(false)
  })
})

describe('assistantSuggestionFromRead', () => {
  it('turns an expense read into a row suggestion with the account on the debit side', () => {
    const s = assistantSuggestionFromRead(read(), { id: 'tx-1', amount: -5.22 }, 'aktiebolag')
    expect(s).toMatchObject({
      template_id: 'assistant:tx-1',
      source: 'assistant',
      name_sv: 'Bankavgifter',
      debit_account: '6570',
      credit_account: '1930',
      vat_treatment: 'reverse_charge',
      booking: { kind: 'account', account: '6570', vat_treatment: 'reverse_charge', category: 'expense_bank_fees' },
      has_underlag: false,
      description_sv: 'Stripe fakturerar från Irland.',
    })
  })
  it('a pick of a candidate whose moms is unknown is reviewed with the underlag\'s moms, never read as exempt', () => {
    const s = assistantSuggestionFromRead(
      read({
        account: '5010',
        vat_treatment: null,
        reverse_charge: false,
        from_candidate: true,
        confidence: 0.9,
        has_underlag: true,
        candidates: [{ account: '5010', label: 'Lokalhyra', vatTreatment: null, vatUnknown: true, source: 'counterparty_template', confidence: 0.9 }],
      }),
      { id: 'tx-1', amount: -725 },
      'aktiebolag',
    )
    expect(s).toMatchObject({ vat_unknown: true, requires_review: true, booking: { kind: 'account', account: '5010', vat_treatment: 'standard_25' } })
    expect(s?.booking).not.toMatchObject({ vat_treatment: 'exempt' })
  })

  it('puts an income account on the credit side', () => {
    const s = assistantSuggestionFromRead(read({ account: '3001', vat_treatment: 'standard_25', candidates: [] }), { id: 'tx-1', amount: 1000 })
    expect(s).toMatchObject({ debit_account: '1930', credit_account: '3001', booking: { kind: 'account', account: '3001', category: 'income_services' } })
    expect(s!.name_sv).not.toBe('3001')
  })
  // crm#1275: the read chose the skattekonto candidate, which books no moms;
  // the suggestion took the category default and offered 1630 with 25 %.
  it('keeps a read with no moms free of moms, on a balance-sheet account too', () => {
    const skattekonto = read({
      account: '1630',
      vat_treatment: null,
      reverse_charge: false,
      candidates: [{ account: '1630', label: 'Insättning skattekonto', vatTreatment: null, source: 'pattern', confidence: 0.09 }],
    })
    const s = assistantSuggestionFromRead(skattekonto, { id: 'tx-1', amount: -12225 }, 'aktiebolag')!
    expect(s.booking).toMatchObject({ kind: 'account', account: '1630', vat_treatment: 'exempt' })
    expect(previewedPurchase(s, -12225).map((l) => [l.side, l.account, l.amount])).toEqual([
      ['debet', '1630', 12225],
      ['kredit', '1930', 12225],
    ])
  })
  it('previews a purchase read as bought abroad as cost against the bank, with no moms line', () => {
    const abroad = read({ account: '5890', category: 'expense_travel', vat_treatment: 'exempt', reverse_charge: false, candidates: [] })
    const s = assistantSuggestionFromRead(abroad, { id: 'tx-1', amount: -473.63 }, 'aktiebolag')!
    const lines = previewedPurchase(s, -473.63)
    expect(lines.map((l) => [l.side, l.account, l.amount])).toEqual([
      ['debet', '5890', 473.63],
      ['kredit', '1930', 473.63],
    ])
  })

  it('carries a service from outside the EU to the booking: ruta 22 basis in the preview and in the body', () => {
    const nonEu = read({ account: '5420', category: 'expense_software', reverse_charge_kind: 'non_eu_services', candidates: [] })
    const s = assistantSuggestionFromRead(nonEu, { id: 'tx-1', amount: -200 }, 'aktiebolag')!
    expect(s.booking).toEqual({
      kind: 'account', account: '5420', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: 'non_eu_services',
    })
    const lines = previewedPurchase(s, -200)
    expect(lines.map((l) => [l.side, l.account, l.amount])).toEqual(expect.arrayContaining([
      ['debet', '4531', 200],
      ['kredit', '4598', 200],
      ['debet', '2645', 50],
      ['kredit', '2614', 50],
    ]))
    expect(categorizeBodyFor(s)).toMatchObject({ vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services' })
  })

  it('books a reverse charge that names no box as an EU service, as reads stored before the box was kept do', () => {
    const s = assistantSuggestionFromRead(read({ account: '5420', category: 'expense_software', candidates: [] }), { id: 'tx-1', amount: -200 }, 'aktiebolag')!
    expect(s.booking).not.toHaveProperty('reverse_charge_kind')
    const accounts = previewedPurchase(s, -200).map((l) => l.account)
    expect(accounts).toContain('4535')
    expect(accounts).not.toContain('4531')
    expect(categorizeBodyFor(s)).not.toHaveProperty('reverse_charge_kind')
  })

  it('drops a box from a read whose treatment is not reverse charge', () => {
    const odd = read({ account: '5420', category: 'expense_software', vat_treatment: 'standard_25', reverse_charge_kind: 'non_eu_services', candidates: [] })
    expect(assistantSuggestionFromRead(odd, { id: 'tx-1', amount: -200 }, 'aktiebolag')!.booking).not.toHaveProperty('reverse_charge_kind')
  })

  it('is nothing when the assistant found nothing that fits', () => {
    expect(assistantSuggestionFromRead(read({ account: null }), { id: 'tx-1', amount: -1 })).toBeNull()
  })
})

describe('storeRead', () => {
  const clientWith = (upsert: ReturnType<typeof vi.fn>) => ({ from: () => ({ upsert }) }) as unknown as SupabaseClient

  it('stores the basis box with the read', async () => {
    const upsert = vi.fn(async (_row: Record<string, unknown>) => ({ error: null }))
    await storeRead(clientWith(upsert), 'co-1', read({ reverse_charge_kind: 'non_eu_services' }))
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0][0]).toMatchObject({ company_id: 'co-1', transaction_id: 'tx-1', reverse_charge_kind: 'non_eu_services' })
  })

  it('keeps the read without its box while the column has not reached the database', async () => {
    const upsert = vi
      .fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST204', message: "Could not find the 'reverse_charge_kind' column" } })
      .mockResolvedValueOnce({ error: null })
    await storeRead(clientWith(upsert), 'co-1', read({ reverse_charge_kind: 'non_eu_services' }))
    expect(upsert).toHaveBeenCalledTimes(2)
    expect(upsert.mock.calls[1][0]).not.toHaveProperty('reverse_charge_kind')
    expect(upsert.mock.calls[1][0]).toMatchObject({ transaction_id: 'tx-1', vat_treatment: 'reverse_charge' })
  })

  it('still fails on any other refusal', async () => {
    const upsert = vi.fn(async () => ({ error: { code: '23503', message: 'fk' } }))
    await expect(storeRead(clientWith(upsert), 'co-1', read())).rejects.toThrow('fk')
    expect(upsert).toHaveBeenCalledTimes(1)
  })
})

describe('categoryForAccount', () => {
  it('keeps the category the model named', () => {
    expect(categoryForAccount('5410', undefined, 'expense_office')).toBe('expense_office')
  })
  it('finds the category whose default account this is', () => {
    expect(categoryForAccount('5420')).toBe('expense_software')
    expect(categoryForAccount('6072')).toBe('expense_representation')
  })
  // accounted#86: both representation accounts are representation, so the
  // deductible 6071 (enklare förtäring) does not read as expense_other and
  // slip past the grant refusal of representation.
  it('reads every representation account as representation', () => {
    expect(categoryForAccount('6071')).toBe('expense_representation')
    expect(categoryForAccount('6070', 'aktiebolag')).toBe('expense_representation')
  })
  it('falls back by account class', () => {
    expect(categoryForAccount('3990')).toBe('income_other')
    expect(categoryForAccount('7631')).toBe('expense_other')
  })
})

describe('firstSentence', () => {
  it('cuts at the first full stop and keeps a one-sentence text whole', () => {
    expect(firstSentence('En mening. En till.')).toBe('En mening.')
    expect(firstSentence('Utan punkt')).toBe('Utan punkt')
  })
})
