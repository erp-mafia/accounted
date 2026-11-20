import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { listPeppolFailedInvoiceIds, PEPPOL_FAILED_INVOICE_LIMIT } from '@/lib/invoices/peppol-failed-invoices'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

describe('listPeppolFailedInvoiceIds', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('asks the membership-checked SQL function for this company, capped, and returns its ids', async () => {
    enqueue({ data: ['invoice-1', 'invoice-2'] })

    const ids = await listPeppolFailedInvoiceIds({ supabase, companyId: 'company-1' })

    expect(ids).toEqual(['invoice-1', 'invoice-2'])
    expect(mockSupabase.rpc).toHaveBeenCalledWith('peppol_failed_invoice_ids', {
      p_company_id: 'company-1',
      p_limit: PEPPOL_FAILED_INVOICE_LIMIT,
    })
    // Never a table read: peppol_deliveries is not granted to the session.
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })

  it('returns no ids when the function has none', async () => {
    enqueue({ data: null })
    await expect(listPeppolFailedInvoiceIds({ supabase, companyId: 'company-1' })).resolves.toEqual([])
  })

  it('throws when the function fails, so the caller decides how to degrade', async () => {
    enqueue({ error: { message: 'permission denied for function peppol_failed_invoice_ids' } })
    await expect(listPeppolFailedInvoiceIds({ supabase, companyId: 'company-1' })).rejects.toThrow(/permission denied/)
  })
})
