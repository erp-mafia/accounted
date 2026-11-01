import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsOpenCaseRequest } from '@accounted/connect-contract'
import { eventBus } from '@/lib/events'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getCollectionsProvider } from './catalogue'
import {
  applyCaseSnapshot,
  appendCaseEvents,
  loadCaseById,
  normalizeCaseRow,
  type CollectionCaseRow,
} from './case'
import { HandoverDocumentError, readArchivedDocument, resolveHandoverDocument } from './case-document'
import { loadLiveConnection, type CollectionConnectionRow } from './connection'
import { CONNECTOR_PROTOCOL_ERROR_CODE } from '@/lib/connect/instance/connector-fetch'
import { seedForwardsAtRegistration } from './forwarding'
import { isCollectionsError, type CollectionsError } from './errors'
import { bankCheckSnapshot, type BankCheckResult } from './bank-check'
import { resolveStartStep, startStepRefusalCode, startStepsFor } from './start-step'
import type { Eligibility } from './eligibility'
import { normalizeOrgNumber } from '@/lib/invariants/org-number'
import { debtorCountryCode } from './eligibility'
import {
  HandoverNotFoundError,
  loadHandoverContext,
  revealDebtorPersonalNumber,
  type HandoverContext,
  type HandoverCustomer,
} from './readiness'
import {
  adapterForConnection,
  callContext,
  gateRefusal,
  loadConnectionById,
  refusal,
  serviceLog,
  type CollectionsRefusal,
  type CollectionsServiceDeps,
} from './service-deps'

/**
 * Hand one invoice over to the company's collections provider (build spec
 * 3.4). Shared by the dashboard route POST /api/invoices/[id]/collection,
 * the staged operation collections.cases.open and the sync cron's retry.
 *
 * Order (rule 5: never hand over an invoice that may already be paid):
 *   1. Start gates (flags.ts): kill switch, pilot, capability, activation.
 *   2. The facts again (readiness.ts): eligibility and the bank check run at
 *      commit time too, not only when the dialog opened.
 *   3. Attestations: only a person in the web UI gives them; an agent's
 *      handover needs a delivered invoice, no customer response and a bank
 *      check that passed.
 *   4. The amount still owed must equal what the person saw.
 *   5. The case row is reserved (preparing), the request built (the
 *      personnummer revealed and logged, the PDF archived), the row marked
 *      submitted with the request minus the personnummer and the PDF bytes,
 *      and only then is Connect called with the row id as idempotency key.
 *   6. Registered: the snapshot is stored. Refused: the case is closed as
 *      failed. A timeout or another retryable failure leaves it submitted,
 *      and the sync cron repeats the exact same request.
 */

export interface OpenCaseInput {
  invoiceId: string
  /** Defaults to the connection's first step. */
  startStep?: 'reminder' | 'collection' | null
  /** What the person saw as still owed; a payment meanwhile refuses the handover. */
  expectedRemaining: number
  attestations?: {
    bank?: boolean
    delivery?: boolean
    imported?: boolean
    response?: boolean
  }
  dismissedTransactionIds?: string[]
  origin?: 'handover' | 'batch'
  /** A deterministic case id (the daily batch); default a fresh one. */
  caseId?: string
  pendingOperationId?: string | null
  dryRun?: boolean
}

export type OpenCaseOutcome =
  | { ok: true; dryRun: true; preview: Record<string, unknown> }
  | { ok: true; dryRun?: false; case: CollectionCaseRow; registered: boolean }
  | CollectionsRefusal

/** What the submission_request column holds while a handover is in flight. */
export interface StoredSubmission {
  /** The request as sent, with personalNumber null and the PDF bytes left out. */
  request: CollectionsOpenCaseRequest
  documentId: string
  /** The customer's personnummer was in the request: re-read and re-checked for a retry. */
  personalNumberSent: boolean
}

function attestationProblems(
  ctx: HandoverContext,
  input: OpenCaseInput,
  channel: 'web' | 'agent',
): { missing: string[]; agentRefused: boolean } {
  const att = input.attestations ?? {}
  // A dismissed bank row ("not a payment of this invoice") is a person's word too.
  const given = !!(att.bank || att.delivery || att.imported || att.response) || (input.dismissedTransactionIds?.length ?? 0) > 0
  if (channel === 'agent' && given) return { missing: [], agentRefused: true }
  const missing: string[] = []
  const { eligibility } = ctx
  if (eligibility.deliveryAttestation === 'imported' && !att.imported) missing.push('imported')
  if (eligibility.deliveryAttestation === 'not_delivered' && !att.delivery) missing.push('delivery')
  if (eligibility.responseAttestation && !att.response) missing.push('response')
  if ((ctx.bankCheck.outcome === 'stale' || ctx.bankCheck.outcome === 'no_bank') && !att.bank) missing.push('bank')
  return { missing, agentRefused: false }
}

/**
 * The checks that refuse a handover, in the order a person fixes them.
 * Returns null when the handover may go ahead.
 */
export function handoverRefusal(
  ctx: HandoverContext,
  input: OpenCaseInput,
  channel: 'web' | 'agent',
): CollectionsRefusal | null {
  if (!ctx.eligibility.eligible) {
    return refusal('COLLECTION_NOT_ELIGIBLE', { blocks: ctx.eligibility.blocks })
  }
  if (ctx.bankCheck.outcome === 'candidates') {
    return refusal('COLLECTION_BANK_CANDIDATES', {
      candidates: ctx.bankCheck.candidates.filter((c) => !c.dismissed).map((c) => c.transactionId),
    })
  }
  const { missing, agentRefused } = attestationProblems(ctx, input, channel)
  if (agentRefused) return refusal('COLLECTION_ATTESTATION_WEB_ONLY')
  if (missing.length > 0) {
    if (channel === 'agent') {
      return missing.includes('bank')
        ? refusal('COLLECTION_BANK_STALE', { freshness: ctx.bankCheck.freshness })
        : refusal('COLLECTION_ATTESTATION_WEB_ONLY', { attestations: missing })
    }
    return refusal('COLLECTION_ATTESTATION_REQUIRED', { attestations: missing })
  }
  if (roundOre(input.expectedRemaining) !== ctx.eligibility.claim.remaining) {
    return refusal('COLLECTION_REMAINING_CHANGED', { remaining: ctx.eligibility.claim.remaining })
  }
  return null
}

/**
 * The payments the provider is told about: every recorded payment row, plus
 * the part of paid_amount no row explains (an invoice paid in part in the
 * previous system), so the provider's remaining equals ours.
 */
export function priorPaymentsFor(
  ctx: Pick<HandoverContext, 'invoice' | 'payments'>,
): CollectionsOpenCaseRequest['priorPayments'] | null {
  const rows = ctx.payments.filter((p) => roundOre(p.amount) !== 0)
  if (rows.some((p) => p.amount < 0)) return null
  const prior = rows
    .map((p) => ({ paymentRef: p.id, date: p.payment_date, amount: roundOre(p.amount) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const recorded = roundOre(prior.reduce((sum, p) => sum + p.amount, 0))
  const gap = roundOre((ctx.invoice.paid_amount ?? 0) - recorded)
  if (gap < 0) return null
  if (gap > 0) {
    prior.push({
      paymentRef: `${ctx.invoice.id}:prior`,
      date: ctx.invoice.paid_at?.slice(0, 10) ?? ctx.invoice.invoice_date,
      amount: gap,
    })
  }
  return prior
}

function debtorFor(customer: HandoverCustomer, eligibility: Eligibility, personalNumber: string | null): CollectionsOpenCaseRequest['debtor'] {
  const trim = (v: string | null, max: number) => (v?.trim() ? v.trim().slice(0, max) : null)
  return {
    kind: eligibility.debtorKind,
    name: customer.name.trim().slice(0, 200),
    orgNumber: eligibility.debtorKind === 'business' ? normalizeOrgNumber(customer.org_number) : null,
    personalNumber,
    vatNumber: trim(customer.vat_number, 20),
    customerNumber: trim(customer.customer_number, 50),
    accountingDebtorRef: customer.id,
    email: customer.email?.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email.trim()) ? customer.email.trim().slice(0, 254) : null,
    phone: trim(customer.phone, 30),
    address: {
      line1: customer.address_line1!.trim().slice(0, 100),
      line2: trim(customer.address_line2, 100),
      postalCode: customer.postal_code!.trim().slice(0, 12),
      city: customer.city!.trim().slice(0, 60),
      countryCode: debtorCountryCode(customer.country ?? 'SE'),
    },
  }
}

/** The open-case request for a handover. Pure; the personnummer and the PDF are passed in. */
export function buildOpenCaseRequest(input: {
  caseId: string
  ctx: HandoverContext
  startStep: 'reminder' | 'collection'
  priorPayments: CollectionsOpenCaseRequest['priorPayments']
  personalNumber: string | null
  document: { filename: string; sha256: string; base64: string }
}): CollectionsOpenCaseRequest {
  const { ctx } = input
  const { invoice, eligibility } = ctx
  return {
    idempotencyKey: input.caseId,
    invoice: {
      ref: invoice.id,
      number: (invoice.invoice_number ?? invoice.id).slice(0, 50),
      issueDate: invoice.invoice_date,
      dueDate: invoice.due_date,
      currency: 'SEK',
      claimAmount: eligibility.claim.amount,
      claimVatAmount: eligibility.claim.vatAmount,
      claimRemaining: eligibility.claim.remaining,
      reference: invoice.your_reference?.trim() ? invoice.your_reference.trim().slice(0, 100) : null,
    },
    startStep: input.startStep,
    nextActionDate: null,
    reminderFeeAgreed: eligibility.reminderFeeAgreed,
    // Founder decision 2026-10-04 (the provider's answer): the statutory rate
    // applies; a contractual rate is not sent in this version.
    lateInterest: null,
    priorPayments: input.priorPayments,
    // Credit notes make an invoice ineligible here (elig_credited), so none is outstanding.
    priorCredits: [],
    debtor: debtorFor(ctx.customer!, eligibility, input.personalNumber),
    document: {
      filename: input.document.filename.slice(0, 255),
      contentType: 'application/pdf',
      base64: input.document.base64,
      sha256: input.document.sha256,
    },
  }
}

function storedSubmission(request: CollectionsOpenCaseRequest, documentId: string): StoredSubmission {
  return {
    request: {
      ...request,
      debtor: { ...request.debtor, personalNumber: null },
      document: { ...request.document, base64: '' },
    },
    documentId,
    personalNumberSent: request.debtor.personalNumber !== null,
  }
}

function previewOf(ctx: HandoverContext, startStep: string, connection: CollectionConnectionRow): Record<string, unknown> {
  return {
    invoice_id: ctx.invoice.id,
    invoice_number: ctx.invoice.invoice_number,
    customer_name: ctx.customer?.name ?? null,
    claim_amount: ctx.eligibility.claim.amount,
    remaining_amount: ctx.eligibility.claim.remaining,
    overdue_days: ctx.eligibility.overdueDays,
    start_step: startStep,
    reminder_fee_agreed: ctx.eligibility.reminderFeeAgreed,
    bank_check: ctx.bankCheck.outcome,
    provider: connection.display_name,
  }
}

/** Store a provider refusal: the case closes as failed and keeps the code. */
async function failCase(db: SupabaseClient, row: CollectionCaseRow, error: CollectionsError, now: Date): Promise<CollectionCaseRow> {
  const { data, error: updateError } = await db
    .from('collection_cases')
    .update({
      submission_status: 'failed',
      submission_request: null,
      is_open: false,
      closed_at: now.toISOString(),
      actions: [],
      sync_error: error.code.slice(0, 200),
    })
    .eq('id', row.id)
    .select('*')
    .single()
  if (updateError) throw new Error(`collection_cases update failed: ${updateError.message}`)
  const failed = normalizeCaseRow(data as Record<string, unknown>)
  await appendCaseEvents(db, failed, [
    { kind: 'sync_error', label: error.code, occurredAt: now.toISOString(), direction: 'internal' },
  ])
  return failed
}

/**
 * Failures after which the provider may hold the case although the call
 * failed: an answer that did not match the contract (Connect acted, then
 * answered in a shape we cannot read) and a key Connect already holds with
 * another body. Such a case is never closed as refused: it stays submitted,
 * shows its error on the card and in Att göra, and is retried, so a claim
 * the provider pursues is never one the ledger forgot.
 */
const AMBIGUOUS_SUBMISSION_CODES: ReadonlySet<string> = new Set([CONNECTOR_PROTOCOL_ERROR_CODE, 'CONNECTOR_IDEMPOTENCY_MISMATCH'])

/** Whether a failed submission stays submitted (retried) rather than closing as refused. */
export function submissionStaysOpen(error: Pick<CollectionsError, 'code' | 'retryable'>): boolean {
  return error.retryable || AMBIGUOUS_SUBMISSION_CODES.has(error.code)
}

/**
 * Send a case's request to the provider and store the answer. Shared by the
 * first send and every retry, so both treat the answer the same way.
 */
export async function submitCase(
  deps: Pick<CollectionsServiceDeps, 'db' | 'companyId' | 'adapterFor' | 'log'> & { now: Date; userId: string | null },
  row: CollectionCaseRow,
  connection: CollectionConnectionRow,
  request: CollectionsOpenCaseRequest,
): Promise<{ case: CollectionCaseRow; registered: boolean; error?: CollectionsError }> {
  const log = serviceLog(deps, 'collections/open-case')
  const adapter = adapterForConnection(deps, connection)
  try {
    const receipt = await adapter.openCase(callContext(deps.companyId, connection), request)
    // What the request already reported is recorded as forwarded before the
    // case reads as registered, so the drain never reports it a second time
    // and removing one of those payments later reverts it at the provider.
    await seedForwardsAtRegistration(deps.db, row.id, request)
    const applied = await applyCaseSnapshot(deps.db, row, receipt.case, { now: deps.now, userId: deps.userId })
    return { case: applied.row, registered: true }
  } catch (err) {
    if (!isCollectionsError(err)) throw err
    if (submissionStaysOpen(err)) {
      log.warn('collection case submission will be retried', { caseId: row.id, code: err.code })
      const { data, error } = await deps.db
        .from('collection_cases')
        .update({ sync_error: err.code.slice(0, 200) })
        .eq('id', row.id)
        .select('*')
        .single()
      if (error) throw new Error(`collection_cases update failed: ${error.message}`)
      return { case: normalizeCaseRow(data as Record<string, unknown>), registered: false, error: err }
    }
    log.warn('collection case refused by the provider', { caseId: row.id, code: err.code })
    return { case: await failCase(deps.db, row, err, deps.now), registered: false, error: err }
  }
}

export async function openCollectionCase(deps: CollectionsServiceDeps, input: OpenCaseInput): Promise<OpenCaseOutcome> {
  const now = deps.now ? deps.now() : new Date()
  const { db, companyId } = deps

  const connection = await loadLiveConnection(db, companyId)
  const refused = gateRefusal('handover', deps)
  if (refused) return refused
  if (!connection) return refusal('COLLECTIONS_NOT_ACTIVE')
  // An installation without an adapter for the connection's route answers
  // before anything is reserved.
  try {
    adapterForConnection(deps, connection)
  } catch (err) {
    if (isCollectionsError(err)) return refusal(err.code)
    throw err
  }

  const provider = await getCollectionsProvider(connection.route)
  let ctx: HandoverContext
  try {
    ctx = await loadHandoverContext(db, {
      companyId,
      invoiceId: input.invoiceId,
      connection,
      features: provider?.features ?? null,
      dismissedTransactionIds: input.dismissedTransactionIds,
      purpose: input.dryRun ? 'collections_check' : 'collections_handover',
      userId: deps.actor.userId,
      now,
      log: deps.log,
    })
  } catch (err) {
    if (err instanceof HandoverNotFoundError) return refusal('INVOICE_NOT_FOUND')
    throw err
  }

  const problem = handoverRefusal(ctx, input, deps.channel)
  if (problem) return problem
  const priorPayments = priorPaymentsFor(ctx)
  if (!priorPayments) return refusal('COLLECTION_PAYMENT_HISTORY_UNSUPPORTED')
  const features = provider?.features
  const steps = startStepsFor(features?.startSteps ?? ['reminder', 'collection'], ctx.eligibility.reminderFeeAgreed)
  const startStep = input.startStep ?? resolveStartStep(connection.default_start_step, steps) ?? connection.default_start_step
  if (!steps.includes(startStep)) {
    return refusal(startStepRefusalCode(startStep, ctx.eligibility.reminderFeeAgreed), { start_step: startStep })
  }
  if (input.dryRun) return { ok: true, dryRun: true, preview: previewOf(ctx, startStep, connection) }

  // Reserve the case: its id is the idempotency key and the provider's case reference.
  const attestations = input.attestations ?? {}
  const snapshot = bankCheckSnapshot(ctx.bankCheck as BankCheckResult, {
    actorUserId: deps.actor.userId,
    bankAttested: !!attestations.bank && ctx.bankCheck.outcome !== 'pass',
    deliveredOutcome: ctx.eligibility.deliveryAttestation ? 'attested' : 'delivered',
    importedAttestation: !!attestations.imported && ctx.eligibility.deliveryAttestation === 'imported',
    responseAttestation: !!attestations.response && ctx.eligibility.responseAttestation !== null,
  })
  const { data: inserted, error: insertError } = await db
    .from('collection_cases')
    .insert({
      // No id given: the column default draws one (undefined never goes on the wire).
      id: input.caseId || undefined,
      company_id: companyId,
      invoice_id: ctx.invoice.id,
      connection_id: connection.id,
      origin: input.origin ?? 'handover',
      start_step: startStep,
      submission_status: 'preparing',
      claim_amount: ctx.eligibility.claim.amount,
      bank_check: snapshot,
      last_bank_checked_at: ctx.bankCheck.checkedAt,
      opened_by: deps.actor.userId,
      opened_at: now.toISOString(),
      pending_operation_id: input.pendingOperationId ?? null,
    })
    .select('*')
    .single()
  if (insertError) {
    if (insertError.code === '23505') return refusal('COLLECTION_CASE_EXISTS')
    if (/COLLECTION_CASE_(INVOICE|CONNECTION)_INVALID/.test(insertError.message)) {
      return refusal('COLLECTION_NOT_ELIGIBLE', { reason: insertError.message })
    }
    throw new Error(`collection_cases insert failed: ${insertError.message}`)
  }
  let row = normalizeCaseRow(inserted as Record<string, unknown>)

  // Build the request: anything that fails here never reached the provider,
  // so the reservation is released rather than kept as a failed case.
  let request: CollectionsOpenCaseRequest
  let documentId: string
  try {
    const personalNumber =
      ctx.customer?.personalNumber.status === 'valid' ? ctx.customer.personalNumber.digits : null
    const document = await resolveHandoverDocument(db, { companyId, invoiceId: ctx.invoice.id, userId: deps.actor.userId })
    documentId = document.documentId
    request = buildOpenCaseRequest({ caseId: row.id, ctx, startStep, priorPayments, personalNumber, document })
  } catch (err) {
    await db.from('collection_cases').delete().eq('id', row.id).eq('submission_status', 'preparing')
    if (err instanceof HandoverDocumentError) return refusal(err.code)
    throw err
  }

  const { data: submitted, error: submitError } = await db
    .from('collection_cases')
    .update({
      submission_status: 'submitted',
      submission_request: storedSubmission(request, documentId) as unknown as Record<string, unknown>,
      submission_attempts: row.submission_attempts + 1,
    })
    .eq('id', row.id)
    .select('*')
    .single()
  if (submitError) throw new Error(`collection_cases update failed: ${submitError.message}`)
  row = normalizeCaseRow(submitted as Record<string, unknown>)

  const result = await submitCase({ ...deps, now, userId: deps.actor.userId }, row, connection, request)
  if (result.registered) {
    try {
      await eventBus.emit({
        type: 'collection.case_opened',
        payload: {
          caseId: result.case.id,
          invoiceId: result.case.invoice_id,
          stage: result.case.stage,
          origin: result.case.origin,
          companyId,
          userId: deps.actor.userId,
        },
      })
    } catch {
      // The case is registered; a subscriber's failure does not undo it.
    }
  }
  if (result.error && result.case.submission_status === 'failed') {
    return { ok: false, code: result.error.code, status: 422, upstream: result.error }
  }
  return { ok: true, case: result.case, registered: result.registered }
}

/**
 * Repeat a submitted case's request exactly (the sync cron, "Uppdatera
 * status"): Connect answers a finished request with its first result and
 * resumes an interrupted one, so a retry never creates a second case. The
 * personnummer is read again from the customer, and the archived PDF is
 * re-read and checked against the hash that was sent.
 */
export async function retrySubmittedCase(
  deps: Pick<CollectionsServiceDeps, 'db' | 'adapterFor' | 'log'> & { now?: () => Date },
  caseId: string,
): Promise<{ case: CollectionCaseRow; registered: boolean; error?: CollectionsError } | null> {
  const now = deps.now ? deps.now() : new Date()
  const row = await loadCaseById(deps.db, null, caseId)
  if (!row || row.submission_status !== 'submitted' || !row.submission_request) return null
  const stored = row.submission_request as unknown as StoredSubmission
  const connection = await loadConnectionById(deps.db, row.company_id, row.connection_id)
  if (!connection) return null

  let personalNumber: string | null = null
  if (stored.personalNumberSent) {
    const { data, error } = await deps.db
      .from('customers')
      .select('id, personal_number')
      .eq('company_id', row.company_id)
      .eq('id', stored.request.debtor.accountingDebtorRef)
      .maybeSingle()
    if (error) throw new Error(`customer lookup failed: ${error.message}`)
    const revealed = revealDebtorPersonalNumber((data as { personal_number: string | null } | null)?.personal_number ?? null, {
      now,
      today: todayIsoStockholm(now),
      purpose: 'collections_handover',
      customerId: stored.request.debtor.accountingDebtorRef,
      userId: null,
      log: deps.log,
    })
    personalNumber = revealed.status === 'valid' ? revealed.digits : null
  }
  const document = await readArchivedDocument(deps.db, row.company_id, stored.documentId, stored.request.document.sha256)
  const request: CollectionsOpenCaseRequest = {
    ...stored.request,
    debtor: { ...stored.request.debtor, personalNumber },
    document: { ...stored.request.document, base64: document.base64 },
  }
  await deps.db
    .from('collection_cases')
    .update({ submission_attempts: row.submission_attempts + 1 })
    .eq('id', row.id)
  const result = await submitCase({ ...deps, companyId: row.company_id, now, userId: null }, row, connection, request)
  if (result.registered && row.opened_by) {
    try {
      await eventBus.emit({
        type: 'collection.case_opened',
        payload: {
          caseId: result.case.id,
          invoiceId: result.case.invoice_id,
          stage: result.case.stage,
          origin: result.case.origin,
          companyId: row.company_id,
          userId: row.opened_by,
        },
      })
    } catch {
      // Registered either way.
    }
  }
  return result
}
