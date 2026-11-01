import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { invoiceHasActiveCreditNote } from '../active-credit-note'

describe('invoiceHasActiveCreditNote', () => {
  it('asks for the credit notes of this invoice in this company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ status: 'cancelled', creation_complete: true }, { status: 'draft', creation_complete: true }] })

    expect(await invoiceHasActiveCreditNote(supabase as unknown as SupabaseClient, 'company-1', 'inv-1')).toBe(true)
    expect(findCalls('invoices', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['credited_invoice_id', 'inv-1'],
    ])
  })

  it('counts a draft, and neither a cancelled one nor one that was never finished', async () => {
    const answer = async (rows: Array<{ status: string; creation_complete?: boolean }>) => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: rows })
      return invoiceHasActiveCreditNote(supabase as unknown as SupabaseClient, 'company-1', 'inv-1')
    }
    expect(await answer([{ status: 'draft', creation_complete: true }])).toBe(true)
    expect(await answer([{ status: 'cancelled', creation_complete: true }])).toBe(false)
    expect(await answer([{ status: 'draft', creation_complete: false }])).toBe(false)
  })

  it('answers false without one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] })
    expect(await invoiceHasActiveCreditNote(supabase as unknown as SupabaseClient, 'company-1', 'inv-1')).toBe(false)
  })

  it('throws on a failed read: an unread credit note is not an absent one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout', code: '57014' } })
    await expect(invoiceHasActiveCreditNote(supabase as unknown as SupabaseClient, 'company-1', 'inv-1')).rejects.toMatchObject({ code: '57014' })
  })
})
