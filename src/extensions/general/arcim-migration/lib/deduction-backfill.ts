/**
 * The post-migration deduction step for invoices imported from Visma.
 *
 * Visma invoices issued under fakturamodellen (ROT, RUT, grön teknik) were
 * imported without their deduction, and part-paid ones were left at sent
 * (crm#1144). This runner finds the company's imported invoices through the
 * migration's own source records, fetches each one's detail from Visma (the
 * list payload may leave out the buyers), plans it
 * (lib/invoices/migrated-deduction-plan.ts) and, in apply mode, writes it
 * (lib/invoices/migrated-deduction-apply.ts).
 *
 * Preview and apply run the same pass; preview writes nothing. Apply plans
 * every invoice again from fresh provider data, and the RPC refuses anything
 * that moved since that plan, so what is booked is what was just checked.
 * A run is stateless: applied invoices plan as "already applied", and a
 * voucher posted by a run that stopped is reused, so "Fortsätt" is simply the
 * same call again.
 *
 * Refused up front: a running provider import (it is still writing the same
 * invoices), no Visma connection or an expired one (reconnect), and a
 * connection to a different Visma company than the one migrated.
 * Stops early, reporting progress: Visma's rate limit (600 requests a
 * minute), an expired token mid-run, a locked or closed period for today's
 * voucher, and the time budget.
 */
import { chunk as chunks } from '@/lib/utils'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { SalesInvoiceDto } from '@/lib/providers/dto'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { resolveConsent, type ResolvedConsent } from '@/lib/providers/resolve-consent'
import { fetchInvoiceCompletionDetail } from '@/lib/providers/provider-data-fetcher'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import { VismaApiError } from '@/lib/providers/visma/client'
import {
  FiscalPeriodNotFoundError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import { isPeriodLockRefusal } from '@/lib/errors/get-structured-error'
import {
  planMigratedDeduction,
  type MigratedDeductionPlan,
  type MigratedDeductionReviewReason,
  type MigratedDeductionSkipReason,
  type PlanInvoice,
  type PlanItem,
} from '@/lib/invoices/migrated-deduction-plan'
import {
  applyMigratedDeduction,
  ensureDeductionAccounts,
  repairMigratedInvoiceStatus,
  type MigratedDeductionApplyOutcome,
} from '@/lib/invoices/migrated-deduction-apply'

export type DeductionBackfillMode = 'preview' | 'apply'

export type DeductionBackfillRefusal =
  | 'NOT_APPLICABLE'
  | 'IMPORT_RUNNING'
  | 'RECONNECT_REQUIRED'
  | 'DIFFERENT_COMPANY'

export type DeductionBackfillStopReason = 'rate_limited' | 'reconnect' | 'period_locked' | 'accounts' | 'deadline'

/** Review reasons the runner adds to the planner's own. */
export type DeductionBackfillReviewReason =
  | MigratedDeductionReviewReason
  | 'not_found_at_provider'

export interface DeductionBackfillInvoice {
  invoiceId: string
  invoiceNumber: string | null
  deductionTotal?: number
  paidOn?: string
}

/** The plan table's rows, counted and summed in kronor of deduction. */
export type DeductionBackfillBucket =
  | 'apply_unpaid'
  | 'apply_partially_paid'
  | 'apply_paid'
  | 'status_only'
  | 'review'
  | 'double_request'

export interface DeductionBackfillReport {
  mode: DeductionBackfillMode
  complete: boolean
  stopReason: DeductionBackfillStopReason | null
  /** Invoices this run had to look at, and how many it got through. */
  candidates: number
  processed: number
  buckets: Record<DeductionBackfillBucket, { count: number; amount: number }>
  skipped: Partial<Record<MigratedDeductionSkipReason, number>>
  review: Array<DeductionBackfillInvoice & { reason: DeductionBackfillReviewReason }>
  doubleRequests: DeductionBackfillInvoice[]
  /** Apply mode: what was written, and what the database refused. */
  applied: { invoices: number; amount: number; statusRepaired: number }
  failures: Array<DeductionBackfillInvoice & { code: string }>
}

export interface DeductionBackfillContext {
  supabase: SupabaseClient
  companyId: string
  userId: string
  log: Logger
}

export interface DeductionBackfillDeps {
  resolveConsent: (companyId: string, consentId: string) => Promise<ResolvedConsent>
  fetchDetail: (connection: ResolvedConsent, source: { id: string; invoiceNumber: string; issueDate: string }) => Promise<SalesInvoiceDto | null>
  applyDeduction: typeof applyMigratedDeduction
  repairStatus: typeof repairMigratedInvoiceStatus
  ensureAccounts: typeof ensureDeductionAccounts
  now: () => Date
}

const defaultDeps: DeductionBackfillDeps = {
  resolveConsent,
  fetchDetail: (connection, source) =>
    fetchInvoiceCompletionDetail('visma', connection.accessToken, connection.providerCompanyId, {
      id: source.id,
      detailId: source.id,
      invoiceNumber: source.invoiceNumber,
      issueDate: source.issueDate,
      creditNote: false,
    }),
  applyDeduction: applyMigratedDeduction,
  repairStatus: repairMigratedInvoiceStatus,
  ensureAccounts: ensureDeductionAccounts,
  now: () => new Date(),
}

const PROVIDER = 'visma'
const OPEN_STATUSES = ['sent', 'overdue', 'partially_paid']
const ACTIVE_JOB_STATES = ['queued', 'running', 'retry_wait']
/** Detail fetches in flight at once; the client's limiter keeps Visma's pace. */
const FETCH_CONCURRENCY = 4
const ID_CHUNK = 200

interface SourceRecord {
  source_id: string
  target_id: string
  account_key: string
}

interface InvoiceRow {
  id: string
  invoice_number: string | null
  invoice_date: string
  status: string
  currency: string | null
  total: number | string
  paid_amount: number | string | null
  deduction_total: number | string | null
}

function normalizeAccountKey(value: unknown): string {
  return String(value ?? '').replace(/[^a-z0-9]/gi, '')
}

function emptyReport(mode: DeductionBackfillMode): DeductionBackfillReport {
  const bucket = () => ({ count: 0, amount: 0 })
  return {
    mode,
    complete: true,
    stopReason: null,
    candidates: 0,
    processed: 0,
    buckets: {
      apply_unpaid: bucket(),
      apply_partially_paid: bucket(),
      apply_paid: bucket(),
      status_only: bucket(),
      review: bucket(),
      double_request: bucket(),
    },
    skipped: {},
    review: [],
    doubleRequests: [],
    applied: { invoices: 0, amount: 0, statusRepaired: 0 },
    failures: [],
  }
}

/** Whether the step applies to this company at all: it was migrated from Visma. */
export async function hasVismaInvoiceSource(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('migration_source_records')
    .select('id')
    .eq('company_id', companyId)
    .eq('provider', PROVIDER)
    .eq('resource', 'salesInvoices')
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

export async function isProviderImportRunning(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('migration_jobs')
    .select('id')
    .eq('company_id', companyId)
    .in('state', ACTIVE_JOB_STATES)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

/** The Visma connection that reaches the migrated company, or why none does. */
async function connectionFor(
  ctx: DeductionBackfillContext,
  accountKeys: Set<string>,
  deps: DeductionBackfillDeps,
): Promise<{ ok: true; connection: ResolvedConsent; consentId: string; accountKey: string } | { ok: false; code: DeductionBackfillRefusal }> {
  const { data, error } = await ctx.supabase
    .from('provider_consents')
    .select('id')
    .eq('company_id', ctx.companyId)
    .eq('provider', PROVIDER)
    .in('status', [0, 1])
    .order('created_at', { ascending: false })
  if (error) throw error
  const consents = (data ?? []) as Array<{ id: string }>
  if (consents.length === 0) return { ok: false, code: 'RECONNECT_REQUIRED' }

  let sawOtherCompany = false
  for (const consent of consents) {
    let connection: ResolvedConsent
    try {
      connection = await deps.resolveConsent(ctx.companyId, consent.id)
    } catch (resolveError) {
      ctx.log.warn('deduction backfill: Visma connection unusable', {
        consentId: consent.id,
        code: resolveError instanceof ProviderCallError ? resolveError.code : undefined,
      })
      continue
    }
    const accountKey =
      normalizeAccountKey(connection.consent.org_number) || connection.providerCompanyId || ''
    if (accountKeys.has(accountKey)) return { ok: true, connection, consentId: consent.id, accountKey }
    sawOtherCompany = true
  }
  return { ok: false, code: sawOtherCompany ? 'DIFFERENT_COMPANY' : 'RECONNECT_REQUIRED' }
}

async function loadCandidates(
  ctx: DeductionBackfillContext,
  sources: Map<string, SourceRecord>,
  mode: DeductionBackfillMode,
): Promise<Array<{ invoice: PlanInvoice; row: InvoiceRow; sourceId: string }>> {
  const { supabase, companyId } = ctx
  const open = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, status, currency, total, paid_amount, deduction_total')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', OPEN_STATUSES)
      .order('id', { ascending: true })
      .range(from, to),
  )

  const vouchers = await fetchAllRows<{ id: string; source_id: string }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, source_id')
      .eq('company_id', companyId)
      .eq('source_type', 'rot_rut_reclassification')
      .eq('status', 'posted')
      .order('id', { ascending: true })
      .range(from, to),
  )
  const voucherByInvoice = new Map(vouchers.map((v) => [v.source_id, v.id]))

  const rows = new Map<string, InvoiceRow>()
  for (const row of open) if (sources.has(row.id)) rows.set(row.id, row)
  // The preview also re-reads invoices applied earlier, for the provider's
  // view of them (sent to Skatteverket from Visma since: a double request).
  if (mode === 'preview') {
    const applied = [...voucherByInvoice.keys()].filter((id) => sources.has(id) && !rows.has(id))
    for (const ids of chunks(applied, ID_CHUNK)) {
      const { data, error } = await supabase
        .from('invoices')
        .select('id, invoice_number, invoice_date, status, currency, total, paid_amount, deduction_total')
        .eq('company_id', companyId)
        .in('id', ids)
      if (error) throw error
      for (const row of (data ?? []) as InvoiceRow[]) rows.set(row.id, row)
    }
  }

  const ids = [...rows.keys()]
  const items = new Map<string, PlanItem[]>()
  const payments = new Map<string, number>()
  for (const part of chunks(ids, ID_CHUNK)) {
    const itemRows = await fetchAllRows<PlanItem & { invoice_id: string }>(({ from, to }) =>
      supabase
        .from('invoice_items')
        .select('id, invoice_id, sort_order, line_type, quantity, unit, line_total, vat_amount, deduction_type')
        .in('invoice_id', part)
        .order('invoice_id', { ascending: true })
        .order('sort_order', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const item of itemRows) {
      const list = items.get(item.invoice_id) ?? []
      list.push({
        ...item,
        quantity: item.quantity == null ? null : Number(item.quantity),
        line_total: Number(item.line_total),
        vat_amount: Number(item.vat_amount),
      })
      items.set(item.invoice_id, list)
    }
    const paymentRows = await fetchAllRows<{ id: string; invoice_id: string }>(({ from, to }) =>
      supabase
        .from('invoice_payments')
        .select('id, invoice_id')
        .in('invoice_id', part)
        .order('id', { ascending: true })
        .range(from, to),
    )
    for (const payment of paymentRows) payments.set(payment.invoice_id, (payments.get(payment.invoice_id) ?? 0) + 1)
  }

  return [...rows.values()]
    .sort((a, b) => (a.invoice_number ?? a.id).localeCompare(b.invoice_number ?? b.id, 'sv', { numeric: true }))
    .map((row) => ({
      row,
      sourceId: sources.get(row.id)!.source_id,
      invoice: {
        id: row.id,
        invoice_number: row.invoice_number,
        status: row.status,
        currency: row.currency,
        total: Number(row.total),
        paid_amount: row.paid_amount == null ? null : Number(row.paid_amount),
        deduction_total: row.deduction_total == null ? null : Number(row.deduction_total),
        items: items.get(row.id) ?? [],
        payment_count: payments.get(row.id) ?? 0,
        reclassification_voucher_id: voucherByInvoice.get(row.id) ?? null,
      },
    }))
}

function stopReasonOf(error: unknown): DeductionBackfillStopReason | null {
  if (error instanceof ProviderCallError) {
    if (error.code === 'PROVIDER_RATE_LIMITED') return 'rate_limited'
    if (['PROVIDER_AUTH_EXPIRED', 'PROVIDER_RESOURCE_FORBIDDEN', 'PROVIDER_LICENSE_MISSING', 'PROVIDER_API_MODULE_INACTIVE'].includes(error.code)) {
      return 'reconnect'
    }
  }
  if (error instanceof VismaApiError) {
    if (error.statusCode === 429) return 'rate_limited'
    if (error.statusCode === 401 || error.statusCode === 403) return 'reconnect'
  }
  return null
}

/** Today's voucher cannot be booked: every invoice after this one would fail the same way. */
function isPeriodRefusal(error: unknown): boolean {
  return (
    isPeriodLockRefusal(error) ||
    error instanceof TargetPeriodLockedError ||
    error instanceof TargetPeriodClosedError ||
    error instanceof FiscalPeriodNotFoundError ||
    (error instanceof Error && error.message.startsWith('No open fiscal period found'))
  )
}

function bucketOf(plan: MigratedDeductionPlan): DeductionBackfillBucket | null {
  if (plan.outcome === 'apply') {
    if (plan.resultingStatus === 'paid') return 'apply_paid'
    if (plan.resultingStatus === 'partially_paid') return 'apply_partially_paid'
    return 'apply_unpaid'
  }
  if (plan.outcome === 'status_only') return 'status_only'
  if (plan.outcome === 'review') return 'review'
  if (plan.outcome === 'double_request') return 'double_request'
  return null
}

function amountOf(plan: MigratedDeductionPlan): number {
  if (plan.outcome === 'apply' || plan.outcome === 'double_request') return plan.deductionTotal
  if (plan.outcome === 'review') return plan.deductionTotal ?? 0
  return 0
}

export async function runDeductionBackfill(
  ctx: DeductionBackfillContext,
  options: { mode: DeductionBackfillMode; budgetMs: number },
  deps: DeductionBackfillDeps = defaultDeps,
): Promise<{ ok: true; report: DeductionBackfillReport } | { ok: false; code: DeductionBackfillRefusal }> {
  const startedAt = Date.now()
  const deadline = startedAt + options.budgetMs
  const { supabase, companyId, userId, log } = ctx

  const sourceRows = await fetchAllRows<SourceRecord>(({ from, to }) =>
    supabase
      .from('migration_source_records')
      .select('source_id, target_id, account_key')
      .eq('company_id', companyId)
      .eq('provider', PROVIDER)
      .eq('resource', 'salesInvoices')
      .order('id', { ascending: true })
      .range(from, to),
  )
  if (sourceRows.length === 0) return { ok: false, code: 'NOT_APPLICABLE' }
  if (await isProviderImportRunning(supabase, companyId)) return { ok: false, code: 'IMPORT_RUNNING' }

  const resolved = await connectionFor(ctx, new Set(sourceRows.map((row) => row.account_key)), deps)
  if (!resolved.ok) return resolved
  const sources = new Map(
    sourceRows.filter((row) => row.account_key === resolved.accountKey).map((row) => [row.target_id, row]),
  )

  const report = emptyReport(options.mode)
  const candidates = await loadCandidates(ctx, sources, options.mode)
  report.candidates = candidates.length

  const now = deps.now()
  const today = todayIsoStockholm(now)
  const trail = { provider: PROVIDER, consentId: resolved.consentId, correlationId: randomUUID() }
  let accountsReady = false

  const stop = (reason: DeductionBackfillStopReason) => {
    report.complete = false
    report.stopReason = reason
  }

  outer: for (const batch of chunks(candidates, FETCH_CONCURRENCY)) {
    if (Date.now() >= deadline) {
      stop('deadline')
      break
    }
    // Apply mode leaves invoices already applied alone: nothing to fetch.
    const work = batch.filter((c) => options.mode === 'preview' || !(Number(c.invoice.deduction_total ?? 0) > 0))
    const alreadyApplied = batch.length - work.length
    if (alreadyApplied > 0) {
      report.processed += alreadyApplied
      report.skipped.already_applied = (report.skipped.already_applied ?? 0) + alreadyApplied
    }

    const details = await Promise.allSettled(
      work.map((c) =>
        deps.fetchDetail(resolved.connection, {
          id: c.sourceId,
          invoiceNumber: c.row.invoice_number ?? '',
          issueDate: c.row.invoice_date,
        }),
      ),
    )

    for (let index = 0; index < work.length; index++) {
      const candidate = work[index]
      const settled = details[index]
      const ref: DeductionBackfillInvoice = {
        invoiceId: candidate.invoice.id,
        invoiceNumber: candidate.invoice.invoice_number,
      }
      if (settled.status === 'rejected') {
        const reason = stopReasonOf(settled.reason)
        if (reason) {
          stop(reason)
          break outer
        }
        if (settled.reason instanceof VismaApiError && settled.reason.statusCode === 404) {
          report.review.push({ ...ref, reason: 'not_found_at_provider' })
          report.buckets.review.count += 1
        } else {
          log.warn('deduction backfill: invoice detail failed', {
            invoiceId: candidate.invoice.id,
            error: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
          })
          report.failures.push({ ...ref, code: 'FETCH_FAILED' })
        }
        report.processed += 1
        continue
      }
      if (!settled.value) {
        report.review.push({ ...ref, reason: 'not_found_at_provider' })
        report.buckets.review.count += 1
        report.processed += 1
        continue
      }

      const plan = planMigratedDeduction(candidate.invoice, settled.value, { today, now })
      const bucket = bucketOf(plan)
      if (bucket) {
        report.buckets[bucket].count += 1
        report.buckets[bucket].amount = roundOre(report.buckets[bucket].amount + amountOf(plan))
      }
      if (plan.outcome === 'skip') {
        report.skipped[plan.reason] = (report.skipped[plan.reason] ?? 0) + 1
      } else if (plan.outcome === 'review') {
        report.review.push({ ...ref, reason: plan.reason, deductionTotal: plan.deductionTotal, paidOn: plan.paidOn })
      } else if (plan.outcome === 'double_request') {
        report.doubleRequests.push({ ...ref, deductionTotal: plan.deductionTotal })
      }

      if (options.mode === 'apply' && (plan.outcome === 'apply' || plan.outcome === 'status_only')) {
        let outcome: MigratedDeductionApplyOutcome
        if (plan.outcome === 'apply') {
          if (!accountsReady) {
            accountsReady = await deps.ensureAccounts(ctx)
            if (!accountsReady) {
              report.failures.push({ ...ref, code: 'ACCOUNTS_UNAVAILABLE' })
              stop('accounts')
              break outer
            }
          }
          outcome = await deps.applyDeduction(supabase, companyId, userId, plan, {
            bookingDate: today,
            invoiceNumber: candidate.invoice.invoice_number,
            trail,
          })
        } else {
          outcome = await deps.repairStatus(supabase, companyId, plan, trail)
        }

        if (outcome.ok) {
          if (plan.outcome === 'apply') {
            report.applied.invoices += 1
            report.applied.amount = roundOre(report.applied.amount + plan.deductionTotal)
          } else {
            report.applied.statusRepaired += 1
          }
        } else if (outcome.kind === 'refused') {
          report.failures.push({ ...ref, code: outcome.code })
        } else {
          if (outcome.stage === 'book' && isPeriodRefusal(outcome.error)) {
            report.failures.push({ ...ref, code: 'PERIOD_LOCKED' })
            stop('period_locked')
            break outer
          }
          log.error('deduction backfill: write failed', outcome.error as Error, {
            invoiceId: candidate.invoice.id,
            stage: outcome.stage,
            journalEntryId: outcome.journalEntryId,
          })
          report.failures.push({ ...ref, code: `WRITE_FAILED_${outcome.stage.toUpperCase()}` })
        }
      }
      report.processed += 1
    }
  }

  log.info('deduction backfill run', {
    mode: options.mode,
    candidates: report.candidates,
    processed: report.processed,
    complete: report.complete,
    stopReason: report.stopReason,
    applied: report.applied.invoices,
    statusRepaired: report.applied.statusRepaired,
    review: report.review.length,
    failures: report.failures.length,
    durationMs: Date.now() - startedAt,
  })
  return { ok: true, report }
}
