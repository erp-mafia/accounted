import { describe, it, expect } from 'vitest'
import {
  accountProposal,
  businessAccount,
  categorizeArgsFor,
  categorizeBodyFor,
  previewInputFor,
  proposalFromTemplate,
  slateAccount,
  whyKeyFor,
  whyTextSv,
  withAccount,
  type BookingProposal,
} from '../proposal'
import { getTemplateById } from '../booking-templates'
import { computeProposalLines } from '../proposal-lines'

const mobile = getTemplateById('telecom_mobile')!
const stripe = getTemplateById('payment_fees_eu')!

describe('proposalFromTemplate', () => {
  it('books a catalog template as the template, keeping its legs and VAT', () => {
    const p = proposalFromTemplate(mobile, 'catalog', 0.3)
    expect(p.booking).toEqual({ kind: 'template', template_id: 'telecom_mobile', category: mobile.fallback_category })
    expect(p).toMatchObject({ name_sv: 'Mobilabonnemang', debit_account: '6211', credit_account: '1930', vat_treatment: 'standard_25', source: 'catalog', confidence: 0.3 })
  })
})

describe('accountProposal', () => {
  it('puts the account on the debit side of an expense and takes the category VAT when none is given', () => {
    const p = accountProposal({ id: 'assistant:t1', source: 'assistant', account: '6071', label: 'Representation', category: 'expense_representation', vat_treatment: null, amount: -45 })
    expect(p.booking).toEqual({ kind: 'account', account: '6071', vat_treatment: 'reduced_12', category: 'expense_representation' })
    expect(p.debit_account).toBe('6071')
    expect(p.credit_account).toBe('1930')
  })
  it('puts an income account on the credit side', () => {
    const p = accountProposal({ id: 'account:3001', source: 'manual', account: '3001', label: 'Försäljning', category: 'income_services', vat_treatment: 'standard_25', amount: 1000 })
    expect(businessAccount(p)).toBe('3001')
    expect(p.credit_account).toBe('3001')
  })
})

describe('withAccount', () => {
  it('turns any proposal into an account booking with the person\'s account and VAT', () => {
    const p = withAccount(proposalFromTemplate(mobile, 'rule'), '6230', 'standard_25', -100)
    expect(p.booking).toEqual({ kind: 'account', account: '6230', vat_treatment: 'standard_25', category: mobile.fallback_category })
    expect(p.debit_account).toBe('6230')
  })
  it('keeps the basis box of a reverse charge across an account change, and drops it when the person picks the VAT anew', () => {
    const nonEu = accountProposal({ id: 'a', source: 'assistant', account: '5420', label: 'x', category: 'expense_software', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', amount: -200 })
    const moved = withAccount(nonEu, '6540', 'reverse_charge', -200)
    expect(moved.booking).toEqual({ kind: 'account', account: '6540', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: 'non_eu_services' })
    const swedish = withAccount(moved, '6540', 'standard_25', -200)
    expect(swedish.booking).not.toHaveProperty('reverse_charge_kind')
    expect(withAccount(swedish, '6540', 'reverse_charge', -200).booking).not.toHaveProperty('reverse_charge_kind')
  })
})

describe('categorizeBodyFor', () => {
  it('sends a template by id', () => {
    expect(categorizeBodyFor(proposalFromTemplate(mobile, 'catalog'), { dimensions: { '1': 'KS01' } })).toEqual({
      is_business: true, category: mobile.fallback_category, template_id: 'telecom_mobile', dimensions: { '1': 'KS01' },
      proposal_id: 'telecom_mobile',
    })
  })
  it('sends a counterpart by its rule id and nothing else the server would ignore', () => {
    const p: BookingProposal = {
      template_id: 'cp:abc', source: 'counterparty', booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
      name_sv: 'Telia', name_en: 'Telia', group: 'counterparty', debit_account: '6211', credit_account: '1930', confidence: 0.9,
      description_sv: '', risk_level: 'NONE', requires_review: false,
    }
    expect(categorizeBodyFor(p, { vatAmount: 5 })).toEqual({ is_business: true, counterparty_template_id: 'abc', proposal_id: 'cp:abc' })
  })
  it('sends an account with its explicit VAT, never leaving the server to guess', () => {
    const p = accountProposal({ id: 'a', source: 'assistant', account: '6570', label: 'x', category: 'expense_bank_fees', vat_treatment: 'reverse_charge', amount: -5 })
    expect(categorizeBodyFor(p, { vatAmount: 1 })).toEqual({
      is_business: true, category: 'expense_bank_fees', account_override: '6570', vat_treatment: 'reverse_charge', vat_amount: 1,
      proposal_id: 'a',
    })
  })
  it('sends the basis box of a reverse charge that names one', () => {
    const p = accountProposal({ id: 'a', source: 'assistant', account: '5420', label: 'x', category: 'expense_software', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', amount: -200 })
    expect(categorizeBodyFor(p)).toEqual({
      is_business: true, category: 'expense_software', account_override: '5420', vat_treatment: 'reverse_charge',
      reverse_charge_kind: 'non_eu_services', proposal_id: 'a',
    })
  })
  it('names no suggestion for an account the person picked', () => {
    const p = accountProposal({ id: 'account:6570', source: 'manual', account: '6570', label: 'x', category: 'expense_bank_fees', vat_treatment: 'exempt', amount: -5 })
    expect(categorizeBodyFor(p)).not.toHaveProperty('proposal_id')
  })
})

describe('categorizeArgsFor', () => {
  it('hands an agent the booking arguments plus the proposal id to name it by', () => {
    const p = accountProposal({ id: 'assistant:tx-1', source: 'assistant', account: '6570', label: 'x', category: 'expense_bank_fees', vat_treatment: 'exempt', amount: -5 })
    expect(categorizeArgsFor(p)).toEqual({
      category: 'expense_bank_fees', account_override: '6570', vat_treatment: 'exempt', proposal_id: 'assistant:tx-1',
    })
  })
  it('spells a reverse charge with a basis box the way categorize_transaction takes it', () => {
    const base = { id: 'assistant:tx-1', source: 'assistant' as const, account: '5420', label: 'x', category: 'expense_software' as const, vat_treatment: 'reverse_charge' as const, amount: -200 }
    expect(categorizeArgsFor(accountProposal({ ...base, reverse_charge_kind: 'non_eu_services' }))?.vat_treatment).toBe('reverse_charge_non_eu_services')
    expect(categorizeArgsFor(accountProposal({ ...base, reverse_charge_kind: 'eu_services' }))?.vat_treatment).toBe('reverse_charge_eu_services')
    expect(categorizeArgsFor(accountProposal(base))?.vat_treatment).toBe('reverse_charge')
  })
})

describe('previewInputFor', () => {
  it('previews a template with its entity-resolved accounts and VAT rate', () => {
    const input = previewInputFor(proposalFromTemplate(stripe, 'catalog'), { amount: -100, amountSek: -100, entityType: 'aktiebolag' })
    expect(input).toMatchObject({ templateDebitAccount: '6570', templateCreditAccount: '1930', templateVatTreatment: 'reverse_charge' })
    const lines = computeProposalLines(input)
    expect(lines.map((l) => l.account)).toContain('6570')
  })
  it('previews an account booking on the category path with the explicit VAT', () => {
    const p = accountProposal({ id: 'a', source: 'assistant', account: '6071', label: 'x', category: 'expense_representation', vat_treatment: 'reduced_12', amount: -45 })
    const input = previewInputFor(p, { amount: -45, amountSek: -45 })
    expect(input).toMatchObject({ category: 'expense_representation', accountOverride: '6071', vatTreatment: 'reduced_12' })
    const accounts = computeProposalLines(input).map((l) => l.account)
    expect(accounts).toContain('6071')
    expect(accounts).toContain('2641')
  })
  it('previews a counterpart pattern on its own lines', () => {
    const p: BookingProposal = {
      template_id: 'cp:abc', source: 'counterparty', booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
      name_sv: 'Telia', name_en: 'Telia', group: 'counterparty', debit_account: '6211', credit_account: '1930', confidence: 0.9,
      description_sv: '', risk_level: 'NONE', requires_review: false,
      line_pattern: [{ account: '6211', type: 'business', share: 1 } as never],
    }
    expect(previewInputFor(p, { amount: -100, amountSek: -100 })).toMatchObject({ linePattern: p.line_pattern, templateDebitAccount: '6211' })
  })
})

describe('whyKeyFor', () => {
  it('names the evidence per source', () => {
    expect(whyKeyFor({ source: 'rule' } as BookingProposal)).toEqual({ key: 'rec_why_rule' })
    expect(whyKeyFor({ source: 'counterparty', seen_count: 4 } as BookingProposal)).toEqual({ key: 'rec_why_counterparty', values: { count: 4 } })
    expect(whyKeyFor({ source: 'assistant', has_underlag: true } as BookingProposal)).toEqual({ key: 'rec_why_assistant_doc' })
    expect(whyKeyFor({ source: 'manual' } as BookingProposal)).toEqual({ key: 'rec_why_manual' })
  })
})

describe('whyTextSv', () => {
  it('tells an agent when a counterpart match is contested', () => {
    const seen = { source: 'counterparty', seen_count: 1 } as BookingProposal
    expect(whyTextSv(seen)).toBe('Bokförd så 1 gång tidigare')
    expect(whyTextSv({ ...seen, contested: true })).toBe(
      'Bokförd så 1 gång tidigare, men matchningen är svag och assistentens läsning av raden bokför annorlunda',
    )
  })
})

describe('slateAccount', () => {
  it('is the first business line of a learned pattern, otherwise the leg that is not the bank', () => {
    expect(slateAccount({ debit_account: '5420', credit_account: '1930' })).toBe('5420')
    expect(
      slateAccount({
        debit_account: '1930',
        credit_account: '1930',
        line_pattern: [
          { account: '2641', type: 'vat', side: 'debit', ratio: 0.2 },
          { account: '6211', type: 'business', side: 'debit', ratio: 0.8 },
        ] as BookingProposal['line_pattern'],
      }),
    ).toBe('6211')
  })
})
