import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockLoggerWarn } = vi.hoisted(() => ({ mockLoggerWarn: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}))

import { clearSettledInvoiceSuggestions } from '../clear-settled-invoice-suggestions'

const COMPANY = 'company-1'
const SI_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const TX_ID = '33333333-3333-4333-8333-333333333333'

const { supabase, enqueue, reset, findCall, findCalls, calls } = createQueuedMockSupabase()

describe('clearSettledInvoiceSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('nulls potential_supplier_invoice_id on every OTHER transaction of the company', async () => {
    enqueue({ data: null, error: null })
    await clearSettledInvoiceSuggestions(
      supabase as unknown as SupabaseClient,
      COMPANY,
      'supplier_invoice',
      SI_ID,
      { exceptTransactionId: TX_ID },
    )

    expect(supabase.from).toHaveBeenCalledWith('transactions')
    expect(findCall('transactions', 'update')).toEqual([
      { potential_supplier_invoice_id: null },
    ])
    const eqCalls = findCalls('transactions', 'eq')
    expect(eqCalls).toEqual([
      ['company_id', COMPANY],
      ['potential_supplier_invoice_id', SI_ID],
    ])
    expect(findCall('transactions', 'neq')).toEqual(['id', TX_ID])
  })

  it('nulls only potential_invoice_id for kind invoice', async () => {
    enqueue({ data: null, error: null })
    await clearSettledInvoiceSuggestions(
      supabase as unknown as SupabaseClient,
      COMPANY,
      'invoice',
      INV_ID,
    )

    const payload = findCall('transactions', 'update')?.[0] as Record<string, unknown>
    expect(Object.keys(payload)).toEqual(['potential_invoice_id'])
    expect(payload.potential_invoice_id).toBeNull()
    expect(findCalls('transactions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['potential_invoice_id', INV_ID],
    ])
  })

  it('omits the neq filter when no exceptTransactionId is given', async () => {
    enqueue({ data: null, error: null })
    await clearSettledInvoiceSuggestions(
      supabase as unknown as SupabaseClient,
      COMPANY,
      'invoice',
      INV_ID,
    )
    expect(findCalls('transactions', 'neq')).toEqual([])

    reset()
    enqueue({ data: null, error: null })
    await clearSettledInvoiceSuggestions(
      supabase as unknown as SupabaseClient,
      COMPANY,
      'invoice',
      INV_ID,
      { exceptTransactionId: null },
    )
    expect(findCalls('transactions', 'neq')).toEqual([])
  })

  it('never widens the write beyond the settled invoice own pointer', async () => {
    enqueue({ data: null, error: null })
    await clearSettledInvoiceSuggestions(
      supabase as unknown as SupabaseClient,
      COMPANY,
      'supplier_invoice',
      SI_ID,
      { exceptTransactionId: TX_ID },
    )
    const methods = calls.map((c) => c.method)
    expect(methods).not.toContain('or')
    expect(methods).not.toContain('is')
    expect(methods).not.toContain('in')
    // Only one table is ever touched.
    expect([...new Set(calls.map((c) => c.table))]).toEqual(['transactions'])
  })

  it('logs and resolves when the update fails: a settle must never fail on cleanup', async () => {
    enqueue({ data: null, error: { message: 'permission denied' } })
    await expect(
      clearSettledInvoiceSuggestions(
        supabase as unknown as SupabaseClient,
        COMPANY,
        'supplier_invoice',
        SI_ID,
      ),
    ).resolves.toBeUndefined()
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'failed to clear settled invoice suggestions',
      expect.objectContaining({ companyId: COMPANY, invoiceId: SI_ID, reason: 'permission denied' }),
    )
  })
})
