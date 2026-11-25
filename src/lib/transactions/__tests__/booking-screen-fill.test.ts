import { describe, expect, it } from 'vitest'
import { fillsUnasked, suggestionToFill } from '../booking-screen-fill'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'

/** A learned counterpart booked three times before: the common row suggestion. */
const SUGGESTION: BookingProposal = {
  template_id: 'cp:7b4d',
  source: 'counterparty',
  booking: { kind: 'counterparty', counterparty_template_id: '7b4d' },
  name_sv: 'Anthropic',
  name_en: 'Anthropic',
  group: 'counterparty',
  debit_account: '5420',
  credit_account: '1930',
  confidence: 0.9,
  description_sv: '3 tidigare bokföringar',
  risk_level: 'NONE',
  requires_review: false,
  seen_count: 3,
}

const OPENED = { personStarted: false, filledOrTried: false }

describe('suggestionToFill', () => {
  it('fills the suggestion into the kontering as it opened', () => {
    expect(suggestionToFill({ suggestion: SUGGESTION, ...OPENED })).toBe(SUGGESTION)
  })

  it('never fills over what the person typed or picked', () => {
    expect(suggestionToFill({ suggestion: SUGGESTION, personStarted: true, filledOrTried: false })).toBeNull()
  })

  it('fills nothing when the row has no suggestion', () => {
    expect(suggestionToFill({ suggestion: null, ...OPENED })).toBeNull()
  })

  it('fills once: not over lines already filled or on their way, and not again after Ångra or a failed read', () => {
    expect(suggestionToFill({ suggestion: SUGGESTION, personStarted: false, filledOrTried: true })).toBeNull()
  })

  it('fills a suggestion that would open a review elsewhere: the person checks it here before Bokför', () => {
    const catalog: BookingProposal = { ...SUGGESTION, source: 'catalog', confidence: 0.3 }
    const precedent: BookingProposal = { ...SUGGESTION, source: 'precedent', seen_count: 1 }
    expect(suggestionToFill({ suggestion: catalog, ...OPENED })).toBe(catalog)
    expect(suggestionToFill({ suggestion: precedent, ...OPENED })).toBe(precedent)
  })

  it('only offers a suggestion whose moms or direction asks to be checked first', () => {
    for (const doubt of [
      { read_reverse_charge_kind: 'non_eu_services' as const },
      { reverse_charge_box_unconfirmed: true },
      { direction_mismatch: true },
      { contested: true },
    ]) {
      const suggestion = { ...SUGGESTION, ...doubt }
      expect(fillsUnasked(suggestion)).toBe(false)
      expect(suggestionToFill({ suggestion, ...OPENED })).toBeNull()
    }
  })

  it('leaves an unsure assistant read for the person, and fills a likely one', () => {
    const unsure: BookingProposal = { ...SUGGESTION, source: 'assistant', confidence: 0.49 }
    const likely: BookingProposal = { ...SUGGESTION, source: 'assistant', confidence: 0.5 }
    expect(suggestionToFill({ suggestion: unsure, ...OPENED })).toBeNull()
    expect(suggestionToFill({ suggestion: likely, ...OPENED })).toBe(likely)
  })
})
