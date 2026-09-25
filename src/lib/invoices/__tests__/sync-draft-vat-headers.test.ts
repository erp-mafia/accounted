import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { syncDraftVatHeadersForCustomer } from '../sync-draft-vat-headers'
import { deriveInvoiceVatHeader as derive, getVatRules, EU_REVERSE_CHARGE_NOTICE, EXPORT_NOTICE_SV } from '../vat-rules'

const deriveInvoiceVatHeader = (
  customer: { customer_type: 'eu_business' | 'non_eu_business'; vat_number_validated?: boolean; country: string },
  rates: number[],
  options: { vatRegistered: boolean },
) => derive(getVatRules(customer.customer_type, customer.vat_number_validated ?? false, customer.country), rates, options)

const validatedFr = { customer_type: 'eu_business' as const, vat_number_validated: true, country: 'FR' }
const unvalidatedFr = { ...validatedFr, vat_number_validated: false }

describe('deriveInvoiceVatHeader', () => {
  it('reverse charge for a validated EU business with a 0 % line', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0], { vatRegistered: true })).toEqual({
      vat_treatment: 'reverse_charge',
      moms_ruta: '39',
      reverse_charge_text: EU_REVERSE_CHARGE_NOTICE,
    })
  })

  it('Swedish VAT while the number is not validated', () => {
    expect(deriveInvoiceVatHeader(unvalidatedFr, [0], { vatRegistered: true })).toEqual({
      vat_treatment: 'standard_25',
      moms_ruta: '05',
      reverse_charge_text: null,
    })
  })

  it('no reverse-charge notice when only Swedish rates are charged', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [12], { vatRegistered: true }).vat_treatment).toBe('standard_25')
  })

  it('keeps the notice on a mixed invoice and on a text-only document', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0, 12], { vatRegistered: true }).vat_treatment).toBe('reverse_charge')
    expect(deriveInvoiceVatHeader(validatedFr, [], { vatRegistered: true }).vat_treatment).toBe('reverse_charge')
  })

  it('export for a non-EU business', () => {
    expect(
      deriveInvoiceVatHeader({ customer_type: 'non_eu_business', country: 'US' }, [0], { vatRegistered: true }),
    ).toEqual({ vat_treatment: 'export', moms_ruta: '40', reverse_charge_text: EXPORT_NOTICE_SV })
  })

  it('momsfri for a seller that is not VAT registered', () => {
    expect(deriveInvoiceVatHeader(validatedFr, [0], { vatRegistered: false })).toEqual({
      vat_treatment: 'exempt',
      moms_ruta: null,
      reverse_charge_text: null,
    })
  })
})

describe('syncDraftVatHeadersForCustomer', () => {
  const mock = createQueuedMockSupabase()
  const supabase = mock.supabase as unknown as SupabaseClient

  beforeEach(() => {
    mock.reset()
  })

  it('moves a stale 25 % draft to reverse charge once the customer is validated', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'standard_25',
            moms_ruta: '05',
            reverse_charge_text: null,
            items: [
              { vat_rate: 0, line_type: 'product' },
              { vat_rate: null, line_type: 'text' },
            ],
          },
        ],
      },
      { data: { vat_registered: true } },
      { data: null, error: null },
    ])

    const updated = await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')

    expect(updated).toBe(1)
    expect(mock.findCall('invoices', 'update')).toEqual([
      { vat_treatment: 'reverse_charge', moms_ruta: '39', reverse_charge_text: EU_REVERSE_CHARGE_NOTICE },
    ])
    // Only open drafts of this customer, never credit notes or self-billed rows,
    // and the write re-checks draft status.
    const eqs = mock.findCalls('invoices', 'eq')
    expect(eqs).toContainEqual(['status', 'draft'])
    expect(eqs).toContainEqual(['customer_id', 'customer-1'])
    expect(eqs).toContainEqual(['is_self_billed', false])
    expect(mock.findCall('invoices', 'is')).toEqual(['credited_invoice_id', null])
    expect(eqs.filter((args) => args[0] === 'status')).toHaveLength(2)
  })

  it('writes nothing when the header already matches', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'reverse_charge',
            moms_ruta: '39',
            reverse_charge_text: EU_REVERSE_CHARGE_NOTICE,
            items: [{ vat_rate: 0, line_type: 'product' }],
          },
        ],
      },
      { data: { vat_registered: true } },
    ])

    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(0)
    expect(mock.findCall('invoices', 'update')).toBeUndefined()
  })

  it('leaves the lines alone: a 25 % line keeps a Swedish header', async () => {
    mock.enqueueMany([
      { data: validatedFr },
      {
        data: [
          {
            id: 'draft-1',
            vat_treatment: 'standard_25',
            moms_ruta: '05',
            reverse_charge_text: null,
            items: [{ vat_rate: 25, line_type: 'product' }],
          },
        ],
      },
      { data: { vat_registered: true } },
    ])

    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'customer-1')).toBe(0)
    expect(mock.findCall('invoice_items', 'update')).toBeUndefined()
    expect(mock.findCall('invoices', 'update')).toBeUndefined()
  })

  it('does nothing for an unknown customer', async () => {
    mock.enqueueMany([{ data: null }])
    expect(await syncDraftVatHeadersForCustomer(supabase, 'company-1', 'missing')).toBe(0)
    expect(mock.findCall('invoices', 'select')).toBeUndefined()
  })

  it('never throws: a failing read reports zero', async () => {
    const broken = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    expect(await syncDraftVatHeadersForCustomer(broken, 'company-1', 'customer-1')).toBe(0)
  })
})
