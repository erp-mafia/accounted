import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { InvoiceItem } from '@/types'
import { generatePeppolBisBillingInvoice } from '../peppol-bis-billing'
import { sha256Hex, stagePeppolDelivery, stagePeppolDeliveryAsActor } from '../peppol-delivery'

describe('sha256Hex', () => {
  it('produces a stable lowercase fingerprint for the exact XML bytes', () => {
    expect(sha256Hex('<Invoice>åäö</Invoice>')).toBe(
      'ab1c7c9e3a2780e73140e40a0af1a1d355026e3b754049bc6b0e8d03490b4d65',
    )
  })
})

describe('staging refuses a draft preview (accounted#44)', () => {
  const item: InvoiceItem = {
    id: 'item-1',
    invoice_id: 'invoice-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Rådgivning',
    quantity: 1,
    unit: 'tim',
    unit_price: 100,
    line_total: 100,
    vat_rate: 25,
    vat_amount: 25,
    created_at: '2026-08-13T00:00:00.000Z',
  }
  const company = makeCompanySettings({
    company_name: 'Säljare AB',
    entity_type: 'aktiebolag',
    org_number: '556016-0680',
    vat_number: 'SE556016068001',
    bankgiro: '991-2346',
  })
  const customer = makeCustomer({ name: 'Kund AB', org_number: '556677-8899', vat_number: 'SE556677889901' })

  function generate(invoiceNumber: string | null, preview: boolean) {
    const result = generatePeppolBisBillingInvoice({
      invoice: makeInvoice({
        id: 'invoice-1',
        invoice_number: invoiceNumber,
        status: invoiceNumber ? 'sent' : 'draft',
        invoice_date: '2026-08-13',
        due_date: '2026-09-12',
        subtotal: 100,
        vat_amount: 25,
        total: 125,
        remaining_amount: 125,
        your_reference: 'KST-100',
      }),
      customer,
      items: [item],
      company,
      preview,
    })
    if (!result.ok) throw new Error(`fixture did not generate: ${result.issues.map((i) => i.code).join(', ')}`)
    return result
  }

  function rpcClient() {
    const rpc = vi.fn().mockResolvedValue({ data: { id: 'delivery-1' }, error: null })
    return { rpc, supabase: { rpc } as unknown as SupabaseClient }
  }

  const stagers = [
    ['stagePeppolDelivery', (supabase: SupabaseClient, document: ReturnType<typeof generate>) =>
      stagePeppolDelivery({ supabase, companyId: 'company-1', invoiceId: 'invoice-1', document })],
    ['stagePeppolDeliveryAsActor', (supabase: SupabaseClient, document: ReturnType<typeof generate>) =>
      stagePeppolDeliveryAsActor({ supabase, companyId: 'company-1', invoiceId: 'invoice-1', actorId: 'user-1', document })],
  ] as const

  it.each(stagers)('%s refuses the preview document before any delivery row is written', async (_name, stage) => {
    const { rpc, supabase } = rpcClient()
    const preview = generate(null, true)

    await expect(stage(supabase, preview)).rejects.toThrow('A Peppol draft preview cannot be staged for delivery')
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(stagers)('%s refuses preview XML even when the flag was lost on the way', async (_name, stage) => {
    const { rpc, supabase } = rpcClient()
    const { preview: _flag, ...stripped } = generate(null, true)

    await expect(stage(supabase, stripped)).rejects.toThrow('A Peppol draft preview cannot be staged for delivery')
    expect(rpc).not.toHaveBeenCalled()
  })

  it.each(stagers)('%s stages the real document of a numbered invoice', async (_name, stage) => {
    const { rpc, supabase } = rpcClient()
    const document = generate('F-2026-42', false)

    await expect(stage(supabase, document)).resolves.toEqual({ id: 'delivery-1' })
    expect(rpc).toHaveBeenCalledWith(expect.stringMatching(/^stage_peppol_delivery/), expect.objectContaining({
      p_xml_payload: document.xml,
      p_filename: 'peppol-invoice-F-2026-42.xml',
    }))
  })
})
