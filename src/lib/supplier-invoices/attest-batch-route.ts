/**
 * The door of the batched attest link's routes under /api/attest/lista/[token]
 * (crm#1569): the link in the batched attest mail (attest-batches.ts) is the
 * authentication, so every route resolves the token first and then runs the
 * SAME attest service as the dashboard (attest-service.ts), invoice by
 * invoice, as the attester the link was minted for, for the company it
 * names. Limits, four eyes and two attesters from an amount hold exactly as
 * in the app: the service and the database's attest_supplier_invoice decide.
 *
 * The posture of the single invoice's door (attest-link-route.ts): no
 * session, no supabase.auth; the service-role client reads the row; a
 * per-token budget bounds a leaked link; the clear token is never logged.
 * Every way a token fails (malformed, unknown, expired, used) answers the
 * same 404, and so does a link whose attester's attest can no longer count or
 * whose company is archived (attesterCanStillDecide, the single link's rule).
 *
 * What the link may still decide is per invoice: one listed in it, still
 * waiting on this attester, and not rejected by anyone since the mail went
 * out (a rejection ends the round, as it spends every single-invoice link).
 * Once nothing listed is left to decide, the link is consumed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger, type Logger } from '@/lib/logger'
import type { OperationContext } from '@/lib/operations/types'
import { consumeAttestBatch, resolveAttestBatch, type AttestBatchKind, type AttestBatchRow } from './attest-batches'
import { createAttestDecisionBatch } from './attest-decision-notify'
import { attesterCanStillDecide } from './attest-link-route'
import { isValidAttestTokenFormat } from './attest-links'
import { ATTEST_COMMENT_MAX, currentRound, latestRejection } from './attest-policy'
import { loadAttestLimits, loadAttestPolicy, loadAttestTrails } from './attest-policy-read'
import { approveSupplierInvoice, attestViewerOf, loadAttestMembers, loadAttestPeople, rejectSupplierInvoice } from './attest-service'
import { isOverduePayable } from './lifecycle'

// 120 requests per token per 10 minutes: the page, a document per invoice,
// the answer and a few reloads. Process-local, like the single link's limiter.
const limiter = createTokenRateLimiter({ max: 120, windowMs: 10 * 60_000 })

export interface AttestBatchRouteContext {
  batch: AttestBatchRow
  service: SupabaseClient
  /** The operation context the attest service takes: the company of the link, acting as its attester. */
  op: OperationContext
  log: Logger
  requestId: string
}

type Params<P> = { params: Promise<P> }

export type AttestBatchRouteHandler<P> = (request: Request, ctx: AttestBatchRouteContext, params: P) => Promise<Response>

/** Wrap a batched link's route; `operation` names it in the logs ('attest_batch.decide'). */
export function withAttestBatchToken<P extends { token: string }>(operation: string, handler: AttestBatchRouteHandler<P>) {
  return async (request: Request, { params }: Params<P>): Promise<Response> => {
    const requestId = randomUUID()
    const log = createLogger('attest-batch', { requestId, operation })
    const resolvedParams = await params
    const token = resolvedParams.token
    if (!isValidAttestTokenFormat(token)) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: 'malformed attest batch token' })
    if (!limiter.allow(token)) return errorResponseFromCode('RATE_LIMITED', log, { requestId, reason: 'attest batch token over its budget' })

    const service = createServiceClientNoCookies()
    try {
      const resolved = await resolveAttestBatch(service, token)
      if (!resolved.ok) return errorResponseFromCode('NOT_FOUND', log, { requestId, reason: `attest batch ${resolved.reason}` })
      const { batch } = resolved
      const batchLog = log.child({ companyId: batch.company_id, attestBatchId: batch.id })
      if (!(await attesterCanStillDecide(service, batch))) {
        return errorResponseFromCode('NOT_FOUND', batchLog, { requestId, reason: 'attest batch of someone whose attest no longer counts in a live company' })
      }
      return await handler(
        request,
        {
          batch,
          service,
          op: { supabase: service, companyId: batch.company_id, userId: batch.attester_user_id, log: batchLog },
          log: batchLog,
          requestId,
        },
        resolvedParams,
      )
    } catch (error) {
      return errorResponse(error, log, { requestId })
    }
  }
}

/**
 * Where an invoice stands for this link: open (the attester may decide now),
 * approved (they approved it in this round; it may wait on someone else),
 * attested (the attest is complete), rejected (they rejected it through the
 * mail's round), closed (not theirs to decide through this link: someone
 * rejected it after the mail went out, it left attest, or the rules do not
 * let them).
 */
export type AttestBatchInvoiceState = 'open' | 'approved' | 'attested' | 'rejected' | 'closed'

export interface AttestBatchInvoiceView {
  id: string
  supplier_name: string | null
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  due_date: string
  total: number
  currency: string
  has_document: boolean
  /** Past its due date and still owed. */
  overdue: boolean
  registered_by: string | null
  state: AttestBatchInvoiceState
  may_approve: boolean
  may_reject: boolean
  /** Why the attester may not decide, when they may not (attest-service reasons). */
  reason: string | null
}

export interface AttestBatchPageData {
  company_name: string
  attester_name: string | null
  kind: AttestBatchKind
  expires_at: string
  /** In the mail's order: soonest due first. */
  invoices: AttestBatchInvoiceView[]
}

type BatchInvoiceRow = {
  id: string
  user_id: string
  status: string
  approved_at: string | null
  is_credit_note: boolean | null
  currency: string
  total: number
  total_sek: number | null
  exchange_rate: number | null
  supplier_invoice_number: string | null
  arrival_number: number
  invoice_date: string
  due_date: string
  remaining_amount: number
  document_id: string | null
  supplier: { name: string | null } | null
}

/**
 * When the mail went out: a link tried again keeps its created_at, so the
 * time it was handed to the provider (mail_sent_at) is what "rejected since
 * the mail" is measured from.
 */
function mailedAt(batch: AttestBatchRow): string {
  return batch.mail_sent_at ?? batch.created_at
}

/** What the page under /attest/lista/<token> shows: every listed invoice and what this attester may do with it. */
export async function describeAttestBatch(
  service: SupabaseClient,
  batch: AttestBatchRow,
  options: { today?: string } = {},
): Promise<AttestBatchPageData> {
  const companyId = batch.company_id
  const attesterId = batch.attester_user_id
  const ids = batch.invoice_ids
  const [policy, limits, members, { data: settingsRow, error: settingsError }, { data: companyRow }, { data: invoiceRows, error: invoiceError }, attestations] =
    await Promise.all([
      loadAttestPolicy(service, companyId),
      loadAttestLimits(service, companyId),
      loadAttestMembers(service, companyId),
      service.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle(),
      service.from('companies').select('name').eq('id', companyId).maybeSingle(),
      service
        .from('supplier_invoices')
        .select(
          'id, user_id, status, approved_at, is_credit_note, currency, total, total_sek, exchange_rate, supplier_invoice_number, arrival_number, invoice_date, due_date, remaining_amount, document_id, supplier:suppliers(name)',
        )
        .eq('company_id', companyId)
        .in('id', ids),
      loadAttestTrails(service, companyId, ids),
    ])
  if (settingsError) throw settingsError
  if (invoiceError) throw invoiceError
  const accountingMethod = (settingsRow as { accounting_method?: string | null } | null)?.accounting_method ?? null
  const invoices = new Map(
    ((invoiceRows ?? []) as unknown as BatchInvoiceRow[]).map((row) => [
      row.id,
      { ...row, total: Number(row.total), remaining_amount: Number(row.remaining_amount) },
    ]),
  )
  const people = await loadAttestPeople(service, [attesterId, ...[...invoices.values()].map((i) => i.user_id)])
  const nameOf = (id: string) => {
    const person = people.get(id)
    return person?.name ?? person?.email ?? null
  }
  const today = options.today ?? todayIsoStockholm()

  const views: AttestBatchInvoiceView[] = []
  for (const id of ids) {
    const invoice = invoices.get(id)
    if (!invoice) continue
    const trail = attestations.get(id) ?? []
    const viewer = attestViewerOf(policy, accountingMethod, invoice, trail, attesterId, members, { limits })
    const rejection = latestRejection(trail)
    const rejectedSince = rejection && rejection.decided_at > mailedAt(batch) ? rejection : null
    const approvedThisRound = currentRound(trail).some((row) => row.decision === 'approved' && row.user_id === attesterId)
    const state: AttestBatchInvoiceState = invoice.approved_at
      ? 'attested'
      : rejectedSince
        ? rejectedSince.user_id === attesterId
          ? 'rejected'
          : 'closed'
        : approvedThisRound
          ? 'approved'
          : viewer.may_approve || viewer.may_reject
            ? 'open'
            : 'closed'
    views.push({
      id,
      supplier_name: invoice.supplier?.name ?? null,
      supplier_invoice_number: invoice.supplier_invoice_number,
      arrival_number: invoice.arrival_number,
      invoice_date: invoice.invoice_date,
      due_date: invoice.due_date,
      total: invoice.total,
      currency: invoice.currency,
      has_document: !!invoice.document_id,
      overdue: isOverduePayable(invoice, today),
      registered_by: nameOf(invoice.user_id),
      state,
      may_approve: state === 'open' && viewer.may_approve,
      may_reject: state === 'open' && viewer.may_reject,
      reason: state === 'open' || state === 'closed' ? viewer.reason : null,
    })
  }
  return {
    company_name: (companyRow as { name: string | null } | null)?.name?.trim() || 'Företaget',
    attester_name: nameOf(attesterId),
    kind: batch.kind,
    expires_at: batch.expires_at,
    invoices: views,
  }
}

export interface AttestBatchDecision {
  invoice_id: string
  decision: 'approve' | 'reject'
  comment?: string | null
}

export interface AttestBatchDecisionResult {
  invoice_id: string
  ok: boolean
  decision?: 'approved' | 'rejected'
  /** The approval completed the attest: the invoice can be paid. */
  attested?: boolean
  /** Why not, when not ok: the attest service's code. */
  code?: string
}

/** True when someone rejected the invoice after `since`: the round the mail asked about has ended. */
async function rejectedSince(service: SupabaseClient, companyId: string, invoiceId: string, since: string): Promise<boolean> {
  const { data, error } = await service
    .from('supplier_invoice_attestations')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoiceId)
    .eq('decision', 'rejected')
    .gt('decided_at', since)
    .limit(1)
  if (error) throw error
  return ((data ?? []) as unknown[]).length > 0
}

/**
 * Record the attester's answers, invoice by invoice, through the attest
 * service as their own decisions from the mail ('email_link'). One failing
 * invoice never stops the others: each gets its result. Right before each
 * decision the link checks again that nobody rejected the invoice since the
 * mail went out (another attester may do so while a long list is being
 * approved), since the database would take an approval after a rejection as
 * the start of a new round. The registrant gets ONE mail for the whole
 * answer: every decision goes into one collector the service fills the
 * moment it stores the decision, flushed in a finally so no stored answer
 * goes untold. When nothing listed is left to decide, the link is consumed.
 */
export async function decideAttestBatch(
  ctx: AttestBatchRouteContext,
  decisions: readonly AttestBatchDecision[],
): Promise<{ results: AttestBatchDecisionResult[]; page: AttestBatchPageData }> {
  const { batch, service, op, log } = ctx
  const before = await describeAttestBatch(service, batch)
  const open = new Set(before.invoices.filter((i) => i.state === 'open').map((i) => i.id))
  const results: AttestBatchDecisionResult[] = []
  const answers = createAttestDecisionBatch()
  const seen = new Set<string>()

  try {
    for (const decision of decisions) {
      const invoiceId = decision.invoice_id
      if (seen.has(invoiceId)) continue
      seen.add(invoiceId)
      if (!batch.invoice_ids.includes(invoiceId)) {
        results.push({ invoice_id: invoiceId, ok: false, code: 'NOT_FOUND' })
        continue
      }
      if (!open.has(invoiceId)) {
        results.push({ invoice_id: invoiceId, ok: false, code: 'ATTEST_NOT_PENDING' })
        continue
      }
      try {
        if (await rejectedSince(service, batch.company_id, invoiceId, mailedAt(batch))) {
          results.push({ invoice_id: invoiceId, ok: false, code: 'ATTEST_NOT_PENDING' })
          continue
        }
        if (decision.decision === 'approve') {
          const outcome = await approveSupplierInvoice(op, { invoiceId, source: 'email_link', writer: service, decisions: answers })
          if (!outcome.ok) {
            results.push({ invoice_id: invoiceId, ok: false, code: outcome.code })
            continue
          }
          if (outcome.dryRun) continue
          results.push({ invoice_id: invoiceId, ok: true, decision: 'approved', attested: outcome.data.approved || !!outcome.data.invoice.approved_at })
        } else {
          const comment = (decision.comment ?? '').trim().slice(0, ATTEST_COMMENT_MAX) || null
          const outcome = await rejectSupplierInvoice(op, { invoiceId, comment, source: 'email_link', writer: service, decisions: answers })
          if (!outcome.ok) {
            results.push({ invoice_id: invoiceId, ok: false, code: outcome.code })
            continue
          }
          if (outcome.dryRun) continue
          results.push({ invoice_id: invoiceId, ok: true, decision: 'rejected' })
        }
      } catch (error) {
        log.error('attest batch decision failed', error instanceof Error ? error : new Error(String(error)), { invoiceId })
        results.push({ invoice_id: invoiceId, ok: false, code: 'INTERNAL_ERROR' })
      }
    }
  } finally {
    // The decisions are stored: one mail per company and attester for all of them, even when one threw.
    await answers.flush(service)
  }

  const page = await describeAttestBatch(service, batch)
  if (!page.invoices.some((i) => i.state === 'open')) await consumeAttestBatch(service, batch.id)
  return { results, page }
}
