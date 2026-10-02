import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { findCashMethodUnbookedAllocations } from '../batch-cash-method-guard'

const INV_BOOKED = '11111111-1111-4111-8111-111111111111'
const INV_UNBOOKED = '22222222-2222-4222-8222-222222222222'
const SI_UNBOOKED = '33333333-3333-4333-8333-333333333333'
const SI_BOOKED = '44444444-4444-4444-8444-444444444444'

describe('findCashMethodUnbookedAllocations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns nothing under faktureringsmetoden without reading invoices', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_UNBOOKED },
    ])

    expect(result).toEqual({ ok: true, unbooked: [] })
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('company_settings')
  })

  it('treats a missing settings row as accrual (the historical default)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_UNBOOKED },
    ])

    expect(result).toEqual({ ok: true, unbooked: [] })
  })

  it('flags only the customer invoices with no booking under kontantmetoden', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { accounting_method: 'cash' }, error: null })
    enqueue({
      data: [
        // Booked at issue before a switch to kontantmetoden: 1510 holds a
        // receivable, so the clearing entry is still correct.
        { id: INV_BOOKED, invoice_number: '100', journal_entry_id: 'je-issue' },
        { id: INV_UNBOOKED, invoice_number: '231', journal_entry_id: null },
      ],
      error: null,
    })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_BOOKED },
      { kind: 'customer_invoice', invoice_id: INV_UNBOOKED },
    ])

    expect(result).toEqual({
      ok: true,
      unbooked: [{ kind: 'customer_invoice', id: INV_UNBOOKED, invoice_number: '231' }],
    })
    expect(supabase.from).toHaveBeenCalledWith('invoices')
  })

  it('flags supplier invoices with no registration voucher under kontantmetoden', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { accounting_method: 'cash' }, error: null })
    enqueue({
      data: [
        { id: SI_UNBOOKED, supplier_invoice_number: 'F-9', registration_journal_entry_id: null },
        { id: SI_BOOKED, supplier_invoice_number: 'F-10', registration_journal_entry_id: 'je-reg' },
      ],
      error: null,
    })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'supplier_invoice', supplier_invoice_id: SI_UNBOOKED },
      { kind: 'supplier_invoice', supplier_invoice_id: SI_BOOKED },
    ])

    expect(result).toEqual({
      ok: true,
      unbooked: [{ kind: 'supplier_invoice', id: SI_UNBOOKED, invoice_number: 'F-9' }],
    })
    expect(supabase.from).toHaveBeenCalledWith('supplier_invoices')
  })

  it('surfaces a settings lookup error so callers fail closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const err = { message: 'boom', code: '08006' }
    enqueue({ data: null, error: err })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_UNBOOKED },
    ])

    expect(result).toEqual({ ok: false, error: err })
  })

  it('surfaces an invoice lookup error so callers fail closed', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const err = { message: 'boom', code: '08006' }
    enqueue({ data: { accounting_method: 'cash' }, error: null })
    enqueue({ data: null, error: err })

    const result = await findCashMethodUnbookedAllocations(supabase as never, 'company-1', [
      { kind: 'customer_invoice', invoice_id: INV_UNBOOKED },
    ])

    expect(result).toEqual({ ok: false, error: err })
  })
})
