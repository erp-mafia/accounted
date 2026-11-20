import { describe, it, expect } from 'vitest'
import { leadWithSkattekonto } from '../propose'
import { buildCounterpartySuggestion, getSuggestedTemplates, rowProposal } from '../category-suggestions'
import { booksWithoutReview } from '../direct-booking'
import { accountProposal, proposalFromTemplate } from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { makeCategorizationTemplate, makeTransaction } from '@/tests/helpers'

/**
 * crm#1275: a payment to Skatteverket was offered 5890 with 25 % moms (a
 * template learned from a booking undone two seconds later) above the
 * catalog's preliminary tax (2518), which itself ranked above 1630. The bank line only ever
 * touches the skattekonto (swedish-daily-bookkeeping, skattekonto-and-owner.md
 * §1.1), so that proposal now leads.
 */
const SKV_TEXT = 'SKATTEVERKET     BG 0000050501055 Bg-bet. via internet'
const skvPayment = (amount = -12225) =>
  makeTransaction({ amount, merchant_name: null, description: SKV_TEXT, original_description: SKV_TEXT })

const learnedTravel = buildCounterpartySuggestion(
  makeCategorizationTemplate({ counterparty_name: 'skatteverket bg bgbet via internet', debit_account: '5890', occurrence_count: 2 }),
  0.45,
)

describe('leadWithSkattekonto', () => {
  it('puts Insättning skattekonto first where the catalog ranked preliminary tax first', async () => {
    const tx = skvPayment()
    const catalog = await getSuggestedTemplates(tx, 'aktiebolag')
    expect(catalog[0].debit_account).toBe('2518')

    const led = leadWithSkattekonto(catalog, tx)

    expect(led[0]).toMatchObject({ template_id: 'financial_tax_account', source: 'catalog', debit_account: '1630', vat_treatment: null })
    expect(led.filter((p) => p.template_id === 'financial_tax_account')).toHaveLength(1)
    expect(led.map((p) => p.debit_account)).toContain('2518')
    expect(rowProposal(led)?.template_id).toBe('financial_tax_account')
  })

  it('always goes to a review: the catalog never books on its own', () => {
    const [lead] = leadWithSkattekonto([], skvPayment())
    expect(booksWithoutReview(lead)).toBe(false)
  })

  it('moves a learned counterpart and the assistant below it', () => {
    const assistant = accountProposal({
      id: 'assistant:t1', source: 'assistant', account: '2510', label: 'Skatteskulder', category: 'expense_other', vat_treatment: 'exempt', amount: -12225, confidence: 0.9,
    })

    const led = leadWithSkattekonto([learnedTravel, assistant], skvPayment())

    expect(led.map((p) => p.template_id)).toEqual(['financial_tax_account', learnedTravel.template_id, 'assistant:t1'])
  })

  it('keeps a rule of the company\'s own on the skattekonto in front, and booking on its own', () => {
    const tmpl = getTemplateById('financial_tax_account')!
    const ownRule = { ...proposalFromTemplate(tmpl, 'rule', 0.9), rule_own: true, rule_requires_review: false }

    const led = leadWithSkattekonto([learnedTravel, ownRule], skvPayment())

    expect(led[0]).toBe(ownRule)
    expect(booksWithoutReview(led[0])).toBe(true)
    expect(led).toHaveLength(2)
  })

  it('leaves other rows and money in from Skatteverket as they were', () => {
    const list = [learnedTravel]
    expect(leadWithSkattekonto(list, makeTransaction({ merchant_name: 'Telia Sverige AB', amount: -500 }))).toBe(list)
    expect(leadWithSkattekonto(list, skvPayment(4500))).toBe(list)
  })
})
