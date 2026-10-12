import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  assistantSuggestionFromRead,
  categoryForAccount,
  firstSentence,
  mergeAssistantSuggestion,
  readIsFresh,
  storeRead,
  type AssistantRead,
} from '../read'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { categorizeBodyFor, previewInputFor } from '@/lib/bookkeeping/proposal'
import { computeProposalLines } from '@/lib/bookkeeping/proposal-lines'

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

const sug = (source: SuggestedTemplate['source'], confidence = 0.9): SuggestedTemplate => ({
  template_id: `${source}-x`, source, booking: { kind: 'template', template_id: 'x', category: 'expense_other' },
  name_sv: 'x', name_en: 'x', group: 'g', debit_account: '5410', credit_account: '1930',
  confidence, description_sv: '', risk_level: 'LOW', requires_review: false,
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
  it('puts an income account on the credit side', () => {
    const s = assistantSuggestionFromRead(read({ account: '3001', vat_treatment: 'standard_25', candidates: [] }), { id: 'tx-1', amount: 1000 })
    expect(s).toMatchObject({ debit_account: '1930', credit_account: '3001', booking: { kind: 'account', account: '3001', category: 'income_services' } })
    expect(s!.name_sv).not.toBe('3001')
  })
  it('previews a purchase read as bought abroad as cost against the bank, with no moms line', () => {
    const abroad = read({ account: '5890', category: 'expense_travel', vat_treatment: 'exempt', reverse_charge: false, candidates: [] })
    const s = assistantSuggestionFromRead(abroad, { id: 'tx-1', amount: -473.63 }, 'aktiebolag')!
    const lines = computeProposalLines(previewInputFor(s, { amount: -473.63, amountSek: -473.63, entityType: 'aktiebolag' }))
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
    const lines = computeProposalLines(previewInputFor(s, { amount: -200, amountSek: -200, entityType: 'aktiebolag' }))
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
    const accounts = computeProposalLines(previewInputFor(s, { amount: -200, amountSek: -200, entityType: 'aktiebolag' })).map((l) => l.account)
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
    expect(categoryForAccount('6071')).toBe('expense_representation')
  })
  it('falls back by account class', () => {
    expect(categoryForAccount('3990')).toBe('income_other')
    expect(categoryForAccount('7631')).toBe('expense_other')
  })
})

describe('mergeAssistantSuggestion', () => {
  it('sits behind a rule and a counterpart but ahead of the catalog when likely', () => {
    const out = mergeAssistantSuggestion([sug('rule'), sug('counterparty'), sug('catalog')], sug('assistant', 0.6))
    expect(out.map((s) => s.source)).toEqual(['rule', 'counterparty', 'assistant', 'catalog'])
  })
  it('goes last when unsure', () => {
    const out = mergeAssistantSuggestion([sug('catalog')], sug('assistant', 0.2))
    expect(out.map((s) => s.source)).toEqual(['catalog', 'assistant'])
  })
  it('replaces an earlier assistant suggestion instead of stacking', () => {
    const out = mergeAssistantSuggestion([sug('assistant', 0.9), sug('catalog')], sug('assistant', 0.6))
    expect(out.filter((s) => s.source === 'assistant')).toHaveLength(1)
  })
})

describe('firstSentence', () => {
  it('cuts at the first full stop and keeps a one-sentence text whole', () => {
    expect(firstSentence('En mening. En till.')).toBe('En mening.')
    expect(firstSentence('Utan punkt')).toBe('Utan punkt')
  })
})
