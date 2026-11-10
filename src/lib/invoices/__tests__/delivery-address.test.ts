/**
 * Leveransadress per invoice (crm#1547): validated and normalized on every
 * write door, written only when sent, printed on the PDF and carried to
 * Peppol as BG-13. Every name and address is made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase, makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { buildInvoiceWriteData, type InvoiceWriteInput } from '@/lib/invoices/build-invoice-write'
import { CreateInvoiceSchema, UpdateInvoiceSchema } from '@/lib/api/schemas'
import { UpdateInvoiceParamsSchema } from '@/lib/pending-operations/schemas/update-invoice'
import { CreateInvoiceParamsSchema } from '@/lib/pending-operations/build-staged-invoice'
import { InvoicePDF } from '@/lib/invoices/pdf-template'
import { renderDelivery } from '@/lib/invoices/peppol-bis-billing'
import { buildInvoiceWritePayload } from '@/lib/invoices/editor-payload'
import {
  DELIVERY_ADDRESS_MAX_LENGTH,
  deliveryAddressFormValues,
  deliveryAddressLines,
  EMPTY_DELIVERY_ADDRESS_FORM,
  InvoiceDeliveryAddressSchema,
  normalizeDeliveryAddress,
} from '../delivery-address'
import { treeText } from './pdf-tree'
import type { InvoiceItem } from '@/types'

const ADDRESS = {
  name: 'Exempelbutiken Centrum',
  address_line1: 'Provgatan 12',
  address_line2: 'Lastkaj 3',
  postal_code: '111 22',
  city: 'Exempelstad',
  country: 'se',
}

describe('the delivery address shape', () => {
  it('trims, upper-cases the country and reads empty parts as unset', () => {
    expect(InvoiceDeliveryAddressSchema.parse({ ...ADDRESS, name: '  Exempelbutiken Centrum ', address_line2: '' })).toEqual({
      name: 'Exempelbutiken Centrum',
      address_line1: 'Provgatan 12',
      address_line2: null,
      postal_code: '111 22',
      city: 'Exempelstad',
      country: 'SE',
    })
  })

  it('reads an address with nothing in it as none', () => {
    expect(InvoiceDeliveryAddressSchema.parse({})).toBeNull()
    expect(InvoiceDeliveryAddressSchema.parse({ country: 'DE' })).toBeNull()
    expect(normalizeDeliveryAddress('Provgatan 12')).toBeNull()
  })

  it('refuses an unknown key and a country that is not an ISO code', () => {
    expect(InvoiceDeliveryAddressSchema.safeParse({ ...ADDRESS, street: 'x' }).success).toBe(false)
    expect(InvoiceDeliveryAddressSchema.safeParse({ ...ADDRESS, country: 'Sverige' }).success).toBe(false)
    expect(InvoiceDeliveryAddressSchema.safeParse({ ...ADDRESS, country: 'QQ' }).success).toBe(false)
  })

  it('is accepted by the web and v1 create and edit schemas and the staged MCP schemas, null clearing', () => {
    const create = CreateInvoiceSchema.parse({
      customer_id: '11111111-1111-4111-8111-111111111111',
      invoice_date: '2026-10-30',
      due_date: '2026-11-29',
      currency: 'SEK',
      delivery_address: ADDRESS,
      items: [{ description: 'Varor', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 }],
    })
    expect(create.delivery_address).toMatchObject({ name: 'Exempelbutiken Centrum', country: 'SE' })
    expect(UpdateInvoiceSchema.safeParse({ ...create, delivery_address: null }).success).toBe(true)
    expect(UpdateInvoiceParamsSchema.parse({ invoice_id: '11111111-1111-4111-8111-111111111111', changes: { delivery_address: null } }).changes.delivery_address).toBeNull()
    expect(
      CreateInvoiceParamsSchema.parse({
        customer_id: 'c',
        items: [{ description: 'Varor', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25 }],
        invoice_date: '2026-10-30',
        due_date: '2026-11-29',
        delivery_address: ADDRESS,
      }).delivery_address,
    ).toMatchObject({ city: 'Exempelstad' })
  })

  it('prints name, street, postal line and a foreign country only', () => {
    expect(deliveryAddressLines(ADDRESS)).toEqual(['Exempelbutiken Centrum', 'Provgatan 12', 'Lastkaj 3', '111 22 Exempelstad'])
    expect(deliveryAddressLines({ ...ADDRESS, country: 'DE' }, 'SE', () => 'Tyskland')).toContain('Tyskland')
    expect(deliveryAddressLines(null)).toEqual([])
  })
})

describe('the invoice editor fields', () => {
  const EDITOR_BODY = {
    customer_id: '11111111-1111-4111-8111-111111111111',
    invoice_date: '2026-10-30',
    due_date: '2026-11-29',
    currency: 'SEK',
    // deduction_type as the editor's rows carry it (the builder's item type is all-optional, a weak type).
    items: [{ description: 'Varor', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 25, deduction_type: null }],
  }

  /** The body the editor sends for these fields (lib/invoices/editor-payload.ts). */
  function editorBody(delivery_address: typeof EMPTY_DELIVERY_ADDRESS_FORM) {
    // The editor's form carries more fields than the payload builder names; it spreads them through.
    const form = { ...EDITOR_BODY, delivery_address }
    return buildInvoiceWritePayload(form, { oreRounding: false, defaultDims: {} })
  }

  it('fills the fields from a stored address, every part a string', () => {
    expect(deliveryAddressFormValues({ ...ADDRESS, address_line2: null })).toEqual({
      name: 'Exempelbutiken Centrum',
      address_line1: 'Provgatan 12',
      address_line2: '',
      postal_code: '111 22',
      city: 'Exempelstad',
      country: 'SE',
    })
  })

  it('starts empty without an address, or with one that says nothing', () => {
    expect(deliveryAddressFormValues(null)).toEqual(EMPTY_DELIVERY_ADDRESS_FORM)
    expect(deliveryAddressFormValues(undefined)).toEqual(EMPTY_DELIVERY_ADDRESS_FORM)
    expect(deliveryAddressFormValues({ country: 'DE' })).toEqual(EMPTY_DELIVERY_ADDRESS_FORM)
    // A fresh copy each time: the form never writes into the shared constant.
    expect(deliveryAddressFormValues(null)).not.toBe(EMPTY_DELIVERY_ADDRESS_FORM)
  })

  it('saves an untouched draft with the address it had, through the create and edit schemas', () => {
    const stored = normalizeDeliveryAddress(ADDRESS)
    const body = editorBody(deliveryAddressFormValues(stored))
    expect(CreateInvoiceSchema.parse(body).delivery_address).toEqual(stored)
    expect(UpdateInvoiceSchema.parse(body).delivery_address).toEqual(stored)
  })

  it('clears the address when the fields are emptied, and "Kundens land" stores no country', () => {
    expect(UpdateInvoiceSchema.parse(editorBody({ ...EMPTY_DELIVERY_ADDRESS_FORM })).delivery_address).toBeNull()
    const noCountry = editorBody({ ...deliveryAddressFormValues(ADDRESS), country: '' })
    expect(UpdateInvoiceSchema.parse(noCountry).delivery_address).toMatchObject({ city: 'Exempelstad', country: null })
  })

  it('refuses a part longer than its field allows, the same limit the inputs carry', () => {
    const tooLong = { ...deliveryAddressFormValues(ADDRESS), postal_code: '1'.repeat(DELIVERY_ADDRESS_MAX_LENGTH.postal_code + 1) }
    expect(UpdateInvoiceSchema.safeParse(editorBody(tooLong)).success).toBe(false)
    const atLimit = { ...tooLong, postal_code: '1'.repeat(DELIVERY_ADDRESS_MAX_LENGTH.postal_code) }
    expect(UpdateInvoiceSchema.safeParse(editorBody(atLimit)).success).toBe(true)
  })
})

describe('the invoice builder', () => {
  async function build(extra: Partial<InvoiceWriteInput>) {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { vat_registered: true }, error: null })
    const result = await buildInvoiceWriteData({
      supabase: supabase as unknown as SupabaseClient,
      companyId: 'company-1',
      customer: makeCustomer({ customer_type: 'swedish_business' }),
      documentType: 'invoice',
      input: {
        customer_id: 'customer-1',
        invoice_date: '2026-06-15',
        due_date: '2026-07-15',
        currency: 'SEK',
        ...extra,
        items: [{ description: 'Varor', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 25 }],
      },
    })
    if (!result.ok) throw new Error('build failed')
    return result.invoiceFields
  }

  it('writes the address only when the input carries it: omitted keeps a draft\'s, null clears it', async () => {
    expect(await build({ delivery_address: normalizeDeliveryAddress(ADDRESS) })).toMatchObject({
      delivery_address: { name: 'Exempelbutiken Centrum', country: 'SE' },
    })
    expect(await build({ delivery_address: null })).toMatchObject({ delivery_address: null })
    // Never named when not sent: no write touches the column before the migration applies.
    expect(await build({})).not.toHaveProperty('delivery_address')
  })
})

const item: InvoiceItem = {
  id: 'item-0',
  invoice_id: 'inv-1',
  sort_order: 0,
  line_type: 'product',
  description: 'Varor',
  quantity: 2,
  unit: 'st',
  unit_price: 1000,
  line_total: 2000,
  vat_rate: 25,
  vat_amount: 500,
  created_at: '2026-10-15T00:00:00Z',
}

function pdfText(deliveryAddress: unknown, language: 'sv' | 'en' = 'sv'): string {
  return treeText(
    InvoicePDF({
      invoice: makeInvoice({ id: 'inv-1', status: 'sent', invoice_number: '1001', total: 2500, delivery_address: deliveryAddress as never }),
      customer: makeCustomer({ language }),
      items: [item],
      company: makeCompanySettings(),
      paymentQr: null,
    }),
  )
}

describe('the invoice PDF', () => {
  it('prints the delivery address under Leveransadress', () => {
    const text = pdfText(ADDRESS)
    expect(text).toContain('Leveransadress:')
    expect(text).toContain('Exempelbutiken Centrum')
    expect(text).toContain('111 22 Exempelstad')
  })

  it('labels it Delivery address in English and prints nothing without one', () => {
    expect(pdfText(ADDRESS, 'en')).toContain('Delivery address:')
    expect(pdfText(null)).not.toContain('Leveransadress')
    expect(pdfText(undefined)).not.toContain('Leveransadress')
  })
})

describe('the Peppol delivery group (BG-13)', () => {
  it('keeps the date-only form when there is no address', () => {
    expect(renderDelivery({ delivery_date: '2026-10-29', delivery_address: null }, 'SE')).toBe(
      '  <cac:Delivery><cbc:ActualDeliveryDate>2026-10-29</cbc:ActualDeliveryDate></cac:Delivery>',
    )
    expect(renderDelivery({ delivery_date: null }, 'SE')).toBeNull()
  })

  it('carries the address (BG-15) and the party name (BT-70) in UBL order, the buyer country as the fallback', () => {
    const xml = renderDelivery({ delivery_date: '2026-10-29', delivery_address: { ...ADDRESS, country: null, name: 'A & B' } as never }, 'SE')!
    expect(xml).toContain('<cbc:StreetName>Provgatan 12</cbc:StreetName>')
    expect(xml).toContain('<cbc:AdditionalStreetName>Lastkaj 3</cbc:AdditionalStreetName>')
    expect(xml).toContain('<cbc:CityName>Exempelstad</cbc:CityName>')
    expect(xml).toContain('<cbc:PostalZone>111 22</cbc:PostalZone>')
    expect(xml).toContain('<cbc:IdentificationCode>SE</cbc:IdentificationCode>')
    expect(xml).toContain('<cbc:Name>A &amp; B</cbc:Name>')
    const order = ['ActualDeliveryDate', 'DeliveryLocation', 'DeliveryParty'].map((tag) => xml.indexOf(tag))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('prefers the address country, then the goods delivery_country, and leaves the address out with no country at all', () => {
    expect(renderDelivery({ delivery_date: null, delivery_address: { ...ADDRESS, country: 'NO' } as never, delivery_country: 'DE' }, 'SE')).toContain('>NO<')
    expect(renderDelivery({ delivery_date: null, delivery_address: { ...ADDRESS, country: null } as never, delivery_country: 'DE' }, 'SE')).toContain('>DE<')
    const nameOnly = renderDelivery({ delivery_date: null, delivery_address: { ...ADDRESS, country: null } as never }, null)!
    expect(nameOnly).not.toContain('DeliveryLocation')
    expect(nameOnly).toContain('<cbc:Name>Exempelbutiken Centrum</cbc:Name>')
  })
})
