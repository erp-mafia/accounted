import { describe, it, expect } from 'vitest'
import { disputeReverseChargeBox } from '../propose'
import { buildCounterpartySuggestion, rowProposal } from '../category-suggestions'
import { booksWithoutReview } from '../direct-booking'
import {
  accountProposal,
  categorizeBodyFor,
  inReverseChargeBox,
  proposalFromTemplate,
  reverseChargeBoxDispute,
  reverseChargeBoxesOf,
  whyTextSv,
  type BookingProposal,
} from '@/lib/bookkeeping/proposal'
import { getTemplateById } from '@/lib/bookkeeping/booking-templates'
import { makeCategorizationTemplate } from '@/tests/helpers'
import type { AssistantRead } from '@/lib/agent/categorize/read'
import type { CategorizationTemplate, LinePatternEntry } from '@/types'

/**
 * accounted#37: the assistant's read says a software vendor's purchase is a
 * service from outside the EU (ruta 22, 4531), while the company's learned
 * counterpart books it as an EU service (ruta 21, 4535), the default a
 * counterpart learned as one pair always books. Settled counterparts (three
 * bookings or more) used to book straight from the row in the EU box.
 */
type Read = Pick<AssistantRead, 'vat_treatment' | 'reverse_charge_kind'>
const NON_EU: Read = { vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services' }
const EU: Read = { vat_treatment: 'reverse_charge', reverse_charge_kind: 'eu_services' }

function counterpart(template: Partial<CategorizationTemplate> = {}): BookingProposal {
  return buildCounterpartySuggestion(
    makeCategorizationTemplate({
      counterparty_name: 'openai',
      debit_account: '5420',
      vat_treatment: 'reverse_charge',
      vat_account: null,
      occurrence_count: 7,
      mode: 'propose',
      ...template,
    }),
    0.95,
  )
}

/** An SIE-learned pattern: the cost line and the basis pair beside it. */
function pattern(basis: string, costs: Array<[string, number]> = [['5420', 1]]): LinePatternEntry[] {
  return [
    ...costs.map(([account, ratio]): LinePatternEntry => ({ account, type: 'business', side: 'debit', ratio, dimensions: { '1': 'KS01' } })),
    { account: basis, type: 'business', side: 'debit', ratio: 1 },
    { account: '4598', type: 'business', side: 'credit', ratio: 1 },
  ]
}

describe('disputeReverseChargeBox', () => {
  it('sends a settled counterpart to review when the read names another box', () => {
    const cp = counterpart()
    expect(booksWithoutReview(cp)).toBe(true)
    const [out] = disputeReverseChargeBox([cp], NON_EU)
    expect(out.read_reverse_charge_kind).toBe('non_eu_services')
    expect(reverseChargeBoxDispute(out)).toEqual({ proposal: 'eu_services', read: 'non_eu_services' })
    // Still the row's recommendation, so Bokför opens the review on it.
    expect(rowProposal([out])).toBe(out)
    expect(booksWithoutReview(out)).toBe(false)
  })

  it('also stops a counterpart on auto and a mapping rule of the company\'s own', () => {
    const [auto] = disputeReverseChargeBox([counterpart({ mode: 'auto', occurrence_count: 1 })], NON_EU)
    expect(booksWithoutReview(auto)).toBe(false)
    const rule = { ...proposalFromTemplate(getTemplateById('it_saas_eu')!, 'rule', 0.9), rule_own: true }
    expect(booksWithoutReview(rule)).toBe(true)
    const [disputed] = disputeReverseChargeBox([rule], NON_EU)
    expect(booksWithoutReview(disputed)).toBe(false)
  })

  it('books as before when the read names the same box', () => {
    const [out] = disputeReverseChargeBox([counterpart()], EU)
    expect(out.read_reverse_charge_kind).toBeUndefined()
    expect(booksWithoutReview(out)).toBe(true)
  })

  it('books as before when the read names no box', () => {
    const cp = counterpart()
    for (const read of [
      { vat_treatment: 'reverse_charge', reverse_charge_kind: null },
      { vat_treatment: 'reverse_charge' },
      { vat_treatment: 'standard_25', reverse_charge_kind: null },
      { vat_treatment: null, reverse_charge_kind: null },
    ] as Read[]) {
      const [out] = disputeReverseChargeBox([cp], read)
      expect(out).toBe(cp)
      expect(booksWithoutReview(out)).toBe(true)
    }
  })

  it('leaves a proposal that books neither reverse charge nor Swedish moms alone', () => {
    const noVat = counterpart({ vat_treatment: 'exempt', vat_account: null })
    const [out] = disputeReverseChargeBox([noVat], NON_EU)
    expect(out).toBe(noVat)
    expect(booksWithoutReview(out)).toBe(true)
  })

  it('reads a learned pattern\'s box off its basis account', () => {
    const nonEuPattern = counterpart({ vat_treatment: null, line_pattern: pattern('4531') })
    expect(reverseChargeBoxesOf(nonEuPattern)).toEqual(['non_eu_services'])
    expect(disputeReverseChargeBox([nonEuPattern], NON_EU)[0].read_reverse_charge_kind).toBeUndefined()
    expect(disputeReverseChargeBox([nonEuPattern], EU)[0].read_reverse_charge_kind).toBe('eu_services')
  })

  it('compares a catalog template by the box its supplier type books', () => {
    const saasEu = proposalFromTemplate(getTemplateById('it_saas_eu')!, 'catalog', 0.8)
    const saasNonEu = proposalFromTemplate(getTemplateById('it_saas_non_eu')!, 'catalog', 0.8)
    const out = disputeReverseChargeBox([saasEu, saasNonEu], NON_EU)
    expect(out.map((p) => p.read_reverse_charge_kind)).toEqual(['non_eu_services', undefined])
  })

  it('never marks the assistant\'s own proposal', () => {
    const read = accountProposal({
      id: 'assistant:tx-1', source: 'assistant', account: '5420', label: 'Programvaror', category: 'expense_software',
      vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', amount: -200,
    })
    expect(disputeReverseChargeBox([read], EU)[0]).toBe(read)
  })
})

/**
 * crm#1498: a learned counterpart (or a catalog keyword) booked Google Ads and
 * ChatGPT with Swedish ingående moms on 2641 straight from the row, while the
 * assistant's read had placed the seller abroad. The read's box now disputes
 * the Swedish moms the way it disputes another box.
 */
describe('disputeReverseChargeBox: Swedish moms on a purchase the read places abroad', () => {
  const swedish = () => counterpart({ counterparty_name: 'google ads', debit_account: '5910', vat_treatment: 'standard_25', vat_account: '2641' })

  it('sends a settled counterpart with Swedish moms to review on the read\'s box', () => {
    const cp = swedish()
    expect(booksWithoutReview(cp)).toBe(true)
    const [out] = disputeReverseChargeBox([cp], EU)
    expect(out.read_reverse_charge_kind).toBe('eu_services')
    expect(reverseChargeBoxDispute(out)).toEqual({ proposal: 'swedish_vat', read: 'eu_services' })
    expect(rowProposal([out])).toBe(out)
    expect(booksWithoutReview(out)).toBe(false)
    // The review opens as reverse charge on the counterpart's own account.
    const opened = inReverseChargeBox(out, 'eu_services', -3000, 'aktiebolag')!
    expect(opened.booking).toEqual({
      kind: 'account', account: '5910', vat_treatment: 'reverse_charge', category: 'expense_other', reverse_charge_kind: 'eu_services',
    })
    expect(reverseChargeBoxDispute(opened)).toBeNull()
  })

  it('reads Swedish moms off a learned pattern\'s 2641 line', () => {
    const cp = counterpart({
      vat_treatment: null,
      line_pattern: [
        { account: '6540', type: 'business', side: 'debit', ratio: 1 },
        { account: '2641', type: 'vat', side: 'debit', vat_rate: 0.25 },
      ],
    })
    const [out] = disputeReverseChargeBox([cp], NON_EU)
    expect(reverseChargeBoxDispute(out)).toEqual({ proposal: 'swedish_vat', read: 'non_eu_services' })
    expect(booksWithoutReview(out)).toBe(false)
  })

  it('marks the catalog\'s Swedish-moms template too', () => {
    const domestic = proposalFromTemplate(getTemplateById('it_saas_subscription')!, 'catalog', 0.9)
    const [out] = disputeReverseChargeBox([domestic], NON_EU)
    expect(reverseChargeBoxDispute(out)).toEqual({ proposal: 'swedish_vat', read: 'non_eu_services' })
  })

  it('books as before when the read names no box or Swedish moms', () => {
    const cp = swedish()
    for (const read of [
      { vat_treatment: 'reverse_charge', reverse_charge_kind: null },
      { vat_treatment: 'standard_25', reverse_charge_kind: null },
      { vat_treatment: 'exempt', reverse_charge_kind: null },
    ] as Read[]) {
      const [out] = disputeReverseChargeBox([cp], read)
      expect(out).toBe(cp)
      expect(booksWithoutReview(out)).toBe(true)
    }
  })

  it('leaves money in alone', () => {
    const refund = counterpart({ debit_account: '1930', credit_account: '5420', vat_treatment: 'standard_25', vat_account: '2641' })
    const [out] = disputeReverseChargeBox([refund], EU)
    expect(out).toBe(refund)
  })

  it('says both in the why for an agent', () => {
    const [out] = disputeReverseChargeBox([swedish()], NON_EU)
    expect(whyTextSv(out)).toBe(
      'Bokförd så 7 gånger tidigare, men assistentens läsning säger att säljaren finns utomlands: omvänd skattskyldighet i ruta 22, inte svensk moms. Svensk moms gäller bara om fakturan visar svensk moms och säljarens svenska momsregistreringsnummer',
    )
  })
})

describe('inReverseChargeBox: the review opened on the read\'s box', () => {
  it('books a one-pair counterpart on its account in the read\'s box, keeping where it came from', () => {
    const [cp] = disputeReverseChargeBox([counterpart({ default_dimensions: { '1': 'KS02' } })], NON_EU)
    const opened = inReverseChargeBox(cp, 'non_eu_services', -200, 'aktiebolag')!
    expect(opened.booking).toEqual({
      kind: 'account', account: '5420', vat_treatment: 'reverse_charge', category: 'expense_other', reverse_charge_kind: 'non_eu_services',
    })
    expect(opened).toMatchObject({ source: 'counterparty', seen_count: 7, default_dimensions: { '1': 'KS02' } })
    expect(opened.read_reverse_charge_kind).toBeUndefined()
    expect(reverseChargeBoxDispute(opened)).toBeNull()
    expect(categorizeBodyFor(opened)).toMatchObject({ account_override: '5420', vat_treatment: 'reverse_charge', reverse_charge_kind: 'non_eu_services', proposal_id: cp.template_id })
  })

  it('takes a learned pattern\'s one cost line, beside its basis pair, with its dimensions', () => {
    const [cp] = disputeReverseChargeBox([counterpart({ vat_treatment: null, line_pattern: pattern('4535') })], NON_EU)
    const opened = inReverseChargeBox(cp, 'non_eu_services', -200)!
    expect(opened.booking).toMatchObject({ kind: 'account', account: '5420', reverse_charge_kind: 'non_eu_services' })
    expect(opened.line_pattern).toBeNull()
    expect(opened.default_dimensions).toEqual({ '1': 'KS01' })
  })

  it('opens a pattern with several cost lines as it is', () => {
    const cp = counterpart({ vat_treatment: null, line_pattern: pattern('4535', [['5420', 0.5], ['6540', 0.5]]) })
    expect(inReverseChargeBox(cp, 'non_eu_services', -200)).toBeNull()
  })

  it('books a catalog template on its own account in the read\'s box', () => {
    const opened = inReverseChargeBox(proposalFromTemplate(getTemplateById('it_saas_eu')!, 'catalog'), 'non_eu_services', -200, 'aktiebolag')!
    expect(opened.booking).toEqual({
      kind: 'account', account: '5420', vat_treatment: 'reverse_charge', category: 'expense_software', reverse_charge_kind: 'non_eu_services',
    })
  })
})

describe('the box dispute for an agent', () => {
  it('says both boxes in the why', () => {
    const [cp] = disputeReverseChargeBox([counterpart()], NON_EU)
    expect(whyTextSv(cp)).toBe(
      'Bokförd så 7 gånger tidigare, men assistentens läsning lägger köpet i ruta 22, inte ruta 21: rätt ruta beror på vilket bolag som fakturerar, se fakturan',
    )
  })
})
