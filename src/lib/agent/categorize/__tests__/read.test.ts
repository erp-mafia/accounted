import { describe, it, expect } from 'vitest'
import {
  assistantSuggestionFromRead,
  categoryForAccount,
  firstSentence,
  mergeAssistantSuggestion,
  readIsFresh,
  type AssistantRead,
} from '../read'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'

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
  it('is nothing when the assistant found nothing that fits', () => {
    expect(assistantSuggestionFromRead(read({ account: null }), { id: 'tx-1', amount: -1 })).toBeNull()
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
