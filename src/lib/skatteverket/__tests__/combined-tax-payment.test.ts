import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const calculateVatDeclarationMock = vi.fn()
vi.mock('@/lib/reports/vat-declaration', () => ({
  calculateVatDeclaration: (...args: unknown[]) => calculateVatDeclarationMock(...args),
}))

import {
  agiTaxPaymentDate,
  resolveCombinedTaxPayment,
  vatTaxPaymentDate,
  type CombinedTaxPaymentSettings,
} from '../combined-tax-payment'

const settings: CombinedTaxPaymentSettings = {
  moms_period: 'quarterly',
  fiscal_year_start_month: 1,
  vat_has_eu_trade: false,
  vat_filing_method: 'electronic',
  vat_taxable_base_over_40m: false,
  vat_registered: true,
}

describe('combined Skattekonto payment', () => {
  const { supabase, enqueue, findCalls, reset } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    calculateVatDeclarationMock.mockResolvedValue({
      rutor: { ruta10: 42_000, ruta48: 0, ruta49: 42_000 },
    })
  })

  it('uses the 17th in August for a company below the large-company threshold', () => {
    expect(agiTaxPaymentDate(2026, 7, settings)).toBe('2026-08-17')
  })

  it('uses the 12th in August for a large company', () => {
    expect(agiTaxPaymentDate(2026, 7, { ...settings, vat_taxable_base_over_40m: true }))
      .toBe('2026-08-12')
  })

  it('combines unpaid AGI and positive VAT sharing a due date', async () => {
    enqueue({
      data: {
        id: 'agi-1',
        total_tax: 40_000,
        total_avgifter: 19_000,
        tax_paid_at: null,
      },
    })

    const payment = await resolveCombinedTaxPayment(
      client,
      'company-1',
      'aktiebolag',
      settings,
      '2026-08-17',
      { periodType: 'quarterly', year: 2026, period: 2 },
    )

    expect(payment.agi).toMatchObject({ period: '2026-07', amount: 59_000 })
    expect(payment.vat).toMatchObject({ amount: 42_000 })
    expect(payment.totalAmount).toBe(101_000)
  })

  it('does not include AGI that is already marked as paid', async () => {
    enqueue({
      data: {
        id: 'agi-1',
        total_tax: 40_000,
        total_avgifter: 19_000,
        tax_paid_at: '2026-08-10T10:00:00Z',
      },
    })

    const payment = await resolveCombinedTaxPayment(
      client,
      'company-1',
      'aktiebolag',
      settings,
      '2026-08-17',
      { periodType: 'quarterly', year: 2026, period: 2 },
    )

    expect(payment.agi).toBeNull()
    expect(payment.totalAmount).toBe(42_000)
  })

  it.each([
    [2024, 3, '2024-02-29'],
    [2025, 3, '2025-02-28'],
    [2024, 5, '2024-04-30'],
  ])('uses the last day of the fiscal end month for yearly VAT in %i', async (year, startMonth, periodEnd) => {
    const yearlySettings = { ...settings, moms_period: 'yearly' as const, fiscal_year_start_month: startMonth }
    const paymentDate = vatTaxPaymentDate(
      { periodType: 'yearly', year, period: 1 },
      'aktiebolag',
      yearlySettings,
    )
    expect(paymentDate).not.toBeNull()

    await resolveCombinedTaxPayment(client, 'company-1', 'aktiebolag', yearlySettings, paymentDate!)

    expect(findCalls('fiscal_periods', 'gte')).toContainEqual(['period_end', `${periodEnd.slice(0, 8)}01`])
    expect(findCalls('fiscal_periods', 'lte')).toContainEqual(['period_end', periodEnd])
  })
})
