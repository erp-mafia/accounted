/**
 * gnubok_send_invoice on a draft whose customer was deleted (crm#263).
 *
 * invoices.customer_id is ON DELETE SET NULL, so the customer join comes back
 * null. Staging read `customer.email` and threw a bare TypeError; it now
 * refuses with INVOICE_CUSTOMER_MISSING, which names the way out (set a
 * customer on the draft or delete it), and stages nothing.
 */
import { describe, it, expect, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/email/service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/email/service')>()),
  getEmailService: () => ({ isConfigured: () => true }),
}))

import { tools } from '../server'

const sendInvoice = tools.find((t) => t.name === 'gnubok_send_invoice')!

describe('gnubok_send_invoice: invoice without a customer', () => {
  it('refuses with INVOICE_CUSTOMER_MISSING and stages nothing', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: 'inv-1', status: 'draft', invoice_number: null, customer_id: null, customer: null, total: 1250, currency: 'SEK' },
      error: null,
    })

    await expect(
      sendInvoice.execute({ invoice_id: 'inv-1' }, 'company-1', 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'INVOICE_CUSTOMER_MISSING' })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })
})
