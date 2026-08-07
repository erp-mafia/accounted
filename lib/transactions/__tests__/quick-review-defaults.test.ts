import { describe, it, expect } from 'vitest'
import { resolveQuickReviewDefaults, resolveExplicitVat, type ReviewTemplate } from '../quick-review-defaults'
import { getDefaultAccountForCategory } from '@/lib/bookkeeping/category-mapping'

/**
 * Regression cover for the "Tidigare motparter" crash: picking a learned
 * counterparty template in the Bokför-transaktion modal replaced the whole
 * page with the "Något gick fel" error boundary.
 *
 * The synthetic counterparty template carried only { id, name_sv }, so
 * `template.debit_account` was undefined, the dialog's `defaultAccount` prop
 * (declared `string`) received undefined, and the first render threw on
 * `accountOverride.startsWith('2')`.
 */
describe('resolveQuickReviewDefaults', () => {
  const counterparty: ReviewTemplate = {
    id: 'counterparty:11111111-1111-1111-1111-111111111111',
    name_sv: 'Fee',
    debit_account: '6570',
    credit_account: '1930',
    vat_treatment: null,
  }

  it('never returns undefined for the account, whatever the template omits', () => {
    const bare: ReviewTemplate = { id: 'counterparty:abc', name_sv: 'Fee' }
    const { account, vat } = resolveQuickReviewDefaults(bare, undefined, 'expense_other')
    expect(account).toBe(getDefaultAccountForCategory('expense_other'))
    expect(typeof account).toBe('string')
    expect(vat).toBe('none')
  })

  it('returns an empty account rather than undefined when there is nothing at all', () => {
    expect(resolveQuickReviewDefaults(null, undefined, null)).toEqual({ account: '', vat: 'none' })
    expect(resolveQuickReviewDefaults({ id: 'counterparty:abc', name_sv: 'Fee' }, undefined, null))
      .toEqual({ account: '', vat: 'none' })
  })

  it('seeds from the counterparty template accounts, not the category fallback', () => {
    const { account, vat } = resolveQuickReviewDefaults(counterparty, undefined, 'expense_other')
    expect(account).toBe('6570')
    expect(vat).toBe('none')
  })

  it('carries the learned VAT treatment of a counterparty template', () => {
    const { vat } = resolveQuickReviewDefaults(
      { ...counterparty, debit_account: '5420', vat_treatment: 'standard_25' },
      undefined,
      'expense_other',
    )
    expect(vat).toBe('standard_25')
  })

  it('ignores the template and uses the category when a catalog templateId is present', () => {
    const catalog: ReviewTemplate = {
      id: 'bank_fees',
      name_sv: 'Bankavgifter',
      debit_account: '6570',
      credit_account: '1930',
      vat_treatment: null,
    }
    const { account } = resolveQuickReviewDefaults(catalog, 'bank_fees', 'expense_other')
    // Catalog templates are validated server-side by id; the form's account
    // field is not the source of truth for them.
    expect(account).toBe(getDefaultAccountForCategory('expense_other'))
  })

  it('falls back to the category defaults when no template is involved', () => {
    const { account, vat } = resolveQuickReviewDefaults(null, undefined, 'expense_other')
    expect(account).toBe(getDefaultAccountForCategory('expense_other'))
    expect(vat === 'none' || typeof vat === 'string').toBe(true)
  })
})

describe('resolveExplicitVat', () => {
  it('passes explicit rate-bearing treatments through unchanged', () => {
    expect(resolveExplicitVat('standard_25', 'standard_25')).toBe('standard_25')
    expect(resolveExplicitVat('reduced_12', 'standard_25')).toBe('reduced_12')
    expect(resolveExplicitVat('reverse_charge', 'none')).toBe('reverse_charge')
  })

  it("keeps a seeded 'none' default off the wire (server derives, no VAT line)", () => {
    // Bank fees etc.: category default is null -> displayed as 'none'.
    // Untouched submit must stay byte-identical to the pre-fix behavior.
    expect(resolveExplicitVat('none', 'none')).toBeUndefined()
  })

  it("sends explicit 'exempt' when the user deviates to Ingen moms", () => {
    // The old collapse to undefined made the server re-derive the category
    // default and book 25% moms against an explicit no-VAT choice.
    expect(resolveExplicitVat('none', 'standard_25')).toBe('exempt')
    expect(resolveExplicitVat('none', 'reduced_12')).toBe('exempt')
  })
})
