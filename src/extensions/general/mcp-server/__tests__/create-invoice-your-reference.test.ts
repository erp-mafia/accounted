/**
 * gnubok_create_invoice: Er referens the agent leaves out comes from the
 * customer card's Fakturareferens (crm#1200), and Märkning from the card's
 * Märkning (crm#1477), staged resolved so the approval card shows what the
 * invoice gets. What the agent states wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

const ITEMS = [{ description: 'Konsulttimme', quantity: 1, unit: 'tim', unit_price: 1000 }]

beforeEach(() => {
  vi.clearAllMocks()
})

async function stage(
  invoiceReference: string | null,
  args: Record<string, unknown> = {},
  invoiceMarking: string | null = null,
) {
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({
    data: {
      id: 'cust-1',
      name: 'Acme AB',
      customer_type: 'swedish_business',
      vat_number_validated: false,
      default_payment_terms: 30,
      contact_person: 'Karin Ek',
      invoice_reference: invoiceReference,
      invoice_marking: invoiceMarking,
    },
    error: null,
  }) // customers fetch
  enqueue({ data: { vat_registered: true }, error: null }) // buildStagedInvoice: company_settings
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
  enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert
  await createInvoice.execute(
    { customer_id: 'cust-1', invoice_date: '2026-10-02', items: ITEMS, ...args },
    'company-1',
    'user-1',
    supabase as never,
  )
  const insert = findCalls('pending_operations', 'insert')[0]?.[0] as { params?: Record<string, unknown> } | undefined
  return insert?.params ?? {}
}

describe('gnubok_create_invoice: Er referens from the customer card', () => {
  it('stages the Fakturareferens when the agent states none', async () => {
    expect((await stage('KST 4410')).your_reference).toBe('KST 4410')
  })

  it('reads an empty your_reference as none', async () => {
    expect((await stage('KST 4410', { your_reference: '' })).your_reference).toBe('KST 4410')
  })

  it('keeps the Er referens the agent states', async () => {
    expect((await stage('KST 4410', { your_reference: 'Inköp 77' })).your_reference).toBe('Inköp 77')
  })

  it('stages none for a customer without one, and never the contact person', async () => {
    expect((await stage(null)).your_reference).toBeNull()
  })
})

describe('gnubok_create_invoice: Märkning from the customer card (crm#1477)', () => {
  it('stages the card\'s Märkning when the agent states none', async () => {
    expect((await stage(null, {}, '4500012345')).invoice_marking).toBe('4500012345')
  })

  it('keeps the Märkning the agent states', async () => {
    expect((await stage(null, { invoice_marking: 'Projekt Norr' }, '4500012345')).invoice_marking).toBe('Projekt Norr')
  })

  it('stages none for a customer without one', async () => {
    expect((await stage(null)).invoice_marking).toBeNull()
  })
})
