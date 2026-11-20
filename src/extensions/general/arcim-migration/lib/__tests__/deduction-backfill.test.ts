import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import type { ResolvedConsent } from '@/lib/providers/resolve-consent'
import type { MigratedDeductionApplyOutcome } from '@/lib/invoices/migrated-deduction-apply'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { VismaApiError } from '@/lib/providers/visma/client'
import { eventBus } from '@/lib/events/bus'
import { createTableMockSupabase } from '@/tests/helpers'
import { runDeductionBackfill, type DeductionBackfillDeps } from '../deduction-backfill'

const NOW = new Date('2026-10-14T10:00:00Z')
const TODAY = '2026-10-14'
const ACCOUNT_KEY = '5566778899'
// A Luhn-valid test personnummer.
const BUYER = '19121212-1212'

interface Fixture {
  invoiceId: string
  sourceId: string
  number: string
  status?: string
  paid?: number
  deductionTotal?: number
  /** The provider's deduction; null: the invoice carries none. */
  deduction?: SalesInvoiceDto['householdDeduction'] | null
}

// A: buyer paid nothing, RUT 3 750 open at Visma: apply, status unchanged.
// B: no deduction, part paid at sent: the status repair only.
// C: no deduction, nothing paid: skip.
// D: buyer paid 1 000 of their 6 250, RUT 3 750 open: apply, partially_paid.
const A: Fixture = { invoiceId: 'inv-A', sourceId: 'visma-A', number: '1001' }
const B: Fixture = { invoiceId: 'inv-B', sourceId: 'visma-B', number: '1002', paid: 1000, deduction: null }
const C: Fixture = { invoiceId: 'inv-C', sourceId: 'visma-C', number: '1003', deduction: null }
const D: Fixture = { invoiceId: 'inv-D', sourceId: 'visma-D', number: '1004', paid: 1000 }
const ALL = [A, B, C, D]

const RUT_OPEN = { kind: 'rut' as const, amount: 3750, buyers: [{ personnummer: BUYER, amount: 3750 }], providerState: 'open' as const }

function invoiceRow(f: Fixture) {
  return {
    id: f.invoiceId,
    invoice_number: f.number,
    invoice_date: '2026-08-28',
    status: f.status ?? 'sent',
    currency: 'SEK',
    total: '10000.00',
    paid_amount: String(f.paid ?? 0),
    deduction_total: f.deductionTotal ?? null,
  }
}

// 6 000 + 1 500 moms of cleaning, 2 000 + 500 moms of material.
function itemRows(f: Fixture) {
  const deductionType = (f.deductionTotal ?? 0) > 0 ? 'rut' : null
  return [
    { id: `${f.invoiceId}-work`, invoice_id: f.invoiceId, sort_order: 1, line_type: 'product', quantity: '12', unit: 'tim', line_total: '6000', vat_amount: '1500', deduction_type: deductionType },
    { id: `${f.invoiceId}-mat`, invoice_id: f.invoiceId, sort_order: 2, line_type: 'product', quantity: '1', unit: 'st', line_total: '2000', vat_amount: '500', deduction_type: null },
  ]
}

function detail(f: Fixture): SalesInvoiceDto {
  const paid = f.paid ?? 0
  return {
    id: f.sourceId,
    invoiceNumber: f.number,
    issueDate: '2026-08-28',
    currencyCode: 'SEK',
    status: 'sent',
    supplier: { name: '', identifications: [] },
    customer: { name: 'Privatkund', identifications: [] },
    lines: [
      { id: '1', lineExtensionAmount: { value: 6000, currencyCode: 'SEK' }, householdWork: { workType: 'STAD', providerWorkType: '9', hours: 12 } },
      { id: '2', lineExtensionAmount: { value: 2000, currencyCode: 'SEK' } },
    ],
    legalMonetaryTotal: { payableAmount: { value: 10000, currencyCode: 'SEK' } },
    paymentStatus: { paid: false, balance: { value: 10000 - paid, currencyCode: 'SEK' }, source: 'enum' },
    householdDeduction: f.deduction === null ? undefined : (f.deduction ?? RUT_OPEN),
  }
}

const CONNECTION: ResolvedConsent = {
  consent: { org_number: '556677-8899' },
  accessToken: 'token',
  providerCompanyId: 'visma-company',
}

const mock = createTableMockSupabase()
const supabase = mock.supabase as unknown as SupabaseClient
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const ctx = { supabase, companyId: 'company-1', userId: 'user-1', log: log as unknown as Logger }

const OK_APPLY: MigratedDeductionApplyOutcome = { ok: true, applied: true, status: 'sent', remainingAmount: 6250, journalEntryId: 'je-1' }
const OK_STATUS: MigratedDeductionApplyOutcome = { ok: true, applied: true, status: 'partially_paid', remainingAmount: 9000, journalEntryId: null }

function seed(opts: {
  fixtures?: Fixture[]
  sources?: Array<{ source_id: string; target_id: string; account_key: string }>
  jobs?: unknown[]
  consents?: Array<{ id: string }>
  vouchers?: Array<{ id: string; source_id: string }>
  /** Preview's second invoices read: invoices applied earlier and no longer open. */
  appliedRows?: unknown[]
} = {}) {
  const fixtures = opts.fixtures ?? ALL
  mock.setTable('migration_source_records', {
    data: opts.sources ?? fixtures.map((f) => ({ source_id: f.sourceId, target_id: f.invoiceId, account_key: ACCOUNT_KEY })),
  })
  mock.setTable('migration_jobs', { data: opts.jobs ?? [] })
  mock.setTable('provider_consents', { data: opts.consents ?? [{ id: 'consent-1' }] })
  const open = fixtures.filter((f) => (f.status ?? 'sent') !== 'paid')
  mock.setTable('invoices', [{ data: open.map(invoiceRow) }, { data: opts.appliedRows ?? [] }])
  mock.setTable('journal_entries', { data: opts.vouchers ?? [] })
  mock.setTable('invoice_items', { data: fixtures.flatMap(itemRows) })
  mock.setTable('invoice_payments', { data: [] })
}

function makeDeps(overrides: Partial<DeductionBackfillDeps> = {}, fixtures: Fixture[] = ALL) {
  const bySource = new Map(fixtures.map((f) => [f.sourceId, f]))
  const deps = {
    resolveConsent: vi.fn<DeductionBackfillDeps['resolveConsent']>(async () => CONNECTION),
    fetchDetail: vi.fn<DeductionBackfillDeps['fetchDetail']>(async (_connection, source) => {
      const f = bySource.get(source.id)
      return f ? detail(f) : null
    }),
    applyDeduction: vi.fn<DeductionBackfillDeps['applyDeduction']>(async () => OK_APPLY),
    repairStatus: vi.fn<DeductionBackfillDeps['repairStatus']>(async () => OK_STATUS),
    ensureAccounts: vi.fn<DeductionBackfillDeps['ensureAccounts']>(async () => true),
    now: () => NOW,
  }
  return Object.assign(deps, overrides) as typeof deps
}

const run = (mode: 'preview' | 'apply', deps: DeductionBackfillDeps) =>
  runDeductionBackfill(ctx, { mode, budgetMs: 60_000 }, deps)

function report(result: Awaited<ReturnType<typeof runDeductionBackfill>>) {
  if (!result.ok) throw new Error(`expected a report, got ${result.code}`)
  return result.report
}

/** Every write the run made through the client. */
function writes() {
  return mock.calls.filter((c) => ['insert', 'update', 'upsert', 'delete'].includes(c.method))
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mock.reset()
})

describe('runDeductionBackfill: refused up front', () => {
  it('NOT_APPLICABLE without Visma source records', async () => {
    seed({ sources: [] })
    const deps = makeDeps()

    expect(await run('preview', deps)).toEqual({ ok: false, code: 'NOT_APPLICABLE' })
    expect(mock.tables()).toEqual(['migration_source_records'])
    expect(deps.resolveConsent).not.toHaveBeenCalled()
  })

  it('IMPORT_RUNNING while a migration job is active', async () => {
    seed({ jobs: [{ id: 'job-1' }] })
    const deps = makeDeps()

    expect(await run('apply', deps)).toEqual({ ok: false, code: 'IMPORT_RUNNING' })
    expect(mock.findCall('migration_jobs', 'in')).toEqual(['state', ['queued', 'running', 'retry_wait']])
    expect(mock.tables()).not.toContain('provider_consents')
    expect(deps.resolveConsent).not.toHaveBeenCalled()
  })

  it('RECONNECT_REQUIRED without a Visma consent', async () => {
    seed({ consents: [] })
    const deps = makeDeps()

    expect(await run('preview', deps)).toEqual({ ok: false, code: 'RECONNECT_REQUIRED' })
    expect(deps.resolveConsent).not.toHaveBeenCalled()
    expect(deps.fetchDetail).not.toHaveBeenCalled()
  })

  it('RECONNECT_REQUIRED when the only consent has expired', async () => {
    seed()
    const deps = makeDeps({
      resolveConsent: vi.fn(async () => {
        throw new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'visma', 'token expired')
      }),
    })

    expect(await run('preview', deps)).toEqual({ ok: false, code: 'RECONNECT_REQUIRED' })
    expect(deps.resolveConsent).toHaveBeenCalledWith('company-1', 'consent-1')
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { consentId: 'consent-1', code: 'PROVIDER_AUTH_EXPIRED' })
    expect(deps.fetchDetail).not.toHaveBeenCalled()
  })

  it('DIFFERENT_COMPANY when the consent reaches another Visma company', async () => {
    seed()
    const deps = makeDeps({
      resolveConsent: vi.fn(async () => ({ ...CONNECTION, consent: { org_number: '559999-0000' } })),
    })

    expect(await run('preview', deps)).toEqual({ ok: false, code: 'DIFFERENT_COMPANY' })
    expect(deps.fetchDetail).not.toHaveBeenCalled()
  })

  it('uses the consent that reaches the migrated company when several exist', async () => {
    seed({ consents: [{ id: 'consent-other' }, { id: 'consent-1' }] })
    const deps = makeDeps({
      resolveConsent: vi.fn(async (_companyId: string, consentId: string) =>
        consentId === 'consent-1' ? CONNECTION : { ...CONNECTION, consent: { org_number: '559999-0000' } },
      ),
    })

    const result = report(await run('apply', deps))

    expect(result.applied.invoices).toBe(2)
    expect(deps.applyDeduction.mock.calls[0][4].trail).toMatchObject({ provider: 'visma', consentId: 'consent-1' })
  })
})

describe('runDeductionBackfill: preview', () => {
  it('fills the buckets and writes nothing', async () => {
    seed()
    const deps = makeDeps()

    const result = report(await run('preview', deps))

    expect(result).toMatchObject({ mode: 'preview', complete: true, stopReason: null, candidates: 4, processed: 4 })
    expect(result.buckets).toEqual({
      apply_unpaid: { count: 1, amount: 3750 },
      apply_partially_paid: { count: 1, amount: 3750 },
      apply_paid: { count: 0, amount: 0 },
      status_only: { count: 1, amount: 0 },
      review: { count: 0, amount: 0 },
      double_request: { count: 0, amount: 0 },
    })
    expect(result.skipped).toEqual({ no_deduction: 1 })
    expect(result.applied).toEqual({ invoices: 0, amount: 0, statusRepaired: 0 })
    expect(result.failures).toEqual([])
    expect(deps.fetchDetail).toHaveBeenCalledTimes(4)
    expect(deps.fetchDetail).toHaveBeenCalledWith(CONNECTION, { id: 'visma-A', invoiceNumber: '1001', issueDate: '2026-08-28' })

    expect(deps.applyDeduction).not.toHaveBeenCalled()
    expect(deps.repairStatus).not.toHaveBeenCalled()
    expect(deps.ensureAccounts).not.toHaveBeenCalled()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
    expect(writes()).toEqual([])
  })

  it('re-reads invoices applied earlier and flags one the provider has since requested', async () => {
    const E: Fixture = {
      invoiceId: 'inv-E',
      sourceId: 'visma-E',
      number: '1005',
      status: 'paid',
      paid: 6250,
      deductionTotal: 3750,
      deduction: { ...RUT_OPEN, providerState: 'requested' },
    }
    seed({
      fixtures: [A, E],
      vouchers: [{ id: 'je-E', source_id: 'inv-E' }],
      appliedRows: [invoiceRow(E)],
    })
    const deps = makeDeps({}, [A, E])

    const result = report(await run('preview', deps))

    expect(mock.findCalls('journal_entries', 'eq')).toContainEqual(['source_type', 'rot_rut_reclassification'])
    expect(mock.findCalls('invoices', 'in')).toContainEqual(['id', ['inv-E']])
    expect(result.candidates).toBe(2)
    expect(result.buckets.double_request).toEqual({ count: 1, amount: 3750 })
    expect(result.doubleRequests).toEqual([{ invoiceId: 'inv-E', invoiceNumber: '1005', deductionTotal: 3750 }])
    expect(writes()).toEqual([])
  })
})

describe('runDeductionBackfill: apply', () => {
  it('ensures the accounts once, applies each apply plan and repairs each status-only plan', async () => {
    seed()
    const deps = makeDeps()

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ mode: 'apply', complete: true, stopReason: null, candidates: 4, processed: 4 })
    expect(result.applied).toEqual({ invoices: 2, amount: 7500, statusRepaired: 1 })
    expect(result.failures).toEqual([])

    expect(deps.ensureAccounts).toHaveBeenCalledExactlyOnceWith(ctx)
    expect(deps.ensureAccounts.mock.invocationCallOrder[0]).toBeLessThan(deps.applyDeduction.mock.invocationCallOrder[0])

    expect(deps.applyDeduction).toHaveBeenCalledTimes(2)
    const applied = deps.applyDeduction.mock.calls.map((call) => [call[3].invoiceId, call[3].resultingStatus, call[4].invoiceNumber])
    expect(applied).toEqual([
      ['inv-A', 'sent', '1001'],
      ['inv-D', 'partially_paid', '1004'],
    ])
    const [client, companyId, userId, , options] = deps.applyDeduction.mock.calls[0]
    expect([client, companyId, userId]).toEqual([supabase, 'company-1', 'user-1'])
    expect(options).toEqual({
      bookingDate: TODAY,
      invoiceNumber: '1001',
      trail: { provider: 'visma', consentId: 'consent-1', correlationId: expect.any(String) },
    })

    expect(deps.repairStatus).toHaveBeenCalledExactlyOnceWith(
      supabase,
      'company-1',
      expect.objectContaining({ outcome: 'status_only', invoiceId: 'inv-B' }),
      options.trail,
    )
  })

  it('leaves invoices already applied alone without fetching them', async () => {
    const E: Fixture = { invoiceId: 'inv-E', sourceId: 'visma-E', number: '1005', deductionTotal: 3750 }
    seed({ fixtures: [A, E], vouchers: [{ id: 'je-E', source_id: 'inv-E' }] })
    const deps = makeDeps({}, [A, E])

    const result = report(await run('apply', deps))

    expect(deps.fetchDetail).toHaveBeenCalledExactlyOnceWith(CONNECTION, expect.objectContaining({ id: 'visma-A' }))
    expect(result.skipped).toEqual({ already_applied: 1 })
    expect(result.processed).toBe(2)
    // Apply mode never re-reads closed invoices.
    expect(mock.findCalls('invoices', 'in')).not.toContainEqual(['id', ['inv-E']])
  })

  it.each([
    ['a Visma 429', new VismaApiError('Too many requests', 429), 'rate_limited'],
    ['a rate-limited provider call', new ProviderCallError('PROVIDER_RATE_LIMITED', 'visma', 'slow down'), 'rate_limited'],
    ['a Visma 401', new VismaApiError('Unauthorized', 401), 'reconnect'],
    ['a Visma 403', new VismaApiError('Forbidden', 403), 'reconnect'],
    ['an expired provider token', new ProviderCallError('PROVIDER_AUTH_EXPIRED', 'visma', 'expired'), 'reconnect'],
    // Reconnecting can never clear these: the classifier says the subscription.
    ['an inactive API module', new VismaApiError('Forbidden', 403, 'ForbiddenRequestException - No access to module: api_standard'), 'subscription'],
    ['the same refusal already classified', new ProviderCallError('PROVIDER_API_MODULE_INACTIVE', 'visma', 'module'), 'subscription'],
  ])('stops on %s from the detail fetch and reports progress', async (_label, error, reason) => {
    seed()
    const deps = makeDeps()
    deps.fetchDetail.mockImplementation(async (_connection, source) => {
      if (source.id === 'visma-B') throw error
      return detail(ALL.find((f) => f.sourceId === source.id)!)
    })

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ complete: false, stopReason: reason, candidates: 4, processed: 1 })
    expect(result.processed).toBeLessThan(result.candidates)
    // A, before the stop, was written; nothing after it was.
    expect(deps.applyDeduction).toHaveBeenCalledTimes(1)
    expect(deps.repairStatus).not.toHaveBeenCalled()
    expect(result.applied).toEqual({ invoices: 1, amount: 3750, statusRepaired: 0 })
  })

  it('stops with period_locked when the voucher cannot be booked today', async () => {
    seed()
    const deps = makeDeps({
      applyDeduction: vi.fn(async () => ({
        ok: false as const,
        kind: 'error' as const,
        stage: 'book' as const,
        error: new Error(`No open fiscal period found for booking date ${TODAY}`),
        journalEntryId: null,
      })),
    })

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ complete: false, stopReason: 'period_locked', processed: 0 })
    expect(result.failures).toEqual([{ invoiceId: 'inv-A', invoiceNumber: '1001', code: 'PERIOD_LOCKED' }])
    expect(deps.applyDeduction).toHaveBeenCalledTimes(1)
    expect(deps.repairStatus).not.toHaveBeenCalled()
  })

  it('stops with accounts when the accounts cannot be activated', async () => {
    seed()
    const deps = makeDeps({ ensureAccounts: vi.fn(async () => false) })

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ complete: false, stopReason: 'accounts', processed: 0 })
    expect(result.failures).toEqual([{ invoiceId: 'inv-A', invoiceNumber: '1001', code: 'ACCOUNTS_UNAVAILABLE' }])
    expect(deps.applyDeduction).not.toHaveBeenCalled()
  })

  it('records a refusal and an apply-stage error per invoice and goes on', async () => {
    seed()
    const deps = makeDeps({
      applyDeduction: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, kind: 'refused', code: 'DRIFT', journalEntryId: null })
        .mockResolvedValueOnce({ ok: false, kind: 'error', stage: 'apply', error: new Error('deadlock'), journalEntryId: 'je-D' }),
    })

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ complete: true, stopReason: null, processed: 4 })
    expect(result.failures).toEqual([
      { invoiceId: 'inv-A', invoiceNumber: '1001', code: 'DRIFT' },
      { invoiceId: 'inv-D', invoiceNumber: '1004', code: 'WRITE_FAILED_APPLY' },
    ])
    expect(result.applied).toEqual({ invoices: 0, amount: 0, statusRepaired: 1 })
  })
})

describe('runDeductionBackfill: provider answers per invoice', () => {
  it('a 404 becomes a review row and the run goes on', async () => {
    seed()
    const deps = makeDeps()
    deps.fetchDetail.mockImplementation(async (_connection, source) => {
      if (source.id === 'visma-A') throw new VismaApiError('Not found', 404)
      return detail(ALL.find((f) => f.sourceId === source.id)!)
    })

    const result = report(await run('preview', deps))

    expect(result).toMatchObject({ complete: true, stopReason: null, candidates: 4, processed: 4 })
    expect(result.review).toEqual([{ invoiceId: 'inv-A', invoiceNumber: '1001', reason: 'not_found_at_provider' }])
    expect(result.buckets.review).toEqual({ count: 1, amount: 0 })
    expect(result.buckets.apply_partially_paid.count).toBe(1)
  })

  it('a detail the provider no longer has is a review row too', async () => {
    seed()
    const deps = makeDeps()
    deps.fetchDetail.mockImplementation(async (_connection, source) =>
      source.id === 'visma-C' ? null : detail(ALL.find((f) => f.sourceId === source.id)!),
    )

    const result = report(await run('preview', deps))

    expect(result.review).toEqual([{ invoiceId: 'inv-C', invoiceNumber: '1003', reason: 'not_found_at_provider' }])
    expect(result.skipped).toEqual({})
  })

  it('any other fetch failure is recorded and the run goes on', async () => {
    seed()
    const deps = makeDeps()
    deps.fetchDetail.mockImplementation(async (_connection, source) => {
      if (source.id === 'visma-A') throw new VismaApiError('Bad gateway', 502)
      return detail(ALL.find((f) => f.sourceId === source.id)!)
    })

    const result = report(await run('apply', deps))

    expect(result).toMatchObject({ complete: true, processed: 4 })
    expect(result.failures).toEqual([{ invoiceId: 'inv-A', invoiceNumber: '1001', code: 'FETCH_FAILED' }])
    expect(deps.applyDeduction).toHaveBeenCalledExactlyOnceWith(
      supabase,
      'company-1',
      'user-1',
      expect.objectContaining({ invoiceId: 'inv-D' }),
      expect.any(Object),
    )
  })
})
