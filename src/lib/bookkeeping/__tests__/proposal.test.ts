import { describe, it, expect } from 'vitest'
import {
  accountProposal,
  businessAccount,
  carriedCategory,
  categorizeArgsFor,
  categorizeBodyFor,
  proposalFromTemplate,
  slateAccount,
  whyKeyFor,
  whyTextSv,
  PROPOSAL_REVERSE_CHARGE_KINDS,
  reverseChargeKindOf,
  withAccount,
  withReverseChargeKind,
  type BookingProposal,
} from '../proposal'
import { getTemplateById } from '../booking-templates'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import { toProposalLines } from '../proposal-preview'
import type { Transaction } from '@/types'

const mobile = getTemplateById('telecom_mobile')!
const stripe = getTemplateById('payment_fees_eu')!

describe('proposalFromTemplate', () => {
  it('books a catalog template as the template, keeping its legs and VAT', () => {
    const p = proposalFromTemplate(mobile, 'catalog', 0.3)
    expect(p.booking).toEqual({ kind: 'template', template_id: 'telecom_mobile', category: mobile.fallback_category })
    expect(p).toMatchObject({ name_sv: 'Mobilabonnemang', debit_account: '6212', credit_account: '1930', vat_treatment: 'standard_25', source: 'catalog', confidence: 0.3 })
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

  // PostHog 170: the review kept naming the machine's pick over an account
  // the person had changed, and nothing told the two apart when it closed.
  it('makes the booking the person\'s own, named by the account they picked', () => {
    const assistant = accountProposal({
      id: 'assistant:t1', source: 'assistant', account: '6991', label: 'Övriga kostnader',
      category: 'expense_other', vat_treatment: 'standard_25', amount: -100,
      confidence: 0.5, description: 'Ser ut som en övrig kostnad.', has_underlag: true,
    })
    const p = withAccount({ ...assistant, default_dimensions: { '1': 'KS01' } }, '7699', 'standard_25', -100, 'Övriga personalkostnader')
    expect(p).toEqual({
      template_id: 'account:7699',
      source: 'manual',
      booking: { kind: 'account', account: '7699', vat_treatment: 'standard_25', category: 'expense_other' },
      name_sv: 'Övriga personalkostnader',
      name_en: 'Övriga personalkostnader',
      group: 'account',
      debit_account: '7699',
      credit_account: '1930',
      confidence: 1,
      description_sv: '',
      risk_level: 'LOW',
      requires_review: false,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
    })
    expect(whyKeyFor(p)).toEqual({ key: 'rec_why_manual' })
  })

  it('keeps the name when only the VAT changes', () => {
    const assistant = accountProposal({
      id: 'assistant:t1', source: 'assistant', account: '5410', label: 'Förbrukningsinventarier',
      category: 'expense_equipment', vat_treatment: 'standard_25', amount: -100,
    })
    const p = withAccount(assistant, '5410', 'reduced_12', -100)
    expect(p).toMatchObject({ source: 'manual', name_sv: 'Förbrukningsinventarier', vat_treatment: 'reduced_12' })
    expect(p.booking).toEqual({ kind: 'account', account: '5410', vat_treatment: 'reduced_12', category: 'expense_equipment' })
  })

  it('leaves a counterpart rule\'s lines and evidence behind', () => {
    const cp: BookingProposal = {
      template_id: 'cp:abc', source: 'counterparty', booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
      name_sv: 'Telia', name_en: 'Telia', group: 'counterparty', debit_account: '6211', credit_account: '1930', confidence: 0.9,
      description_sv: '', risk_level: 'NONE', requires_review: false, seen_count: 4, rule_mode: 'auto',
      line_pattern: [{ account: '6211', type: 'business', share: 1 } as never],
    }
    const p = withAccount(cp, '6230', 'standard_25', -100, 'Datakommunikation')
    expect(p.booking).toEqual({ kind: 'account', account: '6230', vat_treatment: 'standard_25', category: 'expense_other' })
    expect(p).not.toHaveProperty('line_pattern')
    expect(p).not.toHaveProperty('seen_count')
    expect(p).not.toHaveProperty('rule_mode')
  })

  // PostHog 170: the assistant read an invoice with 25 % moms as a private
  // cost (2893 in an aktiebolag, category 'private'). The person set a cost
  // account instead and the review said 25 %, but the category stayed
  // 'private', which books no moms line on any account.
  describe('over the assistant\'s private pick', () => {
    const privatePick = accountProposal({
      id: 'assistant:t1', source: 'assistant', account: '2893', label: 'Skuld till ägare',
      category: 'private', vat_treatment: 'exempt', amount: -1000,
    })

    it('books a cost account set by hand as a cost, with the moms the review shows', () => {
      const p = withAccount(privatePick, '7699', 'standard_25', -1000)
      expect(p.booking).toEqual({ kind: 'account', account: '7699', vat_treatment: 'standard_25', category: 'expense_other' })
      expect(categorizeBodyFor(p)).toMatchObject({ category: 'expense_other', account_override: '7699', vat_treatment: 'standard_25' })

      // The preview books the body: the category builder, the override on the business side.
      const body = categorizeBodyFor(p)
      const tx = { id: 't1', amount: -1000, currency: 'SEK', amount_sek: -1000, exchange_rate: 1 } as unknown as Transaction
      const mapping = buildMappingResultFromCategory(body.category!, tx, true, 'aktiebolag', body.vat_treatment)
      mapping.debit_account = body.account_override!
      expect(toProposalLines(tx, buildTransactionEntryLines(tx, mapping))).toEqual(expect.arrayContaining([
        { side: 'debet', account: '7699', amount: 800 },
        { side: 'debet', account: '2641', amount: 200 },
        { side: 'kredit', account: '1930', amount: 1000, settlement: true },
      ]))
    })

    it('sends a category the server books moms for (the private one booked none)', () => {
      const tx = { id: 't1', amount: -1000, currency: 'SEK', amount_sek: null, exchange_rate: null } as unknown as Transaction
      const carried = buildMappingResultFromCategory('private', tx, true, 'aktiebolag', 'standard_25', null, true)
      expect(carried.vat_lines).toEqual([])

      const { category, vat_treatment } = categorizeBodyFor(withAccount(privatePick, '7699', 'standard_25', -1000))
      const booked = buildMappingResultFromCategory(category!, tx, true, 'aktiebolag', vat_treatment, null, true)
      expect(booked.vat_lines).toEqual([
        expect.objectContaining({ account_number: '2641', debit_amount: 200, credit_amount: 0 }),
      ])
    })

    it('stays private while the person keeps it on a balance-sheet account', () => {
      const p = withAccount(privatePick, '2898', 'exempt', -1000)
      expect(p.booking).toEqual({ kind: 'account', account: '2898', vat_treatment: 'exempt', category: 'private' })
    })
  })
})

describe('carriedCategory', () => {
  it('carries an expense or income category over to the new account', () => {
    expect(carriedCategory('expense_representation', '6072', -100)).toBe('expense_representation')
    expect(carriedCategory('income_services', '3002', 100)).toBe('income_services')
  })
  it('does not carry a category that books no moms onto a cost or revenue account', () => {
    expect(carriedCategory('private', '7699', -100)).toBe('expense_other')
    expect(carriedCategory('private', '3001', 100)).toBe('income_other')
    expect(carriedCategory('uncategorized', '5410', -100)).toBe('expense_other')
  })
  it('keeps it on a balance-sheet account, which carries no moms either way', () => {
    expect(carriedCategory('private', '2893', -100)).toBe('private')
    expect(carriedCategory('private', '2018', 100)).toBe('private')
  })
  it('keeps the basis box of a reverse charge across an account change, and off the booking under another treatment', () => {
    const nonEu = accountProposal({ id: 'a', source: 'assistant', account: '5420', label: 'x', category: 'expense_software', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', amount: -200 })
    const moved = withAccount(nonEu, '6540', 'reverse_charge', -200)
    expect(moved.booking).toEqual({ kind: 'account', account: '6540', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: 'non_eu_services' })
    const swedish = withAccount(moved, '6540', 'standard_25', -200)
    expect(swedish.booking).not.toHaveProperty('reverse_charge_kind')
    expect(categorizeBodyFor(swedish)).not.toHaveProperty('reverse_charge_kind')
  })
})

// accounted#35: picking the VAT treatment again gave plain reverse charge,
// which books an EU service (ruta 21), and nothing in the review could name
// another box.
describe('the basis box of a reverse charge in the review', () => {
  const nonEu = accountProposal({ id: 'assistant:t1', source: 'assistant', account: '5420', label: 'Programvaror', category: 'expense_software', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', amount: -200 })

  it('comes back with the box the review last held when the person leaves reverse charge and picks it again', () => {
    const swedish = withAccount(nonEu, '5420', 'standard_25', -200, undefined, reverseChargeKindOf(nonEu))
    const again = withAccount(swedish, '5420', 'reverse_charge', -200, undefined, 'non_eu_services')
    expect(again.booking).toEqual({ kind: 'account', account: '5420', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: 'non_eu_services' })
  })

  it('prefers the box the booking has over the one remembered', () => {
    const p = withAccount(nonEu, '6540', 'reverse_charge', -200, undefined, 'eu_goods')
    expect(reverseChargeKindOf(p)).toBe('non_eu_services')
  })

  it('names no box when none was ever said, so the server books its EU-service default', () => {
    const swedish = accountProposal({ id: 'a', source: 'assistant', account: '6540', label: 'x', category: 'expense_software', vat_treatment: 'standard_25', amount: -200 })
    const rc = withAccount(swedish, '6540', 'reverse_charge', -200)
    expect(rc.booking).not.toHaveProperty('reverse_charge_kind')
    expect(reverseChargeKindOf(rc)).toBeUndefined()
  })

  it('lets the person pick each box, on the account the booking has, as their own booking', () => {
    for (const kind of PROPOSAL_REVERSE_CHARGE_KINDS) {
      const p = withReverseChargeKind(nonEu, kind, -200)
      expect(p.booking).toEqual({ kind: 'account', account: '5420', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: kind })
      expect(p).toMatchObject({ source: 'manual', name_sv: 'Programvaror' })
      expect(categorizeBodyFor(p)).toEqual({
        is_business: true, category: 'expense_software', account_override: '5420', vat_treatment: 'reverse_charge', reverse_charge_kind: kind,
      })
    }
  })

  it('turns a catalog template into a reverse charge on its business account when a box is picked', () => {
    const p = withReverseChargeKind(proposalFromTemplate(mobile, 'catalog'), 'eu_services', -100)
    expect(p.booking).toEqual({ kind: 'account', account: '6212', vat_treatment: 'reverse_charge', category: mobile.fallback_category, reverse_charge_kind: 'eu_services' })
  })

  it('carries the box a catalog template books when the person sets another account on it', () => {
    const saasNonEu = proposalFromTemplate(getTemplateById('it_saas_non_eu')!, 'catalog')
    expect(reverseChargeKindOf(saasNonEu)).toBe('non_eu_services')
    const moved = withAccount(saasNonEu, '6540', 'reverse_charge', -200)
    expect(moved.booking).toMatchObject({ account: '6540', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services' })
    expect(reverseChargeKindOf(proposalFromTemplate(mobile, 'catalog'))).toBeUndefined()
  })

  it('offers the three boxes the categorize body takes, in momsdeklaration order', () => {
    expect(PROPOSAL_REVERSE_CHARGE_KINDS).toEqual(['eu_goods', 'eu_services', 'non_eu_services'])
  })

  it.each([
    ['eu_goods', '4515'],
    ['eu_services', '4535'],
    ['non_eu_services', '4531'],
  ] as const)('books %s with its basis on %s against 4598, fiktiv moms 2645/2614', (kind, basis) => {
    const body = categorizeBodyFor(withReverseChargeKind(nonEu, kind, -1000))
    const tx = { id: 't1', amount: -1000, currency: 'SEK', amount_sek: -1000, exchange_rate: 1 } as unknown as Transaction
    const mapping = buildMappingResultFromCategory(body.category!, tx, true, 'aktiebolag', body.vat_treatment, null, true, body.reverse_charge_kind)
    expect(mapping.vat_lines).toEqual([
      expect.objectContaining({ account_number: '2645', debit_amount: 250, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2614', debit_amount: 0, credit_amount: 250 }),
      expect.objectContaining({ account_number: basis, debit_amount: 1000, credit_amount: 0 }),
      expect.objectContaining({ account_number: '4598', debit_amount: 0, credit_amount: 1000 }),
    ])
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
  it('spells the box a catalog template books, so an agent books a non-EU template in ruta 22 (accounted#37)', () => {
    expect(categorizeArgsFor(proposalFromTemplate(getTemplateById('it_saas_non_eu')!, 'catalog'))?.vat_treatment).toBe('reverse_charge_non_eu_services')
    expect(categorizeArgsFor(proposalFromTemplate(getTemplateById('it_saas_eu')!, 'catalog'))?.vat_treatment).toBe('reverse_charge')
  })
})

describe('categorizeBodyFor: the body the preview shows and the booking posts', () => {
  it('names a catalog template by id, the server resolving its accounts for the legal form', () => {
    expect(categorizeBodyFor(proposalFromTemplate(stripe, 'catalog'))).toMatchObject({ is_business: true, template_id: stripe.id })
  })
  it('books an account on the category path with the explicit VAT', () => {
    const p = accountProposal({ id: 'a', source: 'assistant', account: '6071', label: 'x', category: 'expense_representation', vat_treatment: 'reduced_12', amount: -45 })
    expect(categorizeBodyFor(p)).toMatchObject({ category: 'expense_representation', account_override: '6071', vat_treatment: 'reduced_12' })
  })
  it('books a counterpart pattern by its template, on its own lines', () => {
    const p: BookingProposal = {
      template_id: 'cp:abc', source: 'counterparty', booking: { kind: 'counterparty', counterparty_template_id: 'abc' },
      name_sv: 'Telia', name_en: 'Telia', group: 'counterparty', debit_account: '6211', credit_account: '1930', confidence: 0.9,
      description_sv: '', risk_level: 'NONE', requires_review: false,
      line_pattern: [{ account: '6211', type: 'business', share: 1 } as never],
    }
    expect(categorizeBodyFor(p)).toMatchObject({ is_business: true, counterparty_template_id: 'abc' })
    expect(categorizeBodyFor(p)).not.toHaveProperty('account_override')
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
