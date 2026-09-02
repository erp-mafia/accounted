import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { encryptPersonnummer, decryptPersonnummer } from '@/lib/salary/personnummer'
import type { Customer, InvoiceDocumentType } from '@/types'

// Uses the REAL getVatRules / rot-rut-rules / personnummer helpers (only the
// supabase lookups are mocked) so the test exercises the same computation the
// POST and PATCH routes rely on.
function call(
  enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'],
  supabase: SupabaseClient,
  customer: Customer,
  input: InvoiceWriteInput,
  documentType: InvoiceDocumentType = 'invoice',
) {
  return buildInvoiceWriteData({ supabase, companyId: 'company-1', customer, documentType, input })
}

const baseHeader = {
  customer_id: 'customer-1',
  invoice_date: '2026-06-15',
  due_date: '2026-07-15',
  currency: 'SEK' as const,
}

describe('buildInvoiceWriteData', () => {
  it('computes totals + item rows for a domestic 25% invoice and omits number/status', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null }) // company_settings.vat_registered

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.subtotal).toBe(10000)
    expect(result.invoiceFields.vat_amount).toBe(2500)
    expect(result.invoiceFields.total).toBe(12500)
    expect(result.invoiceFields.remaining_amount).toBe(12500)
    expect(result.invoiceFields.vat_rate).toBe(25)
    // The route owns these: the builder must never set them.
    expect(result.invoiceFields).not.toHaveProperty('invoice_number')
    expect(result.invoiceFields).not.toHaveProperty('status')
    expect(result.invoiceFields).not.toHaveProperty('user_id')
    // Item row carries no invoice_id: the route adds it.
    expect(result.items).toHaveLength(1)
    expect(result.items[0]).not.toHaveProperty('invoice_id')
    expect(result.items[0]).toMatchObject({
      sort_order: 0,
      line_type: 'product',
      line_total: 10000,
      vat_rate: 25,
      vat_amount: 2500,
    })
  })

  it('maps payment_link_url to a concrete trimmed value, null when absent', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const withLink = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      payment_link_url: '  https://buy.stripe.com/test_abc123  ',
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })
    expect(withLink.ok).toBe(true)
    if (!withLink.ok) return
    expect(withLink.invoiceFields.payment_link_url).toBe('https://buy.stripe.com/test_abc123')

    // Absent input must still produce an explicit null (not undefined):
    // supabase-js drops undefined keys, and a draft edit that cleared the
    // field relies on the NULL actually being written.
    const { supabase: supabase2, enqueue: enqueue2 } = createQueuedMockSupabase()
    enqueue2({ data: { vat_registered: true }, error: null })
    const withoutLink = await call(enqueue2, supabase2 as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })
    expect(withoutLink.ok).toBe(true)
    if (!withoutLink.ok) return
    expect(withoutLink.invoiceFields.payment_link_url).toBeNull()
  })

  it('handles a mixed-rate invoice (vat_rate becomes null on the header)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Tjänst', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 },
        { description: 'Bok', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 6 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_rate).toBeNull()
    expect(result.invoiceFields.vat_amount).toBe(250 + 60)
  })

  it('zeroes VAT when the company is not VAT-registered', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: false }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(0)
    expect(result.invoiceFields.total).toBe(1000)
    expect(result.invoiceFields.vat_treatment).toBe('exempt')
    expect(result.items[0].vat_rate).toBe(0)
  })

  it('rejects a VAT rate that is not a Swedish rate at all', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // 10% is not a Swedish momssats (ML 9 kap: 25 / 12 / 6) for any customer.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 10 }],
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('code' in result && result.code).toBe('INVOICE_CREATE_VAT_RULE_VIOLATION')
  })

  // ============================================================
  // Place of supply: huvudregeln vs taxed-where-performed (ML 6 kap.)
  // ============================================================

  it('keeps a genuine EU B2B consulting line at 0% with the reverse-charge notation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // Huvudregeln (ML 6 kap. 34 §): taxed where the buyer is established.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 10, unit: 'tim', unit_price: 1000, vat_rate: 0 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(0)
    expect(result.invoiceFields.vat_treatment).toBe('reverse_charge')
    expect(result.invoiceFields.moms_ruta).toBe('39')
    expect(result.invoiceFields.reverse_charge_text).toContain('Article 196')
    expect(result.items[0].vat_rate).toBe(0)
  })

  it('defaults an EU B2B line with no explicit rate to 0%, never to 25%', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // Widening the permitted set must not change the default: an omitted
    // vat_rate still falls back to getVatRules().rate === 0.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(0)
    expect(result.invoiceFields.vat_treatment).toBe('reverse_charge')
    expect(result.invoiceFields.reverse_charge_text).toContain('Article 196')
  })

  it('accepts a taxed-where-performed line to an EU business and drops the RC notation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // Stockholm hotel night invoiced to a German company. Restaurang/hotell is
    // taxed where performed (ML 6 kap. exception), so Swedish 12% applies even
    // though the buyer is an EU business. This was refused outright before.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Hotellnatt Stockholm', quantity: 2, unit: 'natt', unit_price: 1000, vat_rate: 12 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(240)
    expect(result.invoiceFields.total).toBe(2240)
    // Nothing on this invoice is reverse-charged: the notation would be a false
    // statement and would tell the buyer to self-assess VAT already collected.
    expect(result.invoiceFields.reverse_charge_text).toBeNull()
    expect(result.invoiceFields.vat_treatment).not.toBe('reverse_charge')
    expect(result.invoiceFields.moms_ruta).toBe('05')
    expect(result.items[0].vat_rate).toBe(12)
    expect(result.items[0].vat_amount).toBe(240)
  })

  it('accepts a taxed-where-performed line to a non-EU business and drops the export notation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // Conference admission sold to a US company; admission to cultural/sports
    // events is taxed at the event location, so Swedish 6% applies.
    const customer = makeCustomer({ customer_type: 'non_eu_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konferensbiljett', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 6 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(60)
    expect(result.invoiceFields.reverse_charge_text).toBeNull()
    expect(result.invoiceFields.vat_treatment).not.toBe('export')
    expect(result.invoiceFields.moms_ruta).toBe('05')
  })

  it('keeps a non-EU business consulting line at 0% with the export notation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'non_eu_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [{ description: 'Konsult', quantity: 5, unit: 'tim', unit_price: 1000, vat_rate: 0 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(0)
    expect(result.invoiceFields.vat_treatment).toBe('export')
    expect(result.invoiceFields.moms_ruta).toBe('40')
    expect(result.invoiceFields.reverse_charge_text).toContain('ML 10 kap')
  })

  it('keeps the RC notation on a mixed invoice that still has zero-rated lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // 0% consulting (huvudregeln, reverse charge) + 12% hotel (taxed where
    // performed) on one invoice. The buyer IS liable for the consulting line,
    // so the notation is required; the 12% line still carries Swedish VAT.
    const customer = makeCustomer({ customer_type: 'eu_business', vat_number_validated: true })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 0 },
        { description: 'Hotellnatt Stockholm', quantity: 1, unit: 'natt', unit_price: 1000, vat_rate: 12 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.vat_amount).toBe(120)
    expect(result.invoiceFields.vat_treatment).toBe('reverse_charge')
    expect(result.invoiceFields.moms_ruta).toBe('39')
    expect(result.invoiceFields.reverse_charge_text).toContain('Article 196')
    expect(result.invoiceFields.vat_rate).toBeNull() // mixed
  })

  it('excludes free-text rows from totals', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      items: [
        { description: 'Rubrik', quantity: 0, unit: '', unit_price: 0, vat_rate: 0, line_type: 'text' },
        { description: 'Konsult', quantity: 2, unit: 'tim', unit_price: 500, vat_rate: 25 },
      ],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.subtotal).toBe(1000)
    expect(result.invoiceFields.vat_amount).toBe(250)
    expect(result.items[0]).toMatchObject({ line_type: 'text', line_total: 0, vat_amount: 0 })
  })
})

describe('buildInvoiceWriteData stored ROT/RUT personnummer (edit path)', () => {
  const rutItem = {
    description: 'Städning',
    quantity: 10,
    unit: 'tim',
    unit_price: 500,
    vat_rate: 25,
    deduction_type: 'rut' as const,
    work_type: 'STAD',
    labor_hours: 10,
  }

  it('keeps the stored ciphertext when the edit leaves personnummer empty', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'individual' })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
      existingPersonnummer: { encrypted: 'stored-ciphertext', last4: '1234' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_encrypted).toBe('stored-ciphertext')
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('1234')
  })

  it('still rejects a deduction invoice with no personnummer anywhere (create path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'individual' })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('code' in result && result.code).toBe('INVOICE_CREATE_ROT_RUT_VALIDATION')
  })

  it('does not resurrect the stored personnummer when all deduction lines are removed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'individual' })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [{ description: 'Vanlig tjänst', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 }] },
      existingPersonnummer: { encrypted: 'stored-ciphertext', last4: '1234' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_encrypted).toBeNull()
    expect(result.invoiceFields.deduction_personnummer_last4).toBeNull()
  })
})

describe('buildInvoiceWriteData kundkort personnummer fallback', () => {
  const rutItem = {
    description: 'Städning',
    quantity: 10,
    unit: 'tim',
    unit_price: 500,
    vat_rate: 25,
    deduction_type: 'rut' as const,
    work_type: 'STAD',
    labor_hours: 10,
  }

  it('falls back to the customer card personal_number when the field is empty', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({
      customer_type: 'individual',
      personal_number: encryptPersonnummer('199001019802'),
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('9802')
    expect(decryptPersonnummer(result.invoiceFields.deduction_personnummer_encrypted as string)).toBe('199001019802')
  })

  it('expands a 10-digit legacy plaintext kundkort value to 12 digits', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({
      customer_type: 'individual',
      personal_number: '900101-9802',
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('9802')
    expect(decryptPersonnummer(result.invoiceFields.deduction_personnummer_encrypted as string)).toBe('199001019802')
  })

  it('lets a typed personnummer win over the customer card', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({
      customer_type: 'individual',
      personal_number: '250101-0025',
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, deduction_personnummer: '199001019802', items: [rutItem] },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('9802')
    expect(decryptPersonnummer(result.invoiceFields.deduction_personnummer_encrypted as string)).toBe('199001019802')
  })

  it('lets the stored draft personnummer outrank the customer card (edit path)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({
      customer_type: 'individual',
      personal_number: '900101-9802',
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
      existingPersonnummer: { encrypted: 'stored-ciphertext', last4: '1234' },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.deduction_personnummer_encrypted).toBe('stored-ciphertext')
    expect(result.invoiceFields.deduction_personnummer_last4).toBe('1234')
  })

  it('treats an invalid kundkort value as absent and still requires a typed one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({
      customer_type: 'individual',
      // Bad Luhn: must fall through to the "Personnummer krävs" error, never
      // to a confusing "invalid personnummer" for a value the user never typed.
      personal_number: '900101-9803',
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: { ...baseHeader, items: [rutItem] },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('code' in result && result.code).toBe('INVOICE_CREATE_ROT_RUT_VALIDATION')
  })
})

describe('buildInvoiceWriteData kundkort fallback customer-type gate', () => {
  it('never claims on a stray personal_number of a non-individual customer', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    // personal_number is individual-only in the Zod schemas but not in the
    // DB: a legacy/business row carrying one must not be claimed on
    // implicitly, so the fallback stays off and validation asks for a typed
    // personnummer.
    const customer = makeCustomer({
      customer_type: 'swedish_business',
      personal_number: '900101-9802',
    })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer,
      documentType: 'invoice',
      input: {
        ...baseHeader,
        items: [{
          description: 'Städning',
          quantity: 10,
          unit: 'tim',
          unit_price: 500,
          vat_rate: 25,
          deduction_type: 'rut' as const,
          work_type: 'STAD',
          labor_hours: 10,
        }],
      },
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect('code' in result && result.code).toBe('INVOICE_CREATE_ROT_RUT_VALIDATION')
  })

  it('writes valid_until + quote_status open for a quote, mirrors it into due_date and keeps nothing owed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(
      enqueue,
      supabase as unknown as SupabaseClient,
      customer,
      {
        ...baseHeader,
        valid_until: '2026-08-01',
        items: [{ description: 'Offererat arbete', quantity: 2, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
      'quote',
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.document_type).toBe('quote')
    expect(result.invoiceFields.valid_until).toBe('2026-08-01')
    expect(result.invoiceFields.due_date).toBe('2026-08-01')
    expect(result.invoiceFields.quote_status).toBe('open')
    expect(result.invoiceFields.total).toBe(2500)
    expect(result.invoiceFields.remaining_amount).toBe(0)
    expect(result.invoiceFields.deduction_total).toBe(0)
  })

  it('leaves the quote columns NULL on every other document type', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })

    const customer = makeCustomer({ customer_type: 'swedish_business' })
    const result = await call(enqueue, supabase as unknown as SupabaseClient, customer, {
      ...baseHeader,
      valid_until: '2026-08-01',
      items: [{ description: 'Konsult', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.invoiceFields.valid_until).toBeNull()
    expect(result.invoiceFields.quote_status).toBeNull()
    expect(result.invoiceFields.due_date).toBe(baseHeader.due_date)
  })
})
