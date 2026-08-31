/**
 * Tests for the shared VAT classification helpers (#1912): the effective
 * rate precedence (explicit momssats > treatment > class-3 number+name
 * inference) and the revenue box resolver, plus a regression that
 * fetchDynamicVatAccounts still produces the same rateByAccount after
 * switching to the shared helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const fetchAllRowsMock = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...args: unknown[]) => fetchAllRowsMock(...args),
}))

import {
  fetchDynamicVatAccounts,
  resolveEffectiveVatRate,
  resolveRevenueVatBox,
} from '../vat-revenue-accounts'

const supabase = {} as SupabaseClient

function row(
  account_number: string,
  account_name: string,
  overrides: {
    account_class?: number
    default_vat_rate?: number | string | null
    default_vat_treatment?: string | null
  } = {},
) {
  return {
    account_number,
    account_name,
    account_class: overrides.account_class ?? Number(account_number.charAt(0)),
    default_vat_rate: overrides.default_vat_rate ?? null,
    default_vat_treatment: overrides.default_vat_treatment ?? null,
  }
}

describe('resolveEffectiveVatRate', () => {
  it('lets an explicit momssats win over a rate-conforming name', () => {
    expect(
      resolveEffectiveVatRate(
        row('3041', 'Försäljning tjänster 25 % moms', { default_vat_rate: 0.06 }),
      ),
    ).toBe(0.06)
  })

  it('accepts a numeric-string momssats (Postgres numeric)', () => {
    expect(
      resolveEffectiveVatRate(row('3050', 'Försäljning', { default_vat_rate: '0.12' })),
    ).toBe(0.12)
  })

  it('lets an explicit momssats win over the treatment default', () => {
    expect(
      resolveEffectiveVatRate(
        row('3050', 'Försäljning', {
          default_vat_rate: 0.06,
          default_vat_treatment: 'standard_25',
        }),
      ),
    ).toBe(0.06)
  })

  it('falls back to the treatment default rate', () => {
    expect(
      resolveEffectiveVatRate(
        row('3050', 'Försäljning', { default_vat_treatment: 'reduced_12' }),
      ),
    ).toBe(0.12)
    expect(
      resolveEffectiveVatRate(
        row('3060', 'Konsultarvode utland', { default_vat_treatment: 'export_goods' }),
      ),
    ).toBe(0)
    expect(
      resolveEffectiveVatRate(
        row('3060', 'Momsfri försäljning', { default_vat_treatment: 'exempt' }),
      ),
    ).toBe(0)
  })

  it('returns null for treatments without a single Swedish sats (vmb, oss)', () => {
    expect(
      resolveEffectiveVatRate(row('3200', 'VMB', { default_vat_treatment: 'vmb' })),
    ).toBeNull()
    expect(
      resolveEffectiveVatRate(row('3106', 'OSS', { default_vat_treatment: 'oss' })),
    ).toBeNull()
  })

  it('infers the rate from number + name for an unconfigured class 3 account', () => {
    expect(
      resolveEffectiveVatRate(row('3041', 'Försäljning tjänster 25 % moms')),
    ).toBe(0.25)
    expect(
      resolveEffectiveVatRate(row('3042', 'Försäljning tjänster 12 % moms')),
    ).toBe(0.12)
  })

  it('returns null for an unconfigured class 3 account without a conforming name', () => {
    expect(
      resolveEffectiveVatRate(row('3105', 'Försäljning varor till land utanför EU')),
    ).toBeNull()
    expect(resolveEffectiveVatRate(row('3051', 'Försäljning tjänster'))).toBeNull()
  })

  it('never infers for purchase classes: only an explicit momssats counts', () => {
    expect(resolveEffectiveVatRate(row('4011', 'Inköp varor 25 % moms'))).toBeNull()
    expect(
      resolveEffectiveVatRate(row('4011', 'Inköp varor', { default_vat_rate: 0.25 })),
    ).toBe(0.25)
  })

  it('derives the class from the account number when the row lacks it', () => {
    expect(
      resolveEffectiveVatRate({
        account_number: '3041',
        account_name: 'Försäljning tjänster 25 % moms',
        default_vat_rate: null,
        default_vat_treatment: null,
      }),
    ).toBe(0.25)
    expect(
      resolveEffectiveVatRate({
        account_number: '5010',
        account_name: 'Lokalhyra',
        default_vat_rate: null,
        default_vat_treatment: 'reverse_charge_eu_services',
      }),
    ).toBe(0.25)
  })
})

describe('resolveRevenueVatBox', () => {
  it('maps a configured treatment to its momsdeklaration box', () => {
    expect(
      resolveRevenueVatBox(row('3060', 'Momsfri', { default_vat_treatment: 'exempt' })),
    ).toBe('42')
    expect(
      resolveRevenueVatBox(
        row('3060', 'Konsult utland', { default_vat_treatment: 'export_services' }),
      ),
    ).toBe('40')
    expect(
      resolveRevenueVatBox(
        row('3060', 'Varor utanför EU', { default_vat_treatment: 'export_goods' }),
      ),
    ).toBe('36')
    expect(
      resolveRevenueVatBox(
        row('3060', 'Varor EU', { default_vat_treatment: 'reverse_charge_eu_goods' }),
      ),
    ).toBe('35')
    expect(
      resolveRevenueVatBox(
        row('3060', 'Tjänster EU', { default_vat_treatment: 'reverse_charge_eu_services' }),
      ),
    ).toBe('39')
    expect(
      resolveRevenueVatBox(row('3060', 'Standard', { default_vat_treatment: 'standard_25' })),
    ).toBe('05')
  })

  it('returns null for OSS (declared outside the momsdeklaration)', () => {
    expect(
      resolveRevenueVatBox(row('3106', 'OSS', { default_vat_treatment: 'oss' })),
    ).toBeNull()
  })

  it('lets the treatment override the static BAS box', () => {
    // 3105 is statically ruta 36, but the company configured it as exempt.
    expect(
      resolveRevenueVatBox(row('3105', 'Export', { default_vat_treatment: 'exempt' })),
    ).toBe('42')
  })

  it('falls back to the static BAS map without a treatment', () => {
    expect(resolveRevenueVatBox(row('3105', 'Export varor'))).toBe('36')
    expect(resolveRevenueVatBox(row('3305', 'Export tjänster'))).toBe('40')
    expect(resolveRevenueVatBox(row('3108', 'Varor EU'))).toBe('35')
    expect(resolveRevenueVatBox(row('3109', 'Trepartshandel'))).toBe('38')
    expect(resolveRevenueVatBox(row('3308', 'Tjänster EU'))).toBe('39')
    expect(resolveRevenueVatBox(row('3004', 'Momsfri försäljning'))).toBe('42')
    expect(resolveRevenueVatBox(row('3001', 'Försäljning 25 %'))).toBe('05')
  })

  it('returns null for an account neither the treatment nor the BAS map classifies', () => {
    expect(resolveRevenueVatBox(row('3050', 'Försäljning'))).toBeNull()
    expect(resolveRevenueVatBox(row('3060', 'Konsultarvode utland'))).toBeNull()
  })
})

describe('fetchDynamicVatAccounts (shared helper regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the same rate precedence as before the helper extraction', async () => {
    fetchAllRowsMock.mockResolvedValue([
      // Explicit 6% wins over the "25 % moms" name.
      row('3041', 'Försäljning tjänster 25 % moms', { default_vat_rate: 0.06 }),
      // Unconfigured, inferred from number + name.
      row('3042', 'Försäljning tjänster 12 % moms'),
      // Static export account, unconfigured: no rate, never in ruta 05.
      row('3105', 'Försäljning varor till land utanför EU'),
      // Treatment-driven rate on a custom account.
      row('3050', 'Försäljning', { default_vat_treatment: 'standard_25' }),
      // Treatment with explicit rate on a purchase account: RC basis rate.
      row('4056', 'Inköp tjänster EU', {
        default_vat_rate: 0.12,
        default_vat_treatment: 'reverse_charge_eu_services',
      }),
      // Class 3 without any classification: excluded.
      row('3051', 'Försäljning tjänster'),
    ])

    const result = await fetchDynamicVatAccounts(supabase, 'company-1')

    expect(result.rateByAccount.get('3041')).toBe(0.06)
    expect(result.rateByAccount.get('3042')).toBe(0.12)
    expect(result.rateByAccount.has('3105')).toBe(false)
    expect(result.rateByAccount.get('3050')).toBe(0.25)
    expect(result.rateByAccount.has('3051')).toBe(false)
    expect(result.rcBasisRateByAccount.get('4056')).toBe(0.12)
    expect(result.explicitAccounts.has('3050')).toBe(true)
    expect(result.explicitAccounts.has('3041')).toBe(false)
    expect(result.mappingByAccount.get('3041')).toEqual({ box: 'ruta05', side: 'credit' })
    expect(result.accounts).toEqual(['3041', '3042', '3050', '4056'])
  })

  it('keeps static ruta 05 accounts out of the dynamic set but records the 3000 rate', async () => {
    fetchAllRowsMock.mockResolvedValue([
      row('3000', 'Försäljning inom Sverige', { default_vat_rate: 0.25 }),
      row('3001', 'Försäljning 25 %', { default_vat_rate: 0.25 }),
    ])
    const result = await fetchDynamicVatAccounts(supabase, 'company-1')
    expect(result.accounts).toEqual([])
    expect(result.staticRateByAccount.get('3000')).toBe(0.25)
    expect(result.staticRateByAccount.has('3001')).toBe(false)
    expect(result.rateByAccount.size).toBe(0)
  })
})
