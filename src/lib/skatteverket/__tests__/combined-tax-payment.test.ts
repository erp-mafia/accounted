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
  const { supabase, enqueue, reset } = createQueuedMockSupabase()
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
})
