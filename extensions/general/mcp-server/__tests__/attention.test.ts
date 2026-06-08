import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { attentionResource } from '../resources/attention'

type AttentionResponse = {
  generated_at: string
  summary: { total_items: number; critical: number; warning: number; info: number }
  categories: Array<{
    key: string
    severity: 'critical' | 'warning' | 'info'
    count: number
    samples: Array<Record<string, unknown>>
    next?: { description: string; tool?: string; args?: Record<string, unknown>; resource?: string }
  }>
}

const ctx = (supabase: ReturnType<typeof createQueuedMockSupabase>['supabase']) => ({
  supabase: supabase as never,
  companyId: 'company-1',
  userId: 'user-1',
  scopes: [],
})

/**
 * Enqueues 14 baseline empty results in the order the resource consumes them.
 * Tests can override individual slots before invoking by enqueueing in advance.
 */
function enqueueEmpty(enqueue: (r: { data?: unknown; error?: unknown; count?: number | null }) => void) {
  // 1. unbookedHead
  enqueue({ count: 0 })
  // 2. unbookedSamples
  enqueue({ data: [] })
  // 3. overdueRows
  enqueue({ data: [] })
  // 4. pendingSupplierHead
  enqueue({ count: 0 })
  // 5. pendingSupplierSamples
  enqueue({ data: [] })
  // 6. pendingOpsHead
  enqueue({ count: 0 })
  // 7. pendingOpsSamples
  enqueue({ data: [] })
  // 8. unmatchedReceiptsHead
  enqueue({ count: 0 })
  // 9. unmatchedReceiptsSamples
  enqueue({ data: [] })
  // 10. voucherSeriesRows
  enqueue({ data: [] })
  // 11. deadlineRows
  enqueue({ data: [] })
  // 12. bankConnRows
  enqueue({ data: [] })
  // 13. activePeriodRow
  enqueue({ data: null })
  // 14. companySettingsRow
  enqueue({ data: null })
}

describe('Accounted://attention', () => {
  it('returns empty summary for a brand-new company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueEmpty(enqueue)

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse

    expect(result.generated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(result.summary).toEqual({ total_items: 0, critical: 0, warning: 0, info: 0 })
    expect(result.categories).toEqual([])
  })

  it('classifies recently-unbooked transactions as warning', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const today = new Date().toISOString().slice(0, 10)
    const txns = [
      { id: 't-1', date: today, amount: -100, currency: 'SEK', description: 'Lunch', merchant_name: 'Café' },
      { id: 't-2', date: today, amount: -200, currency: 'SEK', description: 'Office', merchant_name: 'Clas Ohlson' },
    ]

    enqueue({ count: 2 })            // unbookedHead
    enqueue({ data: txns })          // unbookedSamples
    enqueue({ data: [] })            // overdueRows
    enqueue({ count: 0 })            // pendingSupplierHead
    enqueue({ data: [] })            // pendingSupplierSamples
    enqueue({ count: 0 })            // pendingOpsHead
    enqueue({ data: [] })            // pendingOpsSamples
    enqueue({ count: 0 })            // unmatchedReceiptsHead
    enqueue({ data: [] })            // unmatchedReceiptsSamples
    enqueue({ data: [] })            // voucherSeriesRows
    enqueue({ data: [] })            // deadlineRows
    enqueue({ data: [] })            // bankConnRows
    enqueue({ data: null })          // activePeriodRow
    enqueue({ data: null })          // companySettingsRow

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse

    expect(result.categories).toHaveLength(1)
    const cat = result.categories[0]
    expect(cat.key).toBe('unbooked_transactions')
    expect(cat.severity).toBe('warning')
    expect(cat.count).toBe(2)
    expect(cat.samples).toEqual(txns)
    expect(cat.next?.tool).toBe('gnubok_categorize_transaction')
    expect(cat.next?.args).toEqual({ transaction_id: 't-1' })
    expect(result.summary).toEqual({ total_items: 2, critical: 0, warning: 1, info: 0 })
  })

  it('escalates unbooked transactions to critical when oldest is > 30 days old', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
    const txns = [{ id: 't-old', date: fortyDaysAgo, amount: -100, currency: 'SEK', description: 'X', merchant_name: null }]

    enqueue({ count: 1 })
    enqueue({ data: txns })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    expect(result.categories[0]?.severity).toBe('critical')
    expect(result.summary.critical).toBe(1)
  })

  it('flags overdue invoices as critical when any are > 30 days past due', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const fortyDaysAgo = new Date(Date.now() - 40 * 86_400_000).toISOString().slice(0, 10)
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10)
    const overdue = [
      { id: 'i-1', invoice_number: 'F-2024001', customer_id: 'c-1', due_date: fortyDaysAgo, total: 1000, currency: 'SEK', status: 'overdue' },
      { id: 'i-2', invoice_number: 'F-2024002', customer_id: 'c-1', due_date: tenDaysAgo, total: 500, currency: 'SEK', status: 'sent' },
    ]

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: overdue })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'overdue_invoices')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(2)
  })

  it('marks pending operations as critical when any high-risk op is queued', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const ops = [
      { id: 'op-1', operation_type: 'close_period', title: 'Stäng FY2025', risk_level: 'high', actor_label: 'Claude', created_at: new Date().toISOString() },
      { id: 'op-2', operation_type: 'create_customer', title: 'Ny kund', risk_level: 'low', actor_label: 'Claude', created_at: new Date().toISOString() },
    ]

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 2 })
    enqueue({ data: ops })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'pending_operations')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(2)
    expect(result.summary.critical).toBe(1)
  })

  it('flags voucher gaps as critical and includes next tool args', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const seriesRows = [{ voucher_series: 'A', fiscal_period_id: 'fp-1' }]

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: seriesRows })             // voucherSeriesRows
    enqueue({ data: [] })                     // deadlineRows
    enqueue({ data: [] })                     // bankConnRows
    enqueue({ data: null })                   // activePeriodRow
    enqueue({ data: null })                   // companySettingsRow
    // Loop body for series 'A':
    enqueue({ data: [{ gap_start: 5, gap_end: 7 }] })  // detect_voucher_gaps RPC
    enqueue({ data: [] })                     // voucher_gap_explanations follow-up

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'voucher_gaps_unexplained')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(1)
    expect(cat?.next?.tool).toBe('gnubok_explain_voucher_gap')
    expect(cat?.next?.args).toEqual({
      fiscal_period_id: 'fp-1',
      voucher_series: 'A',
      gap_start: 5,
      gap_end: 7,
    })
  })

  it('omits voucher_gaps category when all gaps are explained', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const seriesRows = [{ voucher_series: 'A', fiscal_period_id: 'fp-1' }]

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: seriesRows })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [{ gap_start: 5, gap_end: 7 }] })
    enqueue({
      data: [{ voucher_series: 'A', gap_start: 5, gap_end: 7, fiscal_period_id: 'fp-1' }],
    })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    expect(result.categories.find((c) => c.key === 'voucher_gaps_unexplained')).toBeUndefined()
  })

  it('flags expired bank consent as critical', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const banks = [
      { id: 'bc-1', bank_name: 'SEB', status: 'active', consent_expires: yesterday },
    ]

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: banks })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'bank_consent_expiring')
    expect(cat?.severity).toBe('critical')
    expect(cat?.count).toBe(1)
  })

  it('classifies upcoming lock as info severity', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const inSevenDays = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)

    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: { id: 'fp-1', name: 'FY2026', period_start: '2026-01-01', period_end: '2026-12-31', locked_at: null, is_closed: false } })
    enqueue({ data: { bookkeeping_locked_through: inSevenDays, auto_lock_period_days: null } })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    const cat = result.categories.find((c) => c.key === 'period_lock_approaching')
    expect(cat?.severity).toBe('info')
    expect(result.summary.info).toBe(1)
  })

  it('combines multiple categories into a coherent summary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    const today = new Date().toISOString().slice(0, 10)

    enqueue({ count: 1 })                                                  // unbookedHead
    enqueue({ data: [{ id: 't-1', date: today, amount: -50, currency: 'SEK', description: 'X', merchant_name: null }] })
    enqueue({ data: [] })                                                  // overdueRows
    enqueue({ count: 1 })                                                  // pendingSupplierHead
    enqueue({ data: [{ id: 'si-1', supplier_invoice_number: 'L-1', supplier_id: 's-1', total: 1000, currency: 'SEK', due_date: today }] })
    enqueue({ count: 0 })                                                  // pendingOpsHead
    enqueue({ data: [] })
    enqueue({ count: 0 })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'd-1', title: 'Moms Q1', due_date: today, deadline_type: 'tax', tax_deadline_type: 'vat', status: 'upcoming' }] })
    enqueue({ data: [] })
    enqueue({ data: null })
    enqueue({ data: null })

    const result = (await attentionResource.read(ctx(supabase))) as AttentionResponse
    expect(result.categories).toHaveLength(3)
    expect(new Set(result.categories.map((c) => c.key))).toEqual(
      new Set(['unbooked_transactions', 'pending_supplier_invoices', 'deadlines_upcoming'])
    )
    expect(result.summary.total_items).toBe(3)
  })
})
