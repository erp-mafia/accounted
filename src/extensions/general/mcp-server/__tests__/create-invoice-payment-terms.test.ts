/**
 * gnubok_create_invoice: a due date the caller omits comes from the
 * customer's payment terms. 0 days (betalning direkt, #2070) is a valid term
 * and must not reopen as 30.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const createInvoice = tools.find((t) => t.name === 'gnubok_create_invoice')!

const ITEMS = [{ description: 'Konsulttimme', quantity: 1, unit: 'tim', unit_price: 1000 }]

beforeEach(() => {
  vi.clearAllMocks()
})

async function stageFor(defaultPaymentTerms: number | null) {
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  enqueue({
    data: {
      id: 'cust-1',
      name: 'Acme AB',
      customer_type: 'swedish_business',
      vat_number_validated: false,
      default_payment_terms: defaultPaymentTerms,
    },
    error: null,
  }) // customers fetch
  enqueue({ data: { vat_registered: true }, error: null }) // buildStagedInvoice: company_settings
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 1
  enqueue({ data: null, error: null }) // resolvePeriodStatusForDate layer 2
  enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert
  await createInvoice.execute(
    { customer_id: 'cust-1', invoice_date: '2026-10-02', items: ITEMS },
    'company-1',
    'user-1',
    supabase as never,
  )
  const insert = findCalls('pending_operations', 'insert')[0]?.[0] as { params?: Record<string, unknown> } | undefined
  return insert?.params ?? {}
}

describe('gnubok_create_invoice: due date from the customer terms', () => {
  it('a 0-day customer is due on the invoice date', async () => {
    expect((await stageFor(0)).due_date).toBe('2026-10-02')
  })

  it('a 14-day customer is due 14 days after the invoice date', async () => {
    expect((await stageFor(14)).due_date).toBe('2026-10-16')
  })

  it('a customer without terms falls back to 30 days', async () => {
    expect((await stageFor(null)).due_date).toBe('2026-11-01')
  })
})
