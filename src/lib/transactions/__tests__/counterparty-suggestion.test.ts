import { describe, it, expect } from 'vitest'
import { buildCounterpartySuggestion } from '../category-suggestions'
import { categorizeBodyFor } from '@/lib/bookkeeping/proposal'
import { isCounterpartyTemplateId } from '@/lib/bookkeeping/counterparty-templates'
import type { CategorizationTemplate } from '@/types'

/**
 * The "Tidigare motparter" suggestion is the only input the review dialog has
 * about a learned counterparty: there is no catalog template to look up by id.
 * Anything missing here surfaces as an undefined field in the dialog, which is
 * how picking a Bankavgift counterparty used to replace the page with the
 * "Något gick fel" error boundary.
 */

function makeTemplate(overrides: Partial<CategorizationTemplate> = {}): CategorizationTemplate {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    user_id: null,
    company_id: '22222222-2222-2222-2222-222222222222',
    counterparty_name: 'fee',
    counterparty_aliases: [],
    debit_account: '6570',
    credit_account: '1930',
    vat_treatment: null,
    vat_account: null,
    category: null,
    line_pattern: null,
    occurrence_count: 4,
    confidence: 0.8,
    last_seen_date: '2026-07-01',
    source: 'sie_import',
    is_active: true,
    mode: 'propose',
    corrections: 0,
    paused_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    ...overrides,
  }
}

describe('buildCounterpartySuggestion', () => {
  it('carries the accounts the review dialog needs to seed its form', () => {
    const s = buildCounterpartySuggestion(makeTemplate(), 0.9)
    expect(s.debit_account).toBe('6570')
    expect(s.credit_account).toBe('1930')
    expect(isCounterpartyTemplateId(s.template_id)).toBe(true)
    expect(s.name_sv).toBe('Fee')
    expect(s.description_sv).toBe('4 tidigare bokföringar')
    expect(s.source).toBe('counterparty')
    expect(s.seen_count).toBe(4)
  })

  it('carries the learned VAT treatment so the preview matches the booking', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5420', vat_treatment: 'standard_25', vat_account: '2641' }),
      0.9,
    )
    expect(s.vat_treatment).toBe('standard_25')
  })

  it('a template whose moms is unknown is never offered as momsfri: no treatment, flagged, reviewed', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5010', vat_treatment: 'unknown', vat_account: '2641', occurrence_count: 7 }),
      0.75,
    )
    expect(s.vat_treatment).toBeNull()
    expect(s.vat_unknown).toBe(true)
    expect(s.requires_review).toBe(true)
  })

  it('on a row, a template whose moms is unknown is proposed on its account, so the review books the underlag\'s moms', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5010', vat_treatment: 'unknown', vat_account: '2641', occurrence_count: 7, mode: 'auto' }),
      0.9,
      { amount: -725, entityType: 'aktiebolag', vatRegistered: true },
    )
    // An account booking: the dialog shows the moms and offers the
    // document's (applyVatAmountOverride needs a rate-based line); the
    // template's own replay has no moms line for unknown moms.
    expect(s.booking).toMatchObject({ kind: 'account', account: '5010', vat_treatment: 'standard_25' })
    expect(s).toMatchObject({ source: 'counterparty', vat_unknown: true, requires_review: true, seen_count: 7, debit_account: '5010' })
    expect(categorizeBodyFor(s)).toMatchObject({ account_override: '5010', vat_treatment: 'standard_25' })
    expect(categorizeBodyFor(s)).not.toHaveProperty('counterparty_template_id')
    expect(categorizeBodyFor(s, { vatAmount: 125 })).toMatchObject({ vat_amount: 125 })
  })

  it('an unknown-moms counterpart on a refund keeps saying it is a refund', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5010', vat_treatment: 'unknown', vat_account: '2641', occurrence_count: 3 }),
      0.9,
      { amount: 725, vatRegistered: true, directionMismatch: true },
    )
    expect(s).toMatchObject({ direction_mismatch: true, vat_unknown: true, credit_account: '5010' })
    expect(s.description_sv).toContain('trolig återbetalning')
  })

  it('a company known not to be VAT-registered books no moms: its unknown-moms template stays the template, unflagged', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5010', vat_treatment: 'unknown', vat_account: '2641' }),
      0.9,
      { amount: -725, vatRegistered: false },
    )
    expect(s.booking.kind).toBe('counterparty')
    expect(s).not.toHaveProperty('vat_unknown')
    expect(s.requires_review).toBe(false)
  })

  it('a template without moms, or at a rate, carries no unknown flag', () => {
    expect(buildCounterpartySuggestion(makeTemplate(), 0.9)).not.toHaveProperty('vat_unknown')
    expect(buildCounterpartySuggestion(makeTemplate({ vat_treatment: 'standard_25', vat_account: '2641' }), 0.9)).not.toHaveProperty('vat_unknown')
  })

  it('passes a multi-line pattern through untouched', () => {
    const pattern = [
      { account: '5010', side: 'debit' as const, type: 'business' as const, ratio: 1 },
      { account: '2641', side: 'debit' as const, type: 'vat' as const, vat_rate: 0.25 },
    ]
    const s = buildCounterpartySuggestion(makeTemplate({ line_pattern: pattern }), 0.9)
    expect(s.line_pattern).toEqual(pattern)
  })

  it('normalises an empty dimension bag to null', () => {
    expect(buildCounterpartySuggestion(makeTemplate({ default_dimensions: {} }), 0.9).default_dimensions).toBeNull()
    expect(
      buildCounterpartySuggestion(makeTemplate({ default_dimensions: { '1': 'KS01' } }), 0.9).default_dimensions,
    ).toEqual({ '1': 'KS01' })
  })

  it('previews and books as the learned counterpart, never as a bare category', () => {
    // Exactly the reported case: a Bankavgift line, a "Fee" counterparty with
    // four prior bookings. The review previews, and the booking posts, the
    // one body that names the counterparty rule: the learned pair, never a
    // category.
    const s = buildCounterpartySuggestion(makeTemplate(), 0.9)
    expect(s).toMatchObject({ debit_account: '6570', credit_account: '1930' })
    expect(categorizeBodyFor(s)).toEqual({
      is_business: true,
      counterparty_template_id: '11111111-1111-1111-1111-111111111111',
      proposal_id: s.template_id,
    })
  })
})
