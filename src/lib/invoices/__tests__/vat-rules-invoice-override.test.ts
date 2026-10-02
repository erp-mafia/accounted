/**
 * Per-invoice VAT treatment (#2906). The customer record decides by default;
 * an invoice may state its own supply, and resolveInvoiceVatRules refuses
 * any statement the facts do not support (fail closed: never 0 % without
 * them). Rules per the swedish-vat and swedish-invoice-compliance skills:
 * export of goods = ruta 36 / 3105, unionsintern leverans = ruta 35 / 3108
 * (ML 10 kap. 42-43 §§: the buyer's VIES-validated VAT number from another
 * member state and transport to another member state).
 */
import { describe, it, expect } from 'vitest'
import {
  EU_GOODS_SUPPLY_NOTICE,
  EU_REVERSE_CHARGE_NOTICE,
  EXPORT_NOTICE_SV,
  getPermittedVatRates,
  getVatRules,
  resolveInvoiceVatRules,
  type VatTreatmentCustomer,
} from '../vat-rules'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-accounts'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'

const swedishBusiness: VatTreatmentCustomer = {
  id: 'c-se',
  customer_type: 'swedish_business',
  vat_number: 'SE556677889901',
  vat_number_validated: true,
  country: 'SE',
}
const germanBusiness: VatTreatmentCustomer = {
  id: 'c-de',
  customer_type: 'eu_business',
  vat_number: 'DE811234567',
  vat_number_validated: true,
  country: 'DE',
}
const norwegianBusiness: VatTreatmentCustomer = {
  id: 'c-no',
  customer_type: 'non_eu_business',
  vat_number: null,
  vat_number_validated: false,
  country: 'NO',
}
const consumer: VatTreatmentCustomer = {
  id: 'c-ind',
  customer_type: 'individual',
  vat_number: null,
  vat_number_validated: false,
  country: 'SE',
}

describe('without a statement the customer decides, exactly as before', () => {
  it.each([
    ['swedish_business', swedishBusiness],
    ['eu_business (validated)', germanBusiness],
    ['non_eu_business', norwegianBusiness],
    ['individual', consumer],
  ])('%s', (_label, customer) => {
    for (const override of [undefined, null, { vat_treatment: null, delivery_country: null }]) {
      const resolved = resolveInvoiceVatRules(customer, override)
      expect(resolved).toEqual({
        ok: true,
        rules: getVatRules(customer.customer_type, customer.vat_number_validated ?? false, customer.country),
        permittedRates: getPermittedVatRates(customer.customer_type, customer.vat_number_validated ?? false, customer.country),
        explainFromCustomer: true,
      })
    }
  })
})

describe('export of goods', () => {
  it('a Swedish buyer with goods shipped to Norway is an export: 0 %, ruta 36, the ML 10 kap. notice', () => {
    const resolved = resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: 'NO' })
    expect(resolved).toMatchObject({
      ok: true,
      rules: { treatment: 'export', rate: 0, momsRuta: '36', reverseChargeText: EXPORT_NOTICE_SV },
      explainFromCustomer: false,
    })
    // Only 0 % on the priced lines: a Swedish-VAT supply is a separate invoice.
    if (resolved.ok) expect(resolved.permittedRates.map((r) => r.rate)).toEqual([0])
  })

  it('does not depend on who the buyer is (a consumer, a foreign business)', () => {
    expect(resolveInvoiceVatRules(consumer, { vat_treatment: 'export', delivery_country: 'US' }).ok).toBe(true)
    expect(resolveInvoiceVatRules(norwegianBusiness, { vat_treatment: 'export', delivery_country: 'NO' })).toMatchObject({
      ok: true,
      rules: { momsRuta: '36' },
    })
  })

  it.each(['DE', 'SE', 'FI', 'MC', 'XI'])('is refused for goods that stay in the EU goods area (%s)', (country) => {
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: country })).toEqual({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH',
      details: { vat_treatment: 'export', delivery_country: country, required: 'outside_eu' },
    })
  })

  // An unassigned code is outside the EU table, so it would read as "outside
  // the EU" and unlock 0 %: refused whether stated or implied.
  it.each([
    ['export', 'ZZ'],
    ['export', 'QQ'],
    [null, 'XX'],
    ['reverse_charge', 'AA'],
  ] as const)('refuses an unassigned delivery country (%s, %s)', (treatment, country) => {
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: treatment, delivery_country: country })).toEqual({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH',
      details: { vat_treatment: treatment, delivery_country: country, required: 'assigned_iso_country' },
    })
  })

  it('still accepts XK (Kosovo) as an export destination', () => {
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: 'XK' })).toMatchObject({
      ok: true,
      rules: { momsRuta: '36' },
    })
  })

  it('without a destination is only the services export the customer already has', () => {
    expect(resolveInvoiceVatRules(norwegianBusiness, { vat_treatment: 'export', delivery_country: null })).toMatchObject({
      ok: true,
      rules: { treatment: 'export', momsRuta: '40' },
      explainFromCustomer: true,
    })
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: null })).toEqual({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED',
      details: { vat_treatment: 'export', delivery_country: null, customer_vat_treatment: 'standard_25' },
    })
  })

  it('reads a lower-case code and the VIES spellings', () => {
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: 'no' })).toMatchObject({
      ok: true,
      rules: { momsRuta: '36' },
    })
    // UK is the customary spelling of GB (outside the EU), EL of Greece (inside).
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: 'UK' }).ok).toBe(true)
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'export', delivery_country: 'EL' }).ok).toBe(false)
  })
})

describe('intra-EU supply of goods (unionsintern leverans)', () => {
  it('goods to another member state for a buyer with a validated VAT number there: 0 %, ruta 35, Article 138 notice', () => {
    const resolved = resolveInvoiceVatRules(germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: 'DE' })
    expect(resolved).toMatchObject({
      ok: true,
      rules: { treatment: 'reverse_charge', rate: 0, momsRuta: '35', reverseChargeText: EU_GOODS_SUPPLY_NOTICE },
      explainFromCustomer: false,
    })
    if (resolved.ok) expect(resolved.permittedRates.map((r) => r.rate)).toEqual([0])
    // Not the services notice: that one cites Article 196, the reverse charge on services.
    expect(EU_GOODS_SUPPLY_NOTICE).not.toBe(EU_REVERSE_CHARGE_NOTICE)
    expect(EU_GOODS_SUPPLY_NOTICE).toContain('Unionsintern leverans')
    expect(EU_GOODS_SUPPLY_NOTICE).toContain('Article 138')
  })

  it('accepts a Swedish buyer whose card carries its validated VAT number from the destination state', () => {
    const swedishWithGermanNumber = { ...swedishBusiness, vat_number: 'DE811234567' }
    expect(
      resolveInvoiceVatRules(swedishWithGermanNumber, { vat_treatment: 'reverse_charge', delivery_country: 'DE' }),
    ).toMatchObject({ ok: true, rules: { momsRuta: '35' } })
  })

  it.each([
    ['a Swedish VAT number', swedishBusiness, 'not_another_member_state'],
    ['no VAT number', { ...germanBusiness, vat_number: null, vat_number_validated: false }, 'missing'],
    ['a number not validated against VIES', { ...germanBusiness, vat_number_validated: false }, 'not_validated'],
    ['a private person', { ...consumer, vat_number: 'DE811234567', vat_number_validated: true }, 'private_person'],
    ['a number with no country prefix', { ...germanBusiness, vat_number: '811234567' }, 'not_another_member_state'],
  ])('is refused for a buyer with %s', (_label, customer, reason) => {
    const resolved = resolveInvoiceVatRules(customer as VatTreatmentCustomer, {
      vat_treatment: 'reverse_charge',
      delivery_country: 'DE',
    })
    expect(resolved).toMatchObject({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_BUYER_VAT_NUMBER_REQUIRED',
      details: { vat_treatment: 'reverse_charge', delivery_country: 'DE', reason },
    })
  })

  it.each(['SE', 'NO', 'US'])('is refused when the goods do not go to another member state (%s)', (country) => {
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: country })).toEqual({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH',
      details: { vat_treatment: 'reverse_charge', delivery_country: country, required: 'other_eu_member_state' },
    })
  })

  it('counts Northern Ireland (XI) and Monaco as inside the EU for goods', () => {
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: 'XI' }).ok).toBe(true)
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: 'MC' }).ok).toBe(true)
  })

  it('without a destination is only the services reverse charge the customer already has', () => {
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: null })).toMatchObject({
      ok: true,
      rules: { treatment: 'reverse_charge', momsRuta: '39', reverseChargeText: EU_REVERSE_CHARGE_NOTICE },
    })
    expect(
      resolveInvoiceVatRules(swedishBusiness, { vat_treatment: 'reverse_charge', delivery_country: null }),
    ).toMatchObject({ ok: false, code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED' })
  })
})

describe('standard (Swedish VAT at the line rates)', () => {
  it('is always allowed and lets the lines carry 25, 12, 6 or 0 %', () => {
    for (const customer of [swedishBusiness, germanBusiness, norwegianBusiness, consumer]) {
      for (const delivery_country of [null, 'SE', 'DE', 'NO']) {
        const resolved = resolveInvoiceVatRules(customer, { vat_treatment: 'standard', delivery_country })
        expect(resolved).toMatchObject({
          ok: true,
          rules: { treatment: 'standard_25', rate: 25, momsRuta: '05' },
          explainFromCustomer: false,
        })
        if (resolved.ok) expect(resolved.permittedRates.map((r) => r.rate)).toEqual([25, 12, 6, 0])
      }
    }
  })
})

describe('a delivery country alone implies the goods treatment', () => {
  it('SE: Swedish VAT, even for a foreign business (the goods never leave Sweden)', () => {
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: null, delivery_country: 'SE' })).toMatchObject({
      ok: true,
      rules: { treatment: 'standard_25', momsRuta: '05' },
    })
  })

  it('outside the EU: export of goods', () => {
    expect(resolveInvoiceVatRules(swedishBusiness, { vat_treatment: null, delivery_country: 'NO' })).toMatchObject({
      ok: true,
      rules: { treatment: 'export', momsRuta: '36' },
    })
  })

  it('another member state: an intra-EU supply, refused without the buyer VAT number (a consumer: say standard)', () => {
    expect(resolveInvoiceVatRules(germanBusiness, { vat_treatment: null, delivery_country: 'DE' })).toMatchObject({
      ok: true,
      rules: { treatment: 'reverse_charge', momsRuta: '35' },
    })
    expect(resolveInvoiceVatRules(consumer, { vat_treatment: null, delivery_country: 'DE' })).toMatchObject({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_BUYER_VAT_NUMBER_REQUIRED',
      details: { vat_treatment: 'reverse_charge', reason: 'private_person' },
    })
  })
})

describe('the header ruta and the booked revenue account always agree', () => {
  // moms_ruta is written from the rule; the momsdeklaration reads the account
  // the booking picks (ACCOUNT_RUTA). They must name the same box.
  const cases: Array<[string, VatTreatmentCustomer, { vat_treatment: 'standard' | 'export' | 'reverse_charge' | null; delivery_country: string | null } | null]> = [
    ['export of goods', swedishBusiness, { vat_treatment: 'export', delivery_country: 'NO' }],
    ['intra-EU goods', germanBusiness, { vat_treatment: 'reverse_charge', delivery_country: 'DE' }],
    ['EU services (customer)', germanBusiness, null],
    ['export services (customer)', norwegianBusiness, null],
    ['domestic', swedishBusiness, { vat_treatment: 'standard', delivery_country: null }],
  ]
  it.each(cases)('%s', (_label, customer, override) => {
    const resolved = resolveInvoiceVatRules(customer, override)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return
    const account = getRevenueAccount(resolved.rules.treatment, 'aktiebolag', override?.delivery_country ?? null)
    expect(ACCOUNT_RUTA[account]?.box).toBe(`ruta${resolved.rules.momsRuta}`)
  })
})
