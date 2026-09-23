import { describe, it, expect } from 'vitest'
import { vatRateComesFromLabel } from '../account-vat-treatment'
import { ACCOUNT_VAT_TREATMENTS, defaultRateForVatTreatment } from '@/lib/vat/account-vat-treatment'

/**
 * The rule exists to be the single place two callers ask, so it is worth
 * pinning on its own: providerSuggestedRate applies it, and the source chart
 * asks it before letting a code's stated rate beat the treatment's own.
 */
describe('vatRateComesFromLabel', () => {
  it('is true for a reverse charge on a purchase account, where the rate is real', () => {
    expect(vatRateComesFromLabel('reverse_charge_eu_goods', 4)).toBe(true)
    expect(vatRateComesFromLabel('reverse_charge_domestic', 4)).toBe(true)
    expect(vatRateComesFromLabel('reverse_charge_non_eu_services', 5)).toBe(true)
  })

  it('is false for the same treatment on a revenue account, where the sale is zero-rated', () => {
    expect(vatRateComesFromLabel('reverse_charge_eu_goods', 3)).toBe(false)
    expect(vatRateComesFromLabel('reverse_charge_domestic', 3)).toBe(false)
  })

  it('is true for the boxes that span three rates, on either side', () => {
    // Ruta 06 and ruta 50 are one box each covering 25, 12 and 6 %. Ruta 05
    // solved the same problem with three treatments, which is why standard_25
    // and its siblings must stay out.
    expect(vatRateComesFromLabel('own_use', 3)).toBe(true)
    expect(vatRateComesFromLabel('import_goods', 4)).toBe(true)
    expect(vatRateComesFromLabel('standard_25', 3)).toBe(false)
    expect(vatRateComesFromLabel('reduced_12', 3)).toBe(false)
    expect(vatRateComesFromLabel('reduced_6', 3)).toBe(false)
  })

  it('is false wherever the treatment answers null on purpose', () => {
    // vmb has no single sats and oss carries a destination country's rate that
    // never drives ruta 05 arithmetic. A label must not fill either in.
    for (const treatment of ['vmb', 'oss'] as const) {
      expect(defaultRateForVatTreatment(treatment, 3)).toBeNull()
      expect(vatRateComesFromLabel(treatment, 3)).toBe(false)
      expect(vatRateComesFromLabel(treatment, 4)).toBe(false)
    }
  })

  it('answers for every treatment there is, so a new one cannot slip past unconsidered', () => {
    for (const treatment of ACCOUNT_VAT_TREATMENTS) {
      for (const accountClass of [3, 4, 5, 6]) {
        expect(typeof vatRateComesFromLabel(treatment, accountClass)).toBe('boolean')
      }
    }
  })

  it('never claims the label for a treatment whose own rate is fixed', () => {
    // The invariant the rule protects: if it says the label decides, the
    // treatment must not already have a single answer of its own that the
    // label could contradict. Zero-rated treatments are the exception by
    // construction, since zero is the absence of a rate rather than a choice.
    for (const treatment of ACCOUNT_VAT_TREATMENTS) {
      for (const accountClass of [3, 4]) {
        if (!vatRateComesFromLabel(treatment, accountClass)) continue
        const fixed = defaultRateForVatTreatment(treatment, accountClass)
        expect(fixed === null || fixed === 0 || fixed === 0.25).toBe(true)
      }
    }
  })
})
