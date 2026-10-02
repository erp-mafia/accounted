/**
 * The shared invoice builder applies the per-invoice VAT treatment (#2906)
 * through resolveInvoiceVatRules: rate gate, header (treatment, ruta,
 * statutory notice), the stored statement, warnings, and refusals. Only the
 * supabase lookups are mocked.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import {
  buildInvoiceWriteData,
  type InvoiceWriteInput,
} from '@/lib/invoices/build-invoice-write'
import { EU_GOODS_SUPPLY_NOTICE, EXPORT_NOTICE_SV, type InvoiceVatOverride } from '@/lib/invoices/vat-rules'
import type { Customer, InvoiceDocumentType } from '@/types'

const header = {
  customer_id: 'customer-1',
  invoice_date: '2026-09-27',
  due_date: '2026-10-27',
  currency: 'SEK' as const,
}
const goodsLine = { description: 'Pallställ', quantity: 2, unit: 'st', unit_price: 5000 }

async function build(
  customer: Customer,
  input: Omit<InvoiceWriteInput, keyof typeof header> & Partial<typeof header>,
  options: { vatRegistered?: boolean; existingVatOverride?: InvoiceVatOverride | null; documentType?: InvoiceDocumentType } = {},
) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { vat_registered: options.vatRegistered ?? true }, error: null })
  return buildInvoiceWriteData({
    supabase: supabase as unknown as SupabaseClient,
    companyId: 'company-1',
    customer,
    documentType: options.documentType ?? 'invoice',
    input: { ...header, ...input } as InvoiceWriteInput,
    existingVatOverride: options.existingVatOverride,
  })
}

const swedishBuyer = makeCustomer({ customer_type: 'swedish_business', country: 'SE', vat_number: 'SE556677889901' })
const germanBuyer = makeCustomer({
  customer_type: 'eu_business',
  country: 'DE',
  vat_number: 'DE811234567',
  vat_number_validated: true,
})

describe('buildInvoiceWriteData: per-invoice VAT treatment', () => {
  it('leaves the customer-decided invoice unchanged and stores no statement', async () => {
    const result = await build(swedishBuyer, { items: [{ ...goodsLine }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields).toMatchObject({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
      vat_amount: 2500,
      vat_treatment_override: null,
      delivery_country: null,
    })
    expect(result.items[0].vat_rate).toBe(25)
  })

  it('export of goods to Norway for a Swedish buyer: 0 % lines, ruta 36, the export notice, stored statement', async () => {
    const result = await build(swedishBuyer, {
      vat_treatment: 'export',
      delivery_country: 'NO',
      items: [{ ...goodsLine }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields).toMatchObject({
      vat_treatment: 'export',
      vat_rate: 0,
      moms_ruta: '36',
      reverse_charge_text: EXPORT_NOTICE_SV,
      subtotal: 10000,
      vat_amount: 0,
      total: 10000,
      vat_treatment_override: 'export',
      delivery_country: 'NO',
    })
    // A line without vat_rate takes the treatment's 0 %, never the customer's 25 %.
    expect(result.items[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
    // The customer-based explanation does not describe a stated export.
    expect(result.warnings).toEqual([])
  })

  it('intra-EU supply of goods: ruta 35 and the Article 138 notice, not the services one', async () => {
    const result = await build(germanBuyer, {
      vat_treatment: 'reverse_charge',
      delivery_country: 'DE',
      items: [{ ...goodsLine, vat_rate: 0 }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields).toMatchObject({
      vat_treatment: 'reverse_charge',
      moms_ruta: '35',
      reverse_charge_text: EU_GOODS_SUPPLY_NOTICE,
      vat_amount: 0,
      delivery_country: 'DE',
    })
  })

  it('refuses a Swedish rate on a stated goods export (a Swedish-VAT supply is a separate invoice)', async () => {
    const result = await build(swedishBuyer, {
      vat_treatment: 'export',
      delivery_country: 'NO',
      items: [{ ...goodsLine, vat_rate: 25 }],
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
      details: { attemptedRate: 25, allowedRates: [0] },
    })
  })

  it('refuses, and writes nothing, when the facts do not support 0 %', async () => {
    await expect(
      build(swedishBuyer, { vat_treatment: 'export', delivery_country: 'DE', items: [{ ...goodsLine }] }),
    ).resolves.toMatchObject({ ok: false, code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_MISMATCH' })
    await expect(
      build(swedishBuyer, { vat_treatment: 'reverse_charge', delivery_country: 'DE', items: [{ ...goodsLine }] }),
    ).resolves.toMatchObject({
      ok: false,
      code: 'INVOICE_VAT_TREATMENT_BUYER_VAT_NUMBER_REQUIRED',
      details: { reason: 'not_another_member_state' },
    })
    await expect(
      build(swedishBuyer, { vat_treatment: 'export', items: [{ ...goodsLine }] }),
    ).resolves.toMatchObject({ ok: false, code: 'INVOICE_VAT_TREATMENT_DELIVERY_COUNTRY_REQUIRED' })
  })

  it('standard: Swedish VAT on a validated EU business, without the reverse-charge warning', async () => {
    const result = await build(germanBuyer, {
      vat_treatment: 'standard',
      items: [{ ...goodsLine }],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields).toMatchObject({ vat_treatment: 'standard_25', moms_ruta: '05', vat_amount: 2500 })
    expect(result.warnings).toEqual([])
  })

  it('refuses a stated treatment for a seller outside the VAT register', async () => {
    const result = await build(
      swedishBuyer,
      { vat_treatment: 'export', delivery_country: 'NO', items: [{ ...goodsLine }] },
      { vatRegistered: false },
    )
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_VAT_TREATMENT_NOT_VAT_REGISTERED' })
  })

  it('refuses periodisering on a stated goods export (ruta 36 must carry the full sale)', async () => {
    const result = await build(swedishBuyer, {
      vat_treatment: 'export',
      delivery_country: 'NO',
      items: [{ ...goodsLine, accrual_period_start: '2026-10-01', accrual_period_end: '2027-03-31' }],
    })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_ACCRUAL_INVALID',
      details: { reason: 'vat_treatment', vatTreatment: 'export' },
    })
  })

  describe('draft edits', () => {
    const storedExport: InvoiceVatOverride = { vat_treatment: 'export', delivery_country: 'NO' }

    it('keeps the stored statement when the edit does not mention it', async () => {
      const result = await build(swedishBuyer, { items: [{ ...goodsLine, vat_rate: 0 }] }, { existingVatOverride: storedExport })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.invoiceFields).toMatchObject({
        vat_treatment: 'export',
        moms_ruta: '36',
        vat_treatment_override: 'export',
        delivery_country: 'NO',
      })
    })

    it('replaces the pair when the edit sends either field (the absent one reads as null)', async () => {
      const result = await build(
        swedishBuyer,
        { vat_treatment: 'standard', items: [{ ...goodsLine }] },
        { existingVatOverride: storedExport },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.invoiceFields).toMatchObject({
        vat_treatment: 'standard_25',
        vat_treatment_override: 'standard',
        delivery_country: null,
      })
    })

    it('clears the statement on null and goes back to the customer', async () => {
      const result = await build(
        swedishBuyer,
        { vat_treatment: null, delivery_country: null, items: [{ ...goodsLine }] },
        { existingVatOverride: storedExport },
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.invoiceFields).toMatchObject({
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        vat_treatment_override: null,
        delivery_country: null,
      })
    })

    it('re-validates a kept statement: lines at 25 % cannot stay on a goods export', async () => {
      const result = await build(swedishBuyer, { items: [{ ...goodsLine, vat_rate: 25 }] }, { existingVatOverride: storedExport })
      expect(result).toMatchObject({ ok: false, code: 'INVOICE_CREATE_VAT_RULE_VIOLATION' })
    })
  })
})
