import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { executionBudgetSignal } from '@/lib/http/execution-budget'
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
const logError = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: logError, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))
vi.mock('@/lib/providers/provider-data-fetcher', () => ({
  fetchInvoiceCompletionDetail: vi.fn(), fetchInvoiceCompletionPage: vi.fn(),
  fetchSalesInvoicesDirect: vi.fn(), hydrateSalesInvoices: vi.fn(), fetchCompanyInfoDirect: vi.fn(),
}))
import { FortnoxApiError } from '@/lib/providers/fortnox/client'
import { VismaApiError } from '@/lib/providers/visma/client'
import { BokioApiError } from '@/lib/providers/bokio/client'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { resolveConsent } from '@/lib/providers/resolve-consent'
import { fetchCompanyInfoDirect, fetchInvoiceCompletionDetail, fetchInvoiceCompletionPage } from '@/lib/providers/provider-data-fetcher'
import { completeInvoiceCompletionWork, runInvoiceCompletion, type InvoiceCompletionWork } from '../invoice-completion-worker'
const detail = vi.mocked(fetchInvoiceCompletionDetail)
const page = vi.mocked(fetchInvoiceCompletionPage)
const resolve = vi.mocked(resolveConsent)
const companyInfo = vi.mocked(fetchCompanyInfoDirect)

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
  const state = { blockWins: true, loseReply: false, concurrent: false, discoveryMs: 0, slowCandidates: false, gaveUp: false }
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    let signal: AbortSignal | undefined
    const builder = {
      abortSignal(s: AbortSignal) { signal = s; return builder },
      async then(onFulfilled: (v: unknown) => unknown, onRejected: (e: unknown) => unknown) {
        try {
          let data: unknown
          if (name === 'block_invoice_completion_work') data = state.blockWins
          else if (name === 'enqueue_invoice_completion_work') { vi.setSystemTime(Date.now() + state.discoveryMs); data = 1 }
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
              headerUpdated: !!args.p_header, eventId: args.p_rows && !state.concurrent ? randomUUID() : null,
              ...(state.gaveUp && !args.p_rows ? { gaveUp: true } : {}) }
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
  resolve.mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'synthetic-token', providerCompanyId: 'synthetic-account', credentialRevision: 'request-revision' })
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
  it('counts an invoice the database parked for good after its last try (20261028042247)', async () => {
    const { work, rows } = fixture(); const db = database(rows, work); db.state.gaveUp = true
    detail.mockResolvedValueOnce({ ...invoice('1'), lines: [] })
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000))
      .toMatchObject({ providerEmpty: 1, gaveUp: 1, completed: 1 })
  })
  it('reports a parked invoice as an error, once, with its reason: the count alone reached nobody', async () => {
    const { work, rows } = fixture(); const db = database(rows, work); db.state.gaveUp = true
    detail.mockResolvedValueOnce({ ...invoice('1'), lines: [] })
    logError.mockClear()
    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(logError).toHaveBeenCalledWith('invoice lines given up on: the invoices stay without rows', expect.objectContaining({
      companyId: work.company_id, provider: 'fortnox', count: 1, byReason: { provider_empty: 1 }, invoiceIds: [rows[0].id],
    }))
  })
  it('reports nothing for a run that parked no invoice', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    logError.mockClear()
    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(logError).not.toHaveBeenCalled()
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


describe('Fortnox completion recovery', () => {
  it('records one definitive failure for the revision that failed', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    resolve.mockRejectedValueOnce(new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'expired', {
      providerCode: 'invalid_grant', credentialRevision: 'failed-revision',
    }))
    const result = await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(result).toMatchObject({ companiesBlocked: 1, completed: 0 })
    expect(db.rpc).toHaveBeenCalledWith('block_invoice_completion_work', expect.objectContaining({
      p_consent_id: work.consent_id, p_credential_revision: 'failed-revision', p_reason: 'PROVIDER_AUTH_EXPIRED',
    }))
    expect(detail).not.toHaveBeenCalled()
    expect(page).not.toHaveBeenCalled()
  })

  it.each([[2001103, 'PROVIDER_LICENSE_MISSING'], [2001101, 'PROVIDER_RESOURCE_FORBIDDEN'], [2000663, 'PROVIDER_RESOURCE_FORBIDDEN']])(
    'stops at the first resource failure %s', async (code, reason) => {
      const { work, rows } = fixture(); const db = database(rows, work)
      detail.mockRejectedValueOnce(new FortnoxApiError('denied', 400, JSON.stringify({ ErrorInformation: { code } })))
      expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesBlocked: 1, failed: 0 })
      expect(detail).toHaveBeenCalledOnce()
      expect(db.rpc).toHaveBeenCalledWith('block_invoice_completion_work', expect.objectContaining({
        p_credential_revision: 'request-revision', p_reason: reason,
      }))
    },
  )

  it('keeps a temporary error retryable and preserves a longer provider delay', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    resolve.mockRejectedValueOnce(new ProviderCallError('PROVIDER_RATE_LIMITED', 'fortnox', 'limited', { retryAfterSeconds: 7200 }))
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesBlocked: 0 })
    expect(db.rpc).toHaveBeenCalledWith('release_invoice_completion_work', expect.objectContaining({ p_retry_seconds: 7200 }))
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })

  it('does not impose an obsolete delay when newer credentials won', async () => {
    const { work, rows } = fixture(); const db = database(rows, work); db.state.blockWins = false
    resolve.mockRejectedValueOnce(new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'fortnox', 'expired', {
      providerCode: 'invalid_grant', credentialRevision: 'old-revision',
    }))
    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesBlocked: 0 })
    expect(db.rpc).toHaveBeenCalledWith('release_invoice_completion_work', expect.objectContaining({ p_retry_seconds: 0 }))
  })
})

describe('a provider that refuses the connection outside Fortnox (B11)', () => {
  /** A company whose remaining invoices need the provider listing first. */
  function listingWork(provider: 'visma' | 'bokio' | 'fortnox') {
    const { work, rows } = fixture()
    work.provider = provider
    work.next_page = 1
    rows.forEach(row => { row.source_ref = null as never })
    resolve.mockResolvedValue({ consent: { provider }, accessToken: 'synthetic-token', providerCompanyId: 'synthetic-account', credentialRevision: 'request-revision' })
    return { work, db: database(rows, work) }
  }
  const retrySeconds = (db: ReturnType<typeof database>) =>
    db.rpc.mock.calls.find(([name]) => name === 'release_invoice_completion_work')?.[1]?.p_retry_seconds

  it.each([
    ['visma', new VismaApiError('Visma API error: 403 Forbidden', 403)],
    ['bokio', new BokioApiError('Bokio API error: 403 Forbidden', 403)],
  ] as const)('asks %s again after a day, not every hour, after a 403 refusal', async (provider, refusal) => {
    const { work, db } = listingWork(provider)
    page.mockRejectedValueOnce(refusal)

    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesFailed: 1, companiesBlocked: 0 })
    expect(retrySeconds(db)).toBe(86_400)
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })

  it('asks Bokio again after a day when the plan has no API access, whichever door read it', async () => {
    const { work, db } = listingWork('bokio')
    page.mockRejectedValueOnce(new BokioApiError('Bokio API error: 403 Forbidden', 403, '{"error":"price_plan_feature_required"}'))

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(86_400)
  })

  it('waits a day on a grant the refresh was refused, too', async () => {
    const { work, db } = listingWork('visma')
    resolve.mockRejectedValueOnce(new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'visma', 'refresh refused'))

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(86_400)
  })

  it('keeps the hour for a token that aged out mid-run, which the next run refreshes', async () => {
    const { work, db } = listingWork('visma')
    page.mockRejectedValueOnce(new VismaApiError('Visma API error: 401 Unauthorized', 401))

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(3600)
  })

  it('keeps the hour for a Fortnox token that aged out mid-run, and blocks nothing', async () => {
    const { work, db } = listingWork('fortnox')
    page.mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 401 Unauthorized', 401))

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(3600)
    expect(companyInfo).not.toHaveBeenCalled()
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })
})

describe('an opaque Fortnox 403 is read against the token (#51)', () => {
  /** Fortnox's answer with no documented code, as the reporting company gets it. */
  const opaque = () => new FortnoxApiError('Fortnox API error: 403 Forbidden', 403, 'Du saknar behörighet för GET-anrop mot /3/invoices')
  const retrySeconds = (db: ReturnType<typeof database>) =>
    db.rpc.mock.calls.find(([name]) => name === 'release_invoice_completion_work')?.[1]?.p_retry_seconds

  it('records the block when the token still answers, so the recovery card names the missing permission', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockRejectedValueOnce(opaque())
    companyInfo.mockResolvedValueOnce({ name: 'Synthetic company' } as never)

    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesBlocked: 1, companiesFailed: 1 })
    expect(companyInfo).toHaveBeenCalledWith('fortnox', 'synthetic-token', 'synthetic-account')
    expect(db.rpc).toHaveBeenCalledWith('block_invoice_completion_work', expect.objectContaining({
      p_consent_id: work.consent_id, p_credential_revision: 'request-revision', p_reason: 'PROVIDER_RESOURCE_FORBIDDEN',
    }))
    expect(retrySeconds(db)).toBeUndefined()
  })

  it.each([
    ['no longer answers', () => companyInfo.mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 401 Unauthorized', 401))],
    ['answers nothing', () => companyInfo.mockResolvedValueOnce(null)],
  ])('waits a day, blocking nothing, when the token %s', async (_case, arrange) => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockRejectedValueOnce(opaque())
    arrange()

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(86_400)
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })

  it('asks nothing of the token when no block could be recorded (no credential revision)', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    resolve.mockResolvedValue({ consent: { provider: 'fortnox' }, accessToken: 'synthetic-token', providerCompanyId: 'synthetic-account' } as never)
    detail.mockRejectedValueOnce(opaque())

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(companyInfo).not.toHaveBeenCalled()
    expect(retrySeconds(db)).toBe(86_400)
  })

  it('blocks a documented refusal without asking the token', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockRejectedValueOnce(new FortnoxApiError('denied', 403, JSON.stringify({ ErrorInformation: { code: 2000663 } })))

    expect(await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)).toMatchObject({ companiesBlocked: 1 })
    expect(companyInfo).not.toHaveBeenCalled()
    expect(db.rpc).toHaveBeenCalledWith('block_invoice_completion_work', expect.objectContaining({ p_reason: 'PROVIDER_RESOURCE_FORBIDDEN' }))
  })

  // The same refusal under Fortnox's other status: fortnoxRefusal reads both.
  const under400 = () => new FortnoxApiError('Fortnox API error: 400 Bad Request', 400,
    JSON.stringify({ ErrorInformation: { error: 1, message: 'Saknar behörighet för kundregister.', code: 2001538 } }))

  it('waits a day on a register refused under a 400 too, not an hour, and blocks nothing on undocumented evidence', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    work.next_page = 1
    rows.forEach(row => { row.source_ref = null as never })
    page.mockRejectedValueOnce(under400())

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(86_400)
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })

  it('stops the company on a detail refused under a 400, instead of failing it invoice by invoice', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockRejectedValue(under400())

    const result = await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(result).toMatchObject({ companiesFailed: 1, failed: 0 })
    expect(detail).toHaveBeenCalledTimes(1)
    expect(retrySeconds(db)).toBe(86_400)
    detail.mockReset()
  })

  it('keeps a rate limit retryable with its Retry-After, asking nothing of the token', async () => {
    const { work, rows } = fixture(); const db = database(rows, work)
    detail.mockRejectedValueOnce(new FortnoxApiError('Fortnox API error: 429 Too Many Requests', 429, undefined, 7_200_000))

    await completeInvoiceCompletionWork(db.supabase, work, Date.now() + 120_000)
    expect(retrySeconds(db)).toBe(7200)
    expect(companyInfo).not.toHaveBeenCalled()
    expect(db.rpc.mock.calls.some(([name]) => name === 'block_invoice_completion_work')).toBe(false)
  })
})
