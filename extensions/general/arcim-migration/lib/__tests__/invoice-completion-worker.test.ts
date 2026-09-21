import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { executionBudgetSignal } from '@/lib/http/execution-budget'
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchInvoiceCompletionDetail: vi.fn(), fetchInvoiceCompletionPage: vi.fn(),
  fetchSalesInvoicesDirect: vi.fn(), hydrateSalesInvoices: vi.fn(),
}))
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchInvoiceCompletionDetail, fetchInvoiceCompletionPage } from '@/lib/providers/provider-data-fetcher'
import { completeInvoiceCompletionWork, runInvoiceCompletion, type InvoiceCompletionWork } from '../invoice-completion-worker'
const detail = vi.mocked(fetchInvoiceCompletionDetail)
const page = vi.mocked(fetchInvoiceCompletionPage)
const resolve = vi.mocked(resolveConsent)

function fixture() {
  const work: InvoiceCompletionWork = { company_id: randomUUID(), consent_id: randomUUID(), provider: 'fortnox',
    account_key: 'synthetic-account', scan_id: randomUUID(), worker_id: randomUUID(), next_page: null, part: 'invoices' }
  const rows = [1, 2].map(n => ({ id: randomUUID(), user_id: randomUUID(), customer_id: randomUUID(),
    invoice_number: String(n), invoice_date: '2026-09-01', total: 1250, subtotal: 1250, vat_amount: 0,
    vat_rate: null, vat_treatment: 'standard_25', currency: 'SEK', exchange_rate: null, ambiguous: false,
    source_ref: { id: String(n), detailId: String(n), invoiceNumber: String(n), issueDate: '2026-09-01', creditNote: false },
  }))
  return { work, rows }
}
function invoice(id: string): SalesInvoiceDto {
  const amount = (value: number) => ({ value, currencyCode: 'SEK' })
  return { id, invoiceNumber: id, issueDate: '2026-09-01', currencyCode: 'SEK', status: 'paid',
    supplier: { name: 'Synthetic supplier', identifications: [] }, customer: { name: 'Synthetic customer', identifications: [] },
    lines: [{ id: '1', description: 'Synthetic line', quantity: 1, unitCode: 'st', unitPrice: amount(1000),
      lineExtensionAmount: amount(1000), taxPercent: 25 }],
    taxTotal: { taxAmount: amount(250) }, legalMonetaryTotal: { lineExtensionAmount: amount(1000), taxInclusiveAmount: amount(1250), payableAmount: amount(1250) },
    paymentStatus: { paid: true, balance: amount(0) },
  }
}
/** Simulates transport that actually rejects when its signal is aborted. */
function untilAborted<T>(): Promise<T> {
  const signal = executionBudgetSignal()!
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
}
function database(rows: ReturnType<typeof fixture>['rows'], work: InvoiceCompletionWork) {
  const receipts = new Map<string, { status: string; headerUpdated: boolean; eventId: string | null }>()
  const state = { loseReply: false, concurrent: false, discoveryMs: 0, slowCandidates: false }
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    let signal: AbortSignal | undefined
    const builder = {
      abortSignal(s: AbortSignal) { signal = s; return builder },
      async then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
        try {
          let data: unknown
          if (name === 'enqueue_invoice_completion_work') { vi.setSystemTime(Date.now() + state.discoveryMs); data = 1 }
          else if (name === 'claim_invoice_completion_work') data = (args.p_exclude as string[]).length ? null : work
          else if (name === 'load_invoice_completion_candidates') {
            if (state.slowCandidates) data = await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
            else data = args.p_mapped_only ? [] : rows.filter(r => !receipts.has(r.id))
          } else if (name === 'save_invoice_completion_page') {
            work.next_page = args.p_next_page as number | null
            work.part = args.p_next_part as 'invoices' | 'creditNotes'
            data = null
          } else if (name === 'finish_invoice_completion') {
            const id = args.p_invoice_id as string
            const receipt = { status: state.concurrent ? 'already_filled' : args.p_outcome as string,
              headerUpdated: !!args.p_header, eventId: args.p_rows && !state.concurrent ? randomUUID() : null }
            receipts.set(id, receipt)
            if (state.loseReply) {
              state.loseReply = false
              data = await new Promise((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
            } else data = receipt
          }
          return onFulfilled({ data, error: null })
        } catch (error) { return onRejected(error) }
      },
    }
    return builder
  })
  const from = vi.fn(() => {
    const builder: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'in', 'abortSignal']) builder[method] = () => builder
    builder.then = (resolve: (v: unknown) => unknown) => resolve({ data: [...receipts].map(([invoice_id, receipt]) => ({ invoice_id, receipt })), error: null })
    return builder
  })
  return { supabase: { rpc, from } as unknown as SupabaseClient, receipts, state, rpc }
}
beforeEach(() => {
  vi.resetAllMocks(); vi.useFakeTimers()
  resolve.mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'synthetic-token', providerCompanyId: 'synthetic-account' })
  detail.mockImplementation(async (_provider, _token, _company, source) => invoice(source.id))
  page.mockResolvedValue({ sources: [], nextPage: null, nextPart: 'invoices' })
})
afterEach(() => vi.useRealTimers())

describe('resumable invoice completion', () => {
  it('includes initial company discovery in the invocation budget', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    db.state.discoveryMs = 240_000
    const result = await runInvoiceCompletion(db.supabase, Date.now() + 240_000)
    expect(db.rpc.mock.calls.map(c => c[0])).toEqual(['enqueue_invoice_completion_work'])
    expect(resolve).not.toHaveBeenCalled()
    expect(result.budgetReachedAt).not.toBeNull()
  })
  it('aborts a slow candidate query before contacting a provider', async () => {
    const { work, rows } = fixture(); const db = database(rows, work); db.state.slowCandidates = true
    const run = completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(8000)
    expect((await run).budgetReachedAt).toBe('candidate-selection')
    expect(resolve).not.toHaveBeenCalled()
  })
  it('preserves the first completion when the next detail request exhausts the budget', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockResolvedValueOnce(invoice('1')).mockImplementationOnce(() => untilAborted())
    const run = completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(105_000)
    const result = await run
    expect(result).toMatchObject({ completed: 1, historyAppended: 1, deferred: 1, failed: 0, budgetReachedAt: 'invoice-detail' })
    expect(db.receipts.size).toBe(1)
    const resumed = await completeInvoiceCompletionWork(db.supabase, { ...work, worker_id: randomUUID() }, Date.now() + 120_000)
    expect(resumed.completed).toBe(1)
    expect(db.receipts.size).toBe(2)
  })
  it('recovers a committed receipt when the persistence response is lost', async () => {
    const { work, rows } = fixture(); const db = database(rows.slice(0, 1), work); db.state.loseReply = true
    const run = completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(8000)
    expect(await run).toMatchObject({ completed: 1, historyAppended: 1, uncertain: 0, failed: 0 })
    expect(db.rpc.mock.calls.filter(c => c[0] === 'finish_invoice_completion')).toHaveLength(1)
  })
  it('resumes at the saved provider page and never matches an unfinished scan', async () => {
    const { work, rows } = fixture(); work.next_page = 1
    const db = database(rows.slice(0, 1), work)
    page.mockResolvedValueOnce({ sources: [rows[0].source_ref], nextPage: 2, nextPart: 'invoices' })
      .mockImplementationOnce(() => untilAborted())
    const run = completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    await vi.advanceTimersByTimeAsync(105_000)
    expect(await run).toMatchObject({ pages: 1, completed: 0, budgetReachedAt: 'provider-listing' })
    expect(work.next_page).toBe(2)
    expect(detail).not.toHaveBeenCalled()
    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(page.mock.calls.map(c => c[4])).toEqual([1, 2, 2])
    expect(db.receipts.size).toBe(1)
  })
  it('records empty provider lines with a retry outcome and proceeds to another invoice', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockResolvedValueOnce({ ...invoice('1'), lines: [] })
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000))
      .toMatchObject({ providerEmpty: 1, completed: 1, failed: 0 })
    expect(db.receipts.get(rows[0].id)?.status).toBe('provider_empty')
  })
  it('reports a concurrent winner without counting it as this run\'s completion', async () => {
    const { work, rows } = fixture(); const db = database(rows.slice(0, 1), work); db.state.concurrent = true
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000))
      .toMatchObject({ completed: 0, alreadyCompleted: 1, historyAppended: 0 })
  })
  it('rejects a source identity whose detail no longer matches number and date', async () => {
    const { work, rows } = fixture(); const db = database(rows.slice(0, 1), work)
    detail.mockResolvedValueOnce({ ...invoice('1'), issueDate: '2025-09-01' })
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000))
      .toMatchObject({ completed: 0, unmatched: 1 })
    expect(db.rpc.mock.calls.find(c => c[0] === 'finish_invoice_completion')?.[1].p_rows).toBeUndefined()
  })
})
