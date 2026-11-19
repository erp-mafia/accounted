import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { DynamicVatAccounts } from '@/lib/reports/vat-revenue-accounts'
import type { BookingTemplateLibraryLine } from '@/types'

const mockFetchDynamic = vi.fn()
vi.mock('@/lib/reports/vat-revenue-accounts', () => ({
  fetchDynamicVatAccounts: (...args: unknown[]) => mockFetchDynamic(...args),
}))

import {
  accountRutaFor,
  assertCorrectedImportVatBase,
  importVatWithoutBase,
  refuseCorrectedImportVatWithoutBase,
  refuseImportVatWithoutBase,
  IMPORT_VAT_WITHOUT_BASE_CODE,
} from '../import-vat-base'
import { ImportVatWithoutBaseError } from '../errors'
import { applyTemplate } from '../template-library'

function dynamicWith(
  mappings: Record<string, string> = {},
  explicitOnly: string[] = [],
): DynamicVatAccounts {
  return {
    accounts: Object.keys(mappings),
    mappingByAccount: new Map(
      Object.entries(mappings).map(([account, box]) => [
        account,
        { box: box as never, side: box === 'ruta50' || box.startsWith('ruta2') ? 'debit' : 'credit' },
      ]),
    ),
    explicitAccounts: new Set([...Object.keys(mappings), ...explicitOnly]),
    rateByAccount: new Map(),
    staticRateByAccount: new Map(),
    rcBasisRateByAccount: new Map(),
    unconfiguredRevenueAccounts: new Map(),
    unconfiguredVatAccounts: new Map(),
  }
}

const basOnly = accountRutaFor(dynamicWith())
const supabase = {} as SupabaseClient

// The shape the production rows carry (#83): a company's own mall puts the
// fiktiv moms on 2615 beside an EU purchase on 4515, paid from 1930.
const MALL_SHAPE = [
  { account_number: '4515', debit_amount: 1000, credit_amount: 0 },
  { account_number: '2645', debit_amount: 250, credit_amount: 0 },
  { account_number: '2615', debit_amount: 0, credit_amount: 250 },
  { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
]

describe('importVatWithoutBase', () => {
  it('names importmoms credited with no ruta 50 line (the mall shape)', () => {
    expect(importVatWithoutBase(MALL_SHAPE, basOnly)).toEqual(['2615'])
  })

  it('passes importmoms booked with its base on 4545/4546/4547', () => {
    for (const base of ['4545', '4546', '4547']) {
      const lines = MALL_SHAPE.map((l) => (l.account_number === '4515' ? { ...l, account_number: base } : l))
      expect(importVatWithoutBase(lines, basOnly)).toBeNull()
    }
  })

  it('passes a reverse-charge purchase on 2614, and a booking with no importmoms', () => {
    const rc = MALL_SHAPE.map((l) => (l.account_number === '2615' ? { ...l, account_number: '2614' } : l))
    expect(importVatWithoutBase(rc, basOnly)).toBeNull()
    expect(importVatWithoutBase([
      { account_number: '6540', debit_amount: 800, credit_amount: 0 },
      { account_number: '2641', debit_amount: 200, credit_amount: 0 },
      { account_number: '1930', debit_amount: 0, credit_amount: 1000 },
    ], basOnly)).toBeNull()
  })

  it('does not check a debit on 2615 (the reversal side of a credited import)', () => {
    expect(importVatWithoutBase([
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
      { account_number: '2615', debit_amount: 250, credit_amount: 0 },
      { account_number: '2645', debit_amount: 0, credit_amount: 250 },
      { account_number: '6540', debit_amount: 0, credit_amount: 1000 },
    ], basOnly)).toBeNull()
  })

  it('reads the company momsruta: 2615 routed to ruta 30 is no importmoms', () => {
    const rutaOf = accountRutaFor(dynamicWith({ '2615': 'ruta30' }))
    expect(importVatWithoutBase(MALL_SHAPE, rutaOf)).toBeNull()
  })

  it('takes a company account with momskod import_goods as the base', () => {
    const lines = MALL_SHAPE.map((l) => (l.account_number === '4515' ? { ...l, account_number: '4548' } : l))
    expect(importVatWithoutBase(lines, basOnly)).toEqual(['2615'])
    expect(importVatWithoutBase(lines, accountRutaFor(dynamicWith({ '4548': 'ruta50' })))).toBeNull()
  })

  it('refuses an account the company routed to ruta 60-62 itself, and drops a 4545 it classified elsewhere', () => {
    const lines = MALL_SHAPE.map((l) => (l.account_number === '2615' ? { ...l, account_number: '2617' } : l))
    expect(importVatWithoutBase(lines, basOnly)).toBeNull()
    expect(importVatWithoutBase(lines, accountRutaFor(dynamicWith({ '2617': 'ruta60' })))).toEqual(['2617'])

    const on4545 = MALL_SHAPE.map((l) => (l.account_number === '4515' ? { ...l, account_number: '4545' } : l))
    expect(importVatWithoutBase(on4545, accountRutaFor(dynamicWith({}, ['4545'])))).toEqual(['2615'])
  })

  it('reads amounts typed in a form', () => {
    expect(importVatWithoutBase([
      { account_number: '4515', debit_amount: '1000.00', credit_amount: '' },
      { account_number: '2645', debit_amount: '250.00', credit_amount: '' },
      { account_number: '2615', debit_amount: '', credit_amount: '250.00' },
      { account_number: '1930', debit_amount: '', credit_amount: '1000.00' },
    ], basOnly)).toEqual(['2615'])
  })

  // The builder behind the rows: applyTemplate turns a company's mall into the
  // lines the bank and inbox doors post. An import mall on 4545 passes; the
  // production malls (4548 or an EU/service account beside 2615) do not.
  it('refuses the lines applyTemplate builds from a mall without an import base', () => {
    const mall = (business: string): BookingTemplateLibraryLine[] => [
      { account: '1930', label: 'Företagskonto', side: 'credit', type: 'settlement', ratio: 1 },
      { account: business, label: 'Varor', side: 'debit', type: 'business', ratio: 1 },
      { account: '2615', label: 'Utgående moms import av varor, 25 %', side: 'credit', type: 'vat', vat_rate: 0.25 },
      { account: '2645', label: 'Beräknad ingående moms', side: 'debit', type: 'vat', vat_rate: 0.25 },
    ]
    expect(importVatWithoutBase(applyTemplate(mall('4548'), 1000), basOnly)).toEqual(['2615'])
    expect(importVatWithoutBase(applyTemplate(mall('4531'), 1000), basOnly)).toEqual(['2615'])
    expect(importVatWithoutBase(applyTemplate(mall('4545'), 1000), basOnly)).toBeNull()
  })
})

describe('refuseImportVatWithoutBase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDynamic.mockResolvedValue(dynamicWith())
  })

  it('refuses the mall shape with the code, the accounts and a message naming the fix', async () => {
    const refusal = await refuseImportVatWithoutBase(supabase, 'company-1', MALL_SHAPE)
    expect(refusal?.code).toBe(IMPORT_VAT_WITHOUT_BASE_CODE)
    expect(refusal?.details).toEqual({ import_vat_accounts: ['2615'] })
    expect(refusal?.messageSv).toContain('4545, 4546 eller 4547')
    expect(refusal?.messageSv).toContain('2614, 2624 eller 2634')
    expect(refusal?.messageSv).toContain('Bokföringsmallar')
    expect(refusal?.messageEn).toContain('box 50')
    expect(mockFetchDynamic).toHaveBeenCalledWith(supabase, 'company-1')
  })

  it('reads no chart for a booking that cannot carry importmoms', async () => {
    const refusal = await refuseImportVatWithoutBase(supabase, 'company-1', [
      { account_number: '3001', debit_amount: 0, credit_amount: 800 },
      { account_number: '2611', debit_amount: 0, credit_amount: 200 },
      { account_number: '1930', debit_amount: 1000, credit_amount: 0 },
    ])
    expect(refusal).toBeNull()
    expect(mockFetchDynamic).not.toHaveBeenCalled()
  })

  it('passes when the company routed 2615 elsewhere', async () => {
    mockFetchDynamic.mockResolvedValue(dynamicWith({ '2615': 'ruta30' }))
    expect(await refuseImportVatWithoutBase(supabase, 'company-1', MALL_SHAPE)).toBeNull()
  })

  it('refuses nothing when the chart cannot be read', async () => {
    mockFetchDynamic.mockRejectedValue(new Error('timeout'))
    expect(await refuseImportVatWithoutBase(supabase, 'company-1', MALL_SHAPE)).toBeNull()
  })
})

// The rättelse doors (#94): judged on the lines the correction leaves.
describe('refuseCorrectedImportVatWithoutBase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFetchDynamic.mockResolvedValue(dynamicWith())
  })

  it('refuses the shape a rättelse keeps, worded for a rättelse (no mall sentence)', async () => {
    const refusal = await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'bank_transaction', MALL_SHAPE)
    expect(refusal?.code).toBe(IMPORT_VAT_WITHOUT_BASE_CODE)
    expect(refusal?.details).toEqual({ import_vat_accounts: ['2615'] })
    expect(refusal?.messageSv).toContain('Efter rättelsen')
    expect(refusal?.messageSv).toContain('2614, 2624 eller 2634')
    expect(refusal?.messageSv).not.toContain('Bokföringsmallar')
    expect(refusal?.messageEn).toContain('After the correction')
  })

  it('passes a rättelse that takes the importmoms out or adds its base', async () => {
    const out = MALL_SHAPE.map((l) => (l.account_number === '2615' ? { ...l, account_number: '2614' } : l))
    const withBase = MALL_SHAPE.map((l) => (l.account_number === '4515' ? { ...l, account_number: '4545' } : l))
    expect(await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'manual', out)).toBeNull()
    expect(await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'manual', withBase)).toBeNull()
  })

  it('passes the balances of an opening balance and a momsredovisning', async () => {
    const balance = [
      { account_number: '2615', debit_amount: 0, credit_amount: 250 },
      { account_number: '2099', debit_amount: 250, credit_amount: 0 },
    ]
    expect(await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'opening_balance', balance)).toBeNull()
    expect(await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'vat_settlement', balance)).toBeNull()
    expect(mockFetchDynamic).not.toHaveBeenCalled()
    expect(await refuseCorrectedImportVatWithoutBase(supabase, 'company-1', 'manual', balance)).not.toBeNull()
  })

  it('throws the typed bookkeeping error for a door that throws', async () => {
    const thrown = await assertCorrectedImportVatBase(supabase, 'company-1', 'manual', MALL_SHAPE).catch((e) => e)
    expect(thrown).toBeInstanceOf(ImportVatWithoutBaseError)
    expect(thrown).toMatchObject({ code: 'IMPORT_VAT_WITHOUT_BASE', importVatAccounts: ['2615'] })
    await expect(assertCorrectedImportVatBase(supabase, 'company-1', 'manual', [])).resolves.toBeUndefined()
  })
})
