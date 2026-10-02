import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { DEDUCTION_LINE_ERRORS, GRON_TEKNIK_INVOICE_ERRORS } from '@/lib/invoices/rot-rut-rules'

/**
 * The shared invoice write path (dashboard POST/PATCH, v1, MCP commits) with
 * grön teknik lines: the per-line deduction follows the installation type,
 * the header total is the same sum, the property is stamped onto every
 * deduction line, and what Skatteverket needs is enforced before the write.
 * Real rules and personnummer helpers; only the supabase lookups are mocked.
 */

const PNR = '199110306645'

const header = {
  customer_id: 'customer-1',
  invoice_date: '2026-09-15',
  due_date: '2026-10-15',
  currency: 'SEK' as const,
  deduction_personnummer: PNR,
  deduction_housing_designation: 'Exempelby 1:1',
}

const labour = {
  description: 'Montage solceller',
  quantity: 24,
  unit: 'tim',
  unit_price: 750,
  vat_rate: 25,
  deduction_type: 'gron_teknik' as const,
  work_type: 'INSTALLATION_SOLCELLER',
  labor_hours: 24,
}
const panels = {
  description: 'Solpaneler och växelriktare',
  quantity: 1,
  unit: 'st',
  unit_price: 60000,
  vat_rate: 25,
  deduction_type: 'gron_teknik' as const,
  work_type: 'INSTALLATION_SOLCELLER',
}
const battery = {
  description: 'Batterilager med montage',
  quantity: 1,
  unit: 'st',
  unit_price: 40000,
  vat_rate: 25,
  deduction_type: 'gron_teknik' as const,
  work_type: 'INSTALLATION_LAGRING',
  labor_hours: 6,
}
const travel = { description: 'Resa', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 }

async function build(input: Omit<InvoiceWriteInput, 'customer_id' | 'invoice_date' | 'due_date' | 'currency'> & Partial<InvoiceWriteInput>) {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: { vat_registered: true }, error: null })
  return buildInvoiceWriteData({
    supabase: supabase as unknown as SupabaseClient,
    companyId: 'company-1',
    customer: makeCustomer({ customer_type: 'individual' }),
    documentType: 'invoice',
    input: { ...header, ...input } as InvoiceWriteInput,
  })
}

describe('buildInvoiceWriteData: grön teknik', () => {
  it('computes the reduction per installation type on labour and material, and the header total from the same lines', async () => {
    const result = await build({ items: [labour, panels, battery, travel] })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Labour 18 000 = 22 500 inkl. moms x 15 % = 3 375; panels 60 000 =
    // 75 000 x 15 % = 11 250; battery 40 000 = 50 000 x 50 % = 25 000;
    // travel none. 119 000 exkl. = 148 750 inkl. moms in total.
    expect(result.items.map((row) => row.deduction_amount)).toEqual([3375, 11250, 25000, 0])
    expect(result.invoiceFields.deduction_total).toBe(39625)
    expect(result.invoiceFields.total).toBe(148750)
    expect(result.invoiceFields.remaining_amount).toBe(109125)
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('6645')
  })

  it('stamps the property on every grön teknik line and keeps it off unflagged lines', async () => {
    const result = await build({ items: [labour, panels, travel] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items.map((row) => row.housing_designation)).toEqual(['Exempelby 1:1', 'Exempelby 1:1', null])
    expect(result.items.map((row) => [row.deduction_type, row.work_type, row.labor_hours])).toEqual([
      ['gron_teknik', 'INSTALLATION_SOLCELLER', 24],
      ['gron_teknik', 'INSTALLATION_SOLCELLER', null],
      [null, null, null],
    ])
  })

  it('accepts a bostadsrätt instead of a fastighetsbeteckning', async () => {
    const result = await build({
      deduction_housing_designation: undefined,
      deduction_apartment_number: '1201',
      deduction_brf_org_number: '799900-0040',
      items: [labour],
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({ apartment_number: '1201', brf_org_number: '799900-0040' })
  })

  it('refuses a grön teknik invoice without the property, naming grön teknik', async () => {
    const result = await build({ deduction_housing_designation: undefined, items: [labour] })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      details: { errors: [GRON_TEKNIK_INVOICE_ERRORS.propertyMissing] },
    })
  })

  it('refuses grön teknik next to ROT on one invoice', async () => {
    const rot = { ...travel, deduction_type: 'rot' as const, work_type: 'EL', labor_hours: 2 }
    const result = await build({ items: [labour, rot] })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      details: { errors: [DEDUCTION_LINE_ERRORS.gronTeknikMixed] },
    })
  })

  it('refuses an installation type without hours on any of its rows', async () => {
    const result = await build({ items: [panels] })
    expect(result).toMatchObject({
      ok: false,
      code: 'INVOICE_CREATE_ROT_RUT_VALIDATION',
      details: { errors: [DEDUCTION_LINE_ERRORS.gronTeknikHoursMissing] },
    })
  })

  it('stores the installation type trimmed, as the rate and the claim read it', async () => {
    const result = await build({ items: [{ ...labour, work_type: '  INSTALLATION_SOLCELLER ' }] })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.items[0]).toMatchObject({ work_type: 'INSTALLATION_SOLCELLER', deduction_amount: 3375 })
  })

  it('never books a deduction on a quote, even when a line says grön teknik', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer: makeCustomer({ customer_type: 'individual' }),
      documentType: 'quote',
      input: { ...header, valid_until: '2026-10-15', items: [labour] } as InvoiceWriteInput,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_total).toBe(0)
    expect(result.items[0]).toMatchObject({ deduction_type: null, deduction_amount: 0 })
  })
})
