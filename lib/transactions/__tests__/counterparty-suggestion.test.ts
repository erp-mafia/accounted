import { describe, it, expect } from 'vitest'
import { buildCounterpartySuggestion } from '../category-suggestions'
import { resolveQuickReviewDefaults } from '../quick-review-defaults'
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
  })

  it('carries the learned VAT treatment so the preview matches the booking', () => {
    const s = buildCounterpartySuggestion(
      makeTemplate({ debit_account: '5420', vat_treatment: 'standard_25', vat_account: '2641' }),
      0.9,
    )
    expect(s.vat_treatment).toBe('standard_25')
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

  it('feeds the review dialog a defined account, which is what the crash needed', () => {
    // Exactly the reported case: a Bankavgift line, a "Fee" counterparty with
    // four prior bookings. The dialog reads defaultAccount off this shape and
    // immediately calls .startsWith() on it.
    const s = buildCounterpartySuggestion(makeTemplate(), 0.9)
    const { account, vat } = resolveQuickReviewDefaults(
      {
        id: s.template_id,
        name_sv: s.name_sv,
        debit_account: s.debit_account,
        credit_account: s.credit_account,
        vat_treatment: s.vat_treatment ?? null,
      },
      undefined,
      'expense_other',
    )
    expect(account).toBe('6570')
    expect(() => account.startsWith('2')).not.toThrow()
    expect(vat).toBe('none')
  })
})
