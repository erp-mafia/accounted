/**
 * Attest of supplier invoices: the reads and writes behind every door. The
 * rules are lib/supplier-invoices/attest-policy.ts; this module loads what
 * they read (the policy, the accounting method, the company's active
 * members, the decisions so far), records a decision and sets the invoice's
 * attest marker when the policy is satisfied.
 *
 * Doors: the dashboard (POST /api/supplier-invoices/:id/approve and
 * /reject), v1 (POST .../supplier-invoices/:id/approve), the approved agent
 * operation (approve_supplier_invoice) and the mail's link (/attest/<token>,
 * no login). Each passes who acts and from where; none decides anything.
 *
 * Writes: an approval goes through the database's attest_supplier_invoice
 * (migration 20261030140000), which locks the invoice, applies the rules
 * (policy, limits per person, two attesters from an amount, the key cap),
 * records the approval with what it was judged on and sets the invoice's
 * approved_at/approved_by (the attest marker payments read) only when the
 * policy is met. The database refuses the marker from a session otherwise
 * (guard_supplier_invoice_attest_marker), so no member can set it past the
 * rules. Concurrent approvals of one invoice take turns on the row lock: the
 * last one reads every other, the marker is set once and
 * supplier_invoice.approved is emitted once. A rejection goes to
 * supplier_invoice_attestations as the service role (the trail is append
 * only and no session writes it), after the rules here said yes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { eventBus } from '@/lib/events'
import { getActor } from '@/lib/bookkeeping/actor-context'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'
import type { SupplierInvoice } from '@/types'
import {
  ATTEST_COMMENT_MAX,
  attestLevelsOn,
  attestLimitOf,
  attestProgress,
  invoiceNeedsAttest,
  invoiceTotalSek,
  latestRejection,
  ruleOnApproval,
  sameIdSet,
  ruleOnRejection,
  type AttestationRecord,
  type AttestDecision,
  type AttestInvoiceFacts,
  type AttestLevels,
  type AttestPolicy,
  type AttestProgress,
  type AttestSource,
  type AttestStage,
} from './attest-policy'
import { canApproveSupplierInvoice, resolveUnsettledStatus } from './lifecycle'
import {
  loadAttestBlockedInvoiceIds,
  loadAttestLimits,
  loadAttestPolicy,
  loadAttestSubstitutes,
  loadAttestPolicyWithProjects,
  loadProjectNames,
  loadProjectValues,
  withAttestationStepColumns,
  withProjects,
} from './attest-policy-read'
import { requeueAttestRequest } from './attest-batches'
import { isAttestRole, isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'
import { actorUnattendedCeiling } from '@/lib/bookkeeping/unattended-ceiling'
import { notifyAttestDecisionSafely, type AttestDecisionBatch, type AttestDecisionNotice } from './attest-decision-notify'
import { todayIsoStockholm } from '@/lib/dates/iso'

export { loadAttestBlockedInvoiceIds, loadAttestLimits, loadAttestPolicy, loadAttestSubstitutes }

/** The invoice columns the rules and the decision read. */
const ATTEST_INVOICE_COLUMNS =
  'id, company_id, user_id, status, approved_at, approved_by, due_date, remaining_amount, currency, total, total_sek, exchange_rate, is_credit_note'

type AttestInvoiceRow = AttestInvoiceFacts & {
  id: string
  company_id: string
  status: string
  approved_at: string | null
  approved_by?: string | null
  due_date: string
  remaining_amount: number
}

async function loadAccountingMethod(supabase: SupabaseClient, companyId: string): Promise<string | null> {
  const { data, error } = await supabase.from('company_settings').select('accounting_method').eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return (data as { accounting_method?: string | null } | null)?.accounting_method ?? null
}

/** The company's members whose attest can count, and those of them who keep the books. */
export interface AttestMembers {
  /** isAttestRole (owner, admin, member, viewer): an attester the policy names counts only while in here. */
  attesters: ReadonlySet<string>
  /** isBookkeepingWriterRole (owner, admin, member): an invoice no policy governs is attested or rejected only by them. */
  writers: ReadonlySet<string>
}

/** Who among the company's members may attest, from one read of company_members. */
export async function loadAttestMembers(service: SupabaseClient, companyId: string): Promise<AttestMembers> {
  const { data, error } = await service.from('company_members').select('user_id, role').eq('company_id', companyId)
  if (error) throw error
  const rows = (data ?? []) as Array<{ user_id: string; role: string }>
  return {
    attesters: new Set(rows.filter((m) => isAttestRole(m.role)).map((m) => m.user_id)),
    writers: new Set(rows.filter((m) => isBookkeepingWriterRole(m.role)).map((m) => m.user_id)),
  }
}

/** The company's members whose attest counts where the policy names them (AttestMembers.attesters). */
export async function loadActiveAttestMembers(service: SupabaseClient, companyId: string): Promise<Set<string>> {
  return new Set((await loadAttestMembers(service, companyId)).attesters)
}

/**
 * Who may decide an invoice before the rules do: someone whose attest can
 * count, and for an invoice no policy governs (the ruling is unrestricted)
 * only someone who keeps the books, since that attest is the one click it
 * was before the policy. A viewer decides only where the policy names them.
 * The first checks of the database's supplier_invoice_attest_ruling.
 */
export function deciderRefusal(members: AttestMembers, userId: string, unrestricted: boolean): 'not_member' | 'read_only' | null {
  if (!members.attesters.has(userId)) return 'not_member'
  if (unrestricted && !members.writers.has(userId)) return 'read_only'
  return null
}

interface AttestationRow extends AttestationRecord {
  id: string
  step?: number | null
}

async function loadAttestations(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<AttestationRow[]> {
  return withAttestationStepColumns(async (columns) => {
    const { data, error } = await supabase
      .from('supplier_invoice_attestations')
      .select(columns)
      .eq('company_id', companyId)
      .eq('supplier_invoice_id', invoiceId)
      .order('decided_at', { ascending: true })
    if (error) throw error
    return (data ?? []) as unknown as AttestationRow[]
  })
}


async function loadInvoice(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<AttestInvoiceRow | null> {
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select(ATTEST_INVOICE_COLUMNS)
    .eq('company_id', companyId)
    .eq('id', invoiceId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  const row = data as unknown as AttestInvoiceRow
  return { ...row, total: Number(row.total), remaining_amount: Number(row.remaining_amount) }
}

/**
 * The service-role client a decision is written with. A door that already
 * runs as the service role (v1, the mail's link) passes its own; the
 * dashboard and the approval of a staged operation get a fresh one.
 */
function serviceWriter(writer: SupabaseClient | undefined): SupabaseClient {
  return writer ?? createServiceClient()
}

async function recordDecision(
  service: SupabaseClient,
  companyId: string,
  invoiceId: string,
  userId: string,
  decision: AttestDecision,
  source: AttestSource,
  comment: string | null,
  onBehalfOf: string | null = null,
): Promise<string> {
  // on_behalf_of only when a substitute decides: a row before the column's migration never names it.
  const { data, error } = await service
    .from('supplier_invoice_attestations')
    .insert({ company_id: companyId, supplier_invoice_id: invoiceId, user_id: userId, decision, source, comment, ...(onBehalfOf ? { on_behalf_of: onBehalfOf } : {}) })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('Attest decision not stored')
  return (data as { id: string }).id
}

/** A rejection ends the round: the links still out for the invoice stop working. */
async function consumeOpenLinks(service: SupabaseClient, companyId: string, invoiceId: string): Promise<void> {
  const { error } = await service
    .from('supplier_invoice_attest_links')
    .update({ consumed_at: new Date().toISOString() })
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoiceId)
    .is('consumed_at', null)
  if (error) throw error
}

function normalizeComment(comment: string | null | undefined): string | null {
  const trimmed = (comment ?? '').trim()
  return trimmed ? trimmed.slice(0, ATTEST_COMMENT_MAX) : null
}

export interface ApproveSupplierInvoiceInput extends AttestDecisionInput {
  invoiceId: string
  source: AttestSource
  /** Answer what the approval would do and write nothing (v1 ?dry_run, the agent's staging preview). */
  dryRun?: boolean
  /** The invoice columns to answer; defaults to every column. */
  select?: string
  /** A service-role client the door already holds (see serviceWriter). */
  writer?: SupabaseClient
}

/**
 * How a door tells the registrant about a decision (attest-decision-notify.ts).
 *
 * Without `decisions` the service mails the registrant itself, the moment the
 * decision is stored (an approval only when it completes the attest). A door
 * that decides several invoices in one go (a bulk approval of staged attests,
 * a batch attest page) passes one createAttestDecisionBatch() to every call:
 * the service then adds the answer to it at that same moment instead of
 * mailing, before any later read that could fail, and the door flushes it
 * once, in a finally, so the registrant gets one mail per company and
 * attester and no stored answer is lost.
 */
export interface AttestDecisionInput {
  decisions?: AttestDecisionBatch
}

/** Tell the registrant about a stored decision: into the door's batch, else by mail now. */
async function tellRegistrant(
  service: SupabaseClient,
  companyId: string,
  attesterId: string,
  notice: AttestDecisionNotice,
  decisions: AttestDecisionBatch | undefined,
): Promise<void> {
  if (decisions) decisions.add(companyId, attesterId, notice)
  else await notifyAttestDecisionSafely(service, companyId, attesterId, notice)
}

export interface ApproveSupplierInvoiceResult {
  /** The invoice row after the call, in the door's `select`. */
  invoice: Record<string, unknown>
  /** True when this call set the attest marker (approved_at). */
  approved: boolean
  /** The policy's view after the call; `required` false when the policy does not govern the invoice. */
  attest: AttestProgress
  attestation_id: string | null
}

/**
 * The key an attest comes through, read off the request's commit actor
 * (runWithActor: withApiV1 for every v1 door, with the key's ceiling;
 * commitPendingOperation for an approved agent operation, whose ceiling was
 * priced before the claim). A person in the app, or the mail's link, is no key.
 */
function attestKey(): { viaKey: boolean; keyCeiling: number | null } {
  const actor = getActor()
  const viaKey = actor?.type === 'api_key' || actor?.type === 'mcp_oauth' || actor?.type === 'service_account'
  return { viaKey, keyCeiling: actorUnattendedCeiling(actor) }
}

/** The answer of attest_supplier_invoice (migrations 20261030140000, 20261108180000: stage and on_behalf_of). */
type AttestRpcAnswer =
  | { ok: true; approved: boolean; attestation_id: string; status: string; approved_at?: string | null; stage?: AttestStage | null; on_behalf_of?: string | null }
  | {
      ok: false
      code: string
      reason?: string
      current_status?: string
      limit_sek?: number | null
      amount_sek?: number | null
    }

/** A refusal of the rules (or of the database's ruling) as the doors answer it. */
function refusalOutcome(refusal: { code: string; reason?: string; limit_sek?: number | null; amount_sek?: number | null }): OperationOutcome<never> {
  switch (refusal.code) {
    case 'FORBIDDEN':
      return refusal.reason === 'read_only'
        ? {
            ok: false,
            code: 'FORBIDDEN',
            messageSv: 'Med läsbehörighet kan du bara attestera fakturor som attestreglerna ber dig attestera.',
            details: { reason: 'read_only' },
          }
        : {
            ok: false,
            code: 'FORBIDDEN',
            messageSv: 'Bara den som för företagets bokföring, eller som attestreglerna gör till attestant, kan attestera leverantörsfakturor.',
            details: { reason: 'not_member' },
          }
    case 'ATTEST_NOT_ALLOWED':
      return refusal.reason === 'other_step'
        ? {
            ok: false,
            code: 'ATTEST_NOT_ALLOWED',
            messageSv: 'Fakturan väntar på ett annat atteststeg: förattesten först, sedan attesten.',
            details: { reason: refusal.reason },
          }
        : { ok: false, code: 'ATTEST_NOT_ALLOWED', details: { reason: refusal.reason } }
    case 'ATTEST_LIMIT_EXCEEDED':
      return {
        ok: false,
        code: 'ATTEST_LIMIT_EXCEEDED',
        details: { reason: refusal.reason, limit_sek: refusal.limit_sek ?? null, amount_sek: refusal.amount_sek ?? null },
      }
    default:
      return { ok: false, code: refusal.code }
  }
}

/**
 * Approve (attest) a supplier invoice as `ctx.userId`. Without a policy that
 * governs the invoice this is the approval it has always been, now with a
 * row in the trail. Under the policy the decision is refused for anyone who
 * may not attest (ATTEST_NOT_ALLOWED), already did in this round
 * (ATTEST_ALREADY_GIVEN) or whose limit cannot count toward the invoice
 * (ATTEST_LIMIT_EXCEEDED); an allowed one is recorded, and approved_at is set
 * once the policy is satisfied.
 *
 * The database decides and writes: attest_supplier_invoice locks the
 * invoice, applies the rules, records the approval and sets the marker.
 * Every door (the dashboard, v1, the approved agent operation, the mail's
 * links) calls it as the service role and names the attester, the source and
 * the key; the dashboard names the signed-in user, since a viewer's own
 * session could not set the marker (the writer-role trigger, crm#1569). A
 * dry run reads the same rules in TypeScript (attest-policy.ts).
 */
export async function approveSupplierInvoice(
  ctx: OperationContext,
  input: ApproveSupplierInvoiceInput,
): Promise<OperationOutcome<ApproveSupplierInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx
  const invoice = await loadInvoice(supabase, companyId, input.invoiceId)
  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  // 'overdue' is approvable: the daily cron puts unbooked invoices there just
  // by aging (#1206). approved_at, not the status, makes approval idempotent.
  if (!canApproveSupplierInvoice(invoice)) {
    return { ok: false, code: 'SI_APPROVE_NOT_REGISTERED', details: { current_status: invoice.status } }
  }
  // An attest releases the invoice for payment: an API key attests nothing
  // above its unattended ceiling (lib/bookkeeping/unattended-ceiling.ts), its
  // dry run included. Priced in SEK; a foreign invoice without a SEK value
  // cannot be priced and waits for a person, as the attest policy treats it.
  // A credit note releases nothing.
  const ceiling = actorUnattendedCeiling()
  if (ceiling !== null && !invoice.is_credit_note) {
    const totalSek = invoiceTotalSek(invoice)
    const attempted = totalSek === null ? null : roundOre(totalSek)
    if (attempted === null || attempted > ceiling) {
      return {
        ok: false,
        code: 'UNATTENDED_COMMIT_LIMIT_EXCEEDED',
        details: { attempted, limit: ceiling, ...(attempted === null ? { reason: 'sek_total_unknown' } : {}) },
      }
    }
  }

  const service = serviceWriter(input.writer)
  const key = attestKey()
  const selectColumns = input.select ?? '*'

  if (input.dryRun) {
    const [{ policy, projects }, accountingMethod, attestations, members, limits] = await Promise.all([
      loadAttestPolicyWithProjects(supabase, companyId, [invoice.id]),
      loadAccountingMethod(supabase, companyId),
      loadAttestations(supabase, companyId, invoice.id),
      loadAttestMembers(service, companyId),
      loadAttestLimits(supabase, companyId),
    ])
    // In the database's order: a member whose attest can count, the rules, then keeping the books where no policy governs.
    if (deciderRefusal(members, userId, false)) return refusalOutcome({ code: 'FORBIDDEN', reason: 'not_member' })
    const facts = withProjects(invoice, projects)
    const ruling = ruleOnApproval(policy, accountingMethod, facts, attestations, userId, policy.enabled ? members.attesters : undefined, {
      limits,
      ...key,
    })
    if (ruling.kind === 'refused') return refusalOutcome(ruling)
    const gate = deciderRefusal(members, userId, ruling.kind === 'unrestricted')
    if (gate) return refusalOutcome({ code: 'FORBIDDEN', reason: gate })
    const setsMarker = ruling.kind === 'unrestricted' || ruling.satisfies
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        status: setsMarker ? resolveUnsettledStatus({ ...invoice, approved_at: 'now' }, todayIsoStockholm()) : invoice.status,
        attest_required: ruling.kind === 'record',
        completes_attest: setsMarker,
        attest_remaining_user_ids: ruling.kind === 'record' ? ruling.remainingAfter : [],
        ...(ruling.kind === 'record' ? { attest_step: ruling.step, attest_limit_sek: ruling.limitSek } : {}),
        ...(ruling.kind === 'record' && ruling.stage ? { attest_stage: ruling.stage } : {}),
        ...(ruling.kind === 'record' && ruling.onBehalfOf ? { attest_on_behalf_of: ruling.onBehalfOf } : {}),
      },
    }
  }

  // Every door names the attester as the service role, the dashboard too: the
  // approval that completes the attest sets the invoice's marker, and the
  // writer-role trigger on supplier_invoices refuses that UPDATE from a
  // viewer's own session (crm#1569). The ruling inside the function decides
  // who may attest; the actor header keeps the audit log on the signed-in user.
  const { data, error } = await service.rpc('attest_supplier_invoice', {
    p_company_id: companyId,
    p_invoice_id: invoice.id,
    p_user_id: userId,
    p_source: input.source,
    p_via_key: key.viaKey,
    p_key_ceiling: key.keyCeiling,
  })
  if (error || !data) {
    log.error('supplier invoice attest failed', error ?? new Error('attest_supplier_invoice answered nothing'), { invoiceId: invoice.id })
    return { ok: false, code: 'SI_APPROVE_UPDATE_FAILED' }
  }
  const answer = data as AttestRpcAnswer
  if (!answer.ok) {
    if (answer.code === 'SI_APPROVE_NOT_REGISTERED') {
      // Read pending above: another approval (or a status change) landed first.
      return { ok: false, code: 'SI_APPROVE_NOT_REGISTERED', details: { current_status: answer.current_status, reason: 'race' } }
    }
    return refusalOutcome(answer)
  }

  // The attest is stored. A door's batch takes the answer now, before any
  // read below can fail (AttestDecisionInput); the direct mail waits until
  // the event is out, so a slow mail provider never holds the event up.
  const approvedNotice = { invoiceId: invoice.id, decision: 'approved' as const, comment: null }
  if (answer.approved && input.decisions) {
    await tellRegistrant(service, companyId, userId, approvedNotice, input.decisions)
  }

  // The attest is committed: the event goes out whatever the reads below
  // answer, else a failed read would lose it and a retry finds the invoice attested.
  const current = await readInvoiceRow(supabase, companyId, invoice.id, selectColumns).catch((error) => {
    log.warn('attested invoice not read back; answering what the attest returned', {
      invoiceId: invoice.id,
      message: error instanceof Error ? error.message : String(error),
    })
    return {
      ...invoice,
      status: answer.status,
      ...(answer.approved ? { approved_at: answer.approved_at ?? null, approved_by: userId } : {}),
    } as Record<string, unknown>
  })
  if (answer.approved) {
    try {
      await eventBus.emit({
        type: 'supplier_invoice.approved',
        payload: { supplierInvoice: current as unknown as SupplierInvoice, companyId, userId },
      })
    } catch (error) {
      log.warn('supplier_invoice.approved emit failed', error as Error)
    }
    // After the event and before the reads below, which can throw.
    if (!input.decisions) await tellRegistrant(service, companyId, userId, approvedNotice, undefined)
  }
  const [{ policy, projects }, accountingMethod, attestations, members, limits] = await Promise.all([
    loadAttestPolicyWithProjects(supabase, companyId, [invoice.id]),
    loadAccountingMethod(supabase, companyId),
    loadAttestations(supabase, companyId, invoice.id),
    loadActiveAttestMembers(service, companyId),
    loadAttestLimits(supabase, companyId),
  ])
  const facts = withProjects(invoice, projects)
  const attest = attestProgress(policy, accountingMethod, facts, attestations, policy.enabled ? members : undefined, limits)
  // This förattest completed the last group: the attesters are asked now, in a round of their own.
  if (answer.stage === 'pre' && !answer.approved && attest.stage === 'final') {
    await requeueAttestRequest(service, companyId, invoice.id).catch((error) =>
      log.warn('attest request not queued after the förattest; Att göra still asks', {
        invoiceId: invoice.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    )
  }
  return {
    ok: true,
    data: {
      invoice: current,
      approved: answer.approved,
      attest,
      attestation_id: answer.attestation_id,
    },
  }
}

async function readInvoiceRow(supabase: SupabaseClient, companyId: string, invoiceId: string, select: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from('supplier_invoices').select(select).eq('company_id', companyId).eq('id', invoiceId).maybeSingle()
  if (error) throw error
  return (data ?? {}) as Record<string, unknown>
}

/**
 * The limit an API key or agent attest of the invoice is capped by, beyond
 * the key's own ceiling: the person's attest limit, when levels are on and
 * the policy governs the invoice; null otherwise. commitPendingOperation asks
 * it before claiming a staged approve_supplier_invoice, so an attest over the
 * lower of the two stays pending for a person instead of failing inside the
 * claim. A failed read answers null: the database's own ruling still caps
 * the attest when it runs.
 */
export async function personalAttestCap(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoiceId: string,
): Promise<number | null> {
  try {
    const [invoice, policy, accountingMethod, limits] = await Promise.all([
      loadInvoice(supabase, companyId, invoiceId),
      loadAttestPolicy(supabase, companyId),
      loadAccountingMethod(supabase, companyId),
      loadAttestLimits(supabase, companyId),
    ])
    if (!invoice || !invoiceNeedsAttest(policy, accountingMethod, invoice) || !attestLevelsOn(policy, limits)) return null
    // A substitute attests with the limit of the attester they stand in for;
    // which one the database decides under the lock, so this answers the
    // person's own (the ruling still caps the attest when it runs).
    return attestLimitOf(limits, userId)
  } catch {
    // Safe to answer no cap: the dispatch runs attest_supplier_invoice, whose
    // ruling applies the same cap under the invoice lock and refuses there.
    return null
  }
}

export interface RejectSupplierInvoiceResult {
  supplier_invoice_id: string
  attestation_id: string
  status: string
}

/**
 * Reject (neka) the attest of a supplier invoice that waits for it. The
 * decision and its comment go to the trail and the round starts over: the
 * approvals given so far no longer count, and the links still out for the
 * invoice stop working. The invoice stays registered (or overdue, when its
 * due date has passed); nothing about it is paid or booked.
 */
export async function rejectSupplierInvoice(
  ctx: OperationContext,
  input: AttestDecisionInput & {
    invoiceId: string
    comment?: string | null
    source: AttestSource
    writer?: SupabaseClient
    dryRun?: boolean
  },
): Promise<OperationOutcome<RejectSupplierInvoiceResult>> {
  const { supabase, companyId, userId } = ctx
  const invoice = await loadInvoice(supabase, companyId, input.invoiceId)
  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  if (!canApproveSupplierInvoice(invoice)) {
    return { ok: false, code: 'ATTEST_NOT_PENDING', details: { current_status: invoice.status } }
  }
  const service = serviceWriter(input.writer)
  const [{ policy, projects }, accountingMethod, members] = await Promise.all([
    loadAttestPolicyWithProjects(supabase, companyId, [invoice.id]),
    loadAccountingMethod(supabase, companyId),
    loadAttestMembers(service, companyId),
  ])
  const facts = withProjects(invoice, projects)
  const ruling = ruleOnRejection(policy, accountingMethod, facts, userId, policy.enabled ? members.attesters : undefined)
  if (ruling.kind === 'refused') return { ok: false, code: ruling.code, details: { reason: ruling.reason } }
  // Neka is decided like Attestera: without a governing policy, only by someone who keeps the books.
  const gate = deciderRefusal(members, userId, ruling.kind === 'unrestricted')
  if (gate) return refusalOutcome({ code: 'FORBIDDEN', reason: gate })
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        status: resolveUnsettledStatus({ ...invoice, approved_at: null }, todayIsoStockholm()),
        comment: normalizeComment(input.comment),
        restarts_attest_round: ruling.kind === 'record',
      },
    }
  }

  const comment = normalizeComment(input.comment)
  const onBehalfOf = ruling.kind === 'record' ? (ruling.onBehalfOf ?? null) : null
  const attestationId = await recordDecision(service, companyId, invoice.id, userId, 'rejected', input.source, comment, onBehalfOf)
  // The rejection is stored and ends the round. The other attesters' open
  // links close first, so none approves the invoice while the mail is sent;
  // whoever registered it still hears that it will not be paid, and why,
  // when closing them fails.
  if (ruling.kind === 'record') {
    try {
      await consumeOpenLinks(service, companyId, invoice.id)
    } finally {
      await tellRegistrant(service, companyId, userId, { invoiceId: invoice.id, decision: 'rejected', comment }, input.decisions)
    }
  } else {
    await consumeOpenLinks(service, companyId, invoice.id)
  }
  return {
    ok: true,
    data: {
      supplier_invoice_id: invoice.id,
      attestation_id: attestationId,
      status: resolveUnsettledStatus({ ...invoice, approved_at: null }, todayIsoStockholm()),
    },
  }
}

export interface AttestPerson {
  user_id: string
  name: string | null
  email: string | null
}

/** Someone whose approval would move the invoice on, with their limit in SEK (null = no limit). */
export interface AttestCandidatePerson extends AttestPerson {
  limit_sek: number | null
  /** A substitute: the attester they stand in for today, whose limit applies. Null for the attester in their own name. */
  stands_in_for: AttestPerson | null
}

/** A förattest the invoice needs: for a project (null: lines without a project of their own), done or by whom it may come. */
export interface AttestPreGroupView {
  project: string | null
  /** The project's name in the dimension register; null when it has none. */
  project_name: string | null
  done: boolean
  /** Who gave it this round (the attester it counts for); null while missing. */
  approved_by: AttestPerson | null
  /** Who may give it, while it is missing. */
  attesters: AttestPerson[]
}

export interface SupplierInvoiceAttestState {
  supplier_invoice_id: string
  policy: {
    enabled: boolean
    mode: 'any' | 'all'
    threshold_amount: number | null
    preparer_may_attest: boolean
    two_step_from_sek: number | null
  }
  required: boolean
  satisfied: boolean
  blocked: boolean
  approved_at: string | null
  approved_by: AttestPerson | null
  approved: AttestPerson[]
  /** Who may give a missing approval, with their limits (attestProgress.remaining). */
  remaining: AttestCandidatePerson[]
  /** The invoice's total in SEK the levels judge; null when a foreign invoice has no rate. */
  amount_sek: number | null
  /** How many different attesters the invoice needs. */
  steps: 1 | 2
  /** How many more approvals it needs; 0 once attested. */
  approvals_needed: number
  /** One of them must come from someone whose limit covers amount_sek. */
  needs_covering: boolean
  /** With förattest (#192): 'pre' while a förattest is missing, 'final' once the attest is what is left; null without förattest or once attested. */
  stage: AttestStage | null
  /** The förattests the invoice needs, in order; empty without förattest. */
  pre_attest: AttestPreGroupView[]
  /** The attester the caller would approve for, as their substitute (viewer.acts_for); null in their own name. */
  acts_for: AttestPerson | null
  latest_rejection: { user: AttestPerson; comment: string | null; decided_at: string } | null
  attestations: Array<{
    attestation_id: string
    user: AttestPerson
    decision: AttestDecision
    comment: string | null
    source: AttestSource
    decided_at: string
    /** The approval's place in its round under the policy; null otherwise. */
    step: number | null
    /** The step it was given in: 'pre' (förattest) or 'final'; null for a rejection and older rows. */
    stage: AttestStage | null
    /** The attester a substitute decided for; null when the person decided in their own name. */
    on_behalf_of: AttestPerson | null
  }>
  /** What the caller may do now. */
  viewer: { may_approve: boolean; may_reject: boolean; reason: string | null }
}

/** Names and addresses of company people, read as the service role (profiles are private to their owner under RLS). */
export async function loadAttestPeople(service: SupabaseClient, userIds: string[]): Promise<Map<string, AttestPerson>> {
  const ids = [...new Set(userIds)].filter(Boolean)
  const people = new Map<string, AttestPerson>()
  if (ids.length === 0) return people
  const { data, error } = await service.from('profiles').select('id, email, full_name').in('id', ids)
  if (error) throw error
  for (const row of (data ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>) {
    people.set(row.id, { user_id: row.id, name: row.full_name?.trim() || null, email: row.email })
  }
  for (const id of ids) if (!people.has(id)) people.set(id, { user_id: id, name: null, email: null })
  return people
}

export interface AttestViewer {
  may_approve: boolean
  may_reject: boolean
  /** Why not, when the person may not decide: already_approved, not_pending, already_given, not_member, read_only, or the rules' reason (other_step: the invoice is at a step that is not theirs). */
  reason: string | null
  /** The attester the person would approve for, as their substitute (#192); left out when they approve in their own name. */
  acts_for?: string
}

/**
 * What `userId` may do with the invoice now: approve, reject, or why
 * neither. The invoice page and both mail link pages read it, so a page
 * never offers a decision the service would refuse. `members` are the
 * company's members whose attest can count and those who keep the books
 * (deciderRefusal); `levels` the limits and the key the decision would come
 * through.
 */
export function attestViewerOf(
  policy: AttestPolicy,
  accountingMethod: string | null,
  invoice: AttestInvoiceFacts & { status: string; approved_at: string | null },
  attestations: readonly AttestationRecord[],
  userId: string,
  members: AttestMembers,
  levels: AttestLevels,
): AttestViewer {
  const activeMembers = policy.enabled ? members.attesters : undefined
  const pending = canApproveSupplierInvoice(invoice)
  const approval = pending ? ruleOnApproval(policy, accountingMethod, invoice, attestations, userId, activeMembers, levels) : null
  const rejection = pending ? ruleOnRejection(policy, accountingMethod, invoice, userId, activeMembers) : null
  const approvalGate = deciderRefusal(members, userId, approval?.kind === 'unrestricted')
  const rejectionGate = deciderRefusal(members, userId, rejection?.kind === 'unrestricted')
  const reason = !pending
    ? invoice.approved_at
      ? 'already_approved'
      : 'not_pending'
    : approval?.kind === 'refused'
      ? approval.code === 'ATTEST_ALREADY_GIVEN'
        ? 'already_given'
        : approval.reason
      : approvalGate
  const mayApprove = !!approval && approval.kind !== 'refused' && approvalGate === null
  const actsFor = mayApprove && approval?.kind === 'record' ? approval.onBehalfOf : undefined
  return {
    may_approve: mayApprove,
    may_reject: !!rejection && rejection.kind !== 'refused' && rejectionGate === null,
    reason,
    ...(actsFor ? { acts_for: actsFor } : {}),
  }
}

/**
 * Where the attest of one invoice stands, for the invoice page, the mail's
 * link page and GET .../supplier-invoices/:id/attestations: the policy as it
 * applies, who approved, who is left, the latest rejection with its comment,
 * the whole trail, and what the caller may do.
 */
export async function getSupplierInvoiceAttestState(
  ctx: OperationContext,
  invoiceId: string,
  options: { writer?: SupabaseClient } = {},
): Promise<OperationOutcome<SupplierInvoiceAttestState>> {
  const { supabase, companyId, userId } = ctx
  const loaded = await loadInvoice(supabase, companyId, invoiceId)
  if (!loaded) return { ok: false, code: 'SI_NOT_FOUND' }
  const service = serviceWriter(options.writer)
  const [{ policy, projects }, accountingMethod, attestations, members, limits] = await Promise.all([
    loadAttestPolicyWithProjects(supabase, companyId, [loaded.id]),
    loadAccountingMethod(supabase, companyId),
    loadAttestations(supabase, companyId, loaded.id),
    loadAttestMembers(service, companyId),
    loadAttestLimits(supabase, companyId),
  ])
  const invoice = withProjects(loaded, projects)
  const activeMembers = policy.enabled ? members.attesters : undefined
  const progress = attestProgress(policy, accountingMethod, invoice, attestations, activeMembers, limits)
  const standIns = progress.stand_ins ?? []
  const preGroups = progress.pre_groups ?? []
  const viewer = attestViewerOf(policy, accountingMethod, invoice, attestations, userId, members, { limits, ...attestKey() })
  const [people, projectNames] = await Promise.all([
    loadAttestPeople(service, [
      ...(viewer.acts_for ? [viewer.acts_for] : []),
      ...attestations.flatMap((a) => [a.user_id, ...(a.on_behalf_of ? [a.on_behalf_of] : [])]),
      ...progress.remaining,
      ...standIns.map((s) => s.user_id),
      ...preGroups.flatMap((g) => g.eligible),
      ...(progress.pre_approved_by ?? []),
      ...(invoice.approved_by ? [invoice.approved_by] : []),
    ]),
    loadProjectNames(supabase, companyId, preGroups.map((g) => g.project).filter((p): p is string => p !== null)).catch(
      // The names only label the förattest: a failed read shows the codes.
      () => new Map<string, string>(),
    ),
  ])
  const person = (id: string): AttestPerson => people.get(id) ?? { user_id: id, name: null, email: null }

  const rejected = latestRejection(attestations)
  const attested = !!invoice.approved_at

  return {
    ok: true,
    data: {
      supplier_invoice_id: invoice.id,
      policy: {
        enabled: policy.enabled,
        mode: policy.mode,
        threshold_amount: policy.threshold_amount,
        preparer_may_attest: policy.preparer_may_attest,
        two_step_from_sek: policy.two_step_from_sek,
      },
      required: progress.required,
      satisfied: attested || progress.satisfied,
      blocked: progress.blocked && !attested,
      approved_at: invoice.approved_at,
      approved_by: invoice.approved_by ? person(invoice.approved_by) : null,
      approved: progress.approved_by.map(person),
      remaining: attested
        ? []
        : [
            ...progress.remaining.map((id) => ({ ...person(id), limit_sek: attestLimitOf(limits, id), stands_in_for: null })),
            ...standIns.map((s) => ({ ...person(s.user_id), limit_sek: attestLimitOf(limits, s.for_user_id), stands_in_for: person(s.for_user_id) })),
          ],
      amount_sek: progress.amount_sek,
      steps: progress.steps,
      approvals_needed: attested ? 0 : progress.approvals_needed,
      needs_covering: !attested && progress.needs_covering,
      stage: attested ? null : (progress.stage ?? null),
      pre_attest: preGroups.map((g) => ({
        project: g.project,
        project_name: g.project ? (projectNames.get(g.project) ?? null) : null,
        done: g.done,
        approved_by: g.approved_by ? person(g.approved_by) : null,
        attesters: g.done ? [] : g.eligible.map(person),
      })),
      acts_for: viewer.acts_for ? person(viewer.acts_for) : null,
      latest_rejection: rejected ? { user: person(rejected.user_id), comment: rejected.comment ?? null, decided_at: rejected.decided_at } : null,
      attestations: (attestations as AttestationRow[]).map((a) => ({
        attestation_id: a.id,
        user: person(a.user_id),
        decision: a.decision,
        comment: a.comment ?? null,
        source: a.source ?? 'app',
        decided_at: a.decided_at,
        step: a.step ?? null,
        stage: a.stage ?? null,
        on_behalf_of: a.on_behalf_of ? person(a.on_behalf_of) : null,
      })),
      viewer,
    },
  }
}

export interface AttestPolicyInput {
  enabled: boolean
  threshold_amount: number | null
  mode: 'any' | 'all'
  attesters: string[]
  preparer_may_attest: boolean
  /** Two attesters from this amount in SEK; null = never. Left out: as it is. */
  two_step_from_sek?: number | null
  /** The attesters' limits in SEK (null = no limit); replaces every limit. Left out: as they are. */
  limits?: Array<{ user_id: string; max_amount_sek: number | null }>
  /** Förattest for invoices (and lines) without a project of their own in project_attesters; empty = none. Left out: as it is. */
  pre_attesters?: string[]
  /** Förattest per project (dimension 6 code); replaces every project's. Left out: as they are. */
  project_attesters?: Array<{ project: string; attesters: string[] }>
}


/** The förattest per project as the database keeps it ({code: [ids]}), one entry per project, the attesters deduplicated. */
function projectAttestersOf(input: AttestPolicyInput['project_attesters']): Record<string, string[]> | null {
  if (!input) return null
  const out: Record<string, string[]> = {}
  for (const route of input) {
    const code = route.project.trim()
    const ids = [...new Set([...(out[code] ?? []), ...route.attesters])]
    if (ids.length > 0) out[code] = ids
  }
  return out
}

function sameProjectAttesters(a: Readonly<Record<string, readonly string[]>>, b: Readonly<Record<string, readonly string[]>>): boolean {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((code) => !!b[code] && sameIdSet(a[code]!, b[code]!))
}

/**
 * Save the company's attest policy, the attesters' limits and the förattest,
 * in one transaction (save_company_attest_policy). Owners and admins only:
 * the session door gates with requireAdmin and the RLS policies, a
 * service-role door passes `checkAdmin` (lib/operations/access.ts does the
 * asking). Every attester and förattestant must be a member whose attest can
 * count (isAttestRole: one who keeps the books, or a viewer); a policy that
 * is on needs at least one attester, and two from a two-step amount. A limit
 * is for an attester. A project named for förattest must be one of the
 * company's projects (dimension 6).
 *
 * The förattest goes to the database only when it changes: a save from
 * before migration 20261108180000 reached the database (none named, none
 * saved) calls the function as it was, so the policy can be saved while the
 * deploy waits for its migration.
 */
export async function saveAttestPolicy(
  ctx: OperationContext,
  input: AttestPolicyInput,
  options: { dryRun?: boolean; writer?: SupabaseClient } = {},
): Promise<OperationOutcome<AttestPolicy>> {
  const attesters = [...new Set(input.attesters)]
  if (input.enabled && attesters.length === 0) {
    return { ok: false, code: 'ATTEST_POLICY_NO_ATTESTERS' }
  }
  const preAttesters = input.pre_attesters ? [...new Set(input.pre_attesters)] : null
  const projectAttesters = projectAttestersOf(input.project_attesters)
  const codes = Object.keys(projectAttesters ?? {})
  const [members, projectValues, current] = await Promise.all([
    loadActiveAttestMembers(serviceWriter(options.writer), ctx.companyId),
    loadProjectValues(ctx.supabase, ctx.companyId, codes),
    input.two_step_from_sek === undefined || preAttesters || projectAttesters ? loadAttestPolicy(ctx.supabase, ctx.companyId) : null,
  ])
  const named = [...attesters, ...(preAttesters ?? []), ...Object.values(projectAttesters ?? {}).flat()]
  const outsiders = [...new Set(named.filter((id) => !members.has(id)))]
  if (outsiders.length > 0) {
    return { ok: false, code: 'ATTEST_POLICY_ATTESTER_NOT_MEMBER', details: { user_ids: outsiders } }
  }
  const known = new Set(projectValues.map((v) => v.code))
  const unknown = codes.filter((code) => !known.has(code))
  if (unknown.length > 0) return { ok: false, code: 'ATTEST_PROJECT_NOT_FOUND', details: { projects: unknown } }
  const twoStep =
    input.two_step_from_sek === undefined
      ? current!.two_step_from_sek
      : input.two_step_from_sek === null
        ? null
        : roundOre(input.two_step_from_sek)
  if (input.enabled && twoStep !== null && attesters.length < 2) {
    return { ok: false, code: 'ATTEST_POLICY_TWO_STEP_NEEDS_TWO' }
  }
  // One limit per person, the last one given.
  const limits = input.limits
    ? [...new Map(input.limits.map((l) => [l.user_id, l.max_amount_sek === null ? null : roundOre(l.max_amount_sek)])).entries()].map(
        ([user_id, max_amount_sek]) => ({ user_id, max_amount_sek }),
      )
    : null
  const strangers = (limits ?? []).filter((l) => !attesters.includes(l.user_id)).map((l) => l.user_id)
  if (strangers.length > 0) {
    return { ok: false, code: 'ATTEST_LIMIT_NOT_ATTESTER', details: { user_ids: strangers } }
  }
  const row = {
    company_id: ctx.companyId,
    enabled: input.enabled,
    threshold_amount: input.threshold_amount === null ? null : roundOre(input.threshold_amount),
    mode: input.mode,
    attesters,
    preparer_may_attest: input.preparer_may_attest,
    two_step_from_sek: twoStep,
    updated_by: ctx.userId,
  }
  const steps = {
    ...(preAttesters ? { pre_attesters: preAttesters } : {}),
    ...(projectAttesters ? { project_attesters: Object.entries(projectAttesters).map(([project, ids]) => ({ project, attesters: ids })) } : {}),
  }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { ...row, ...(limits ? { limits } : {}), ...steps } }
  const changesPre = preAttesters !== null && !sameIdSet(preAttesters, current?.pre_attesters ?? [])
  const changesProjects = projectAttesters !== null && !sameProjectAttesters(projectAttesters, current?.project_attesters ?? {})
  const writer = options.writer ?? ctx.supabase
  const { error } = await writer.rpc('save_company_attest_policy', {
    p_company_id: row.company_id,
    p_enabled: row.enabled,
    p_threshold_amount: row.threshold_amount,
    p_mode: row.mode,
    p_attesters: row.attesters,
    p_preparer_may_attest: row.preparer_may_attest,
    p_two_step_from_sek: row.two_step_from_sek,
    p_limits: limits,
    p_updated_by: row.updated_by,
    ...(changesPre ? { p_pre_attesters: preAttesters } : {}),
    ...(changesProjects ? { p_project_attesters: projectAttesters } : {}),
  })
  // A session that is not an owner or admin meets the RLS policies.
  if (error?.code === '42501') {
    return { ok: false, code: 'FORBIDDEN', messageSv: 'Bara företagets ägare eller en administratör kan ändra attestreglerna.' }
  }
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
  return { ok: true, data: await loadAttestPolicy(ctx.supabase, ctx.companyId) }
}

const SUBSTITUTE_ADD_FORBIDDEN = 'Du kan bara välja ersättare för dig själv. Ägare och administratörer väljer för andra.'
const SUBSTITUTE_REMOVE_FORBIDDEN = 'Du kan bara ta bort dina egna ersättare. Ägare och administratörer tar bort andras.'

export interface AttestSubstituteInput {
  /** The attester who is away. */
  user_id: string
  /** Who attests in their place. */
  substitute_user_id: string
  /** Stockholm dates, both included. */
  starts_on: string
  ends_on: string
}

/**
 * Name a substitute: while the period runs, `substitute_user_id` attests
 * wherever `user_id` may, as them (attest-policy.ts). An owner or admin names
 * one for anyone; anyone else only their own. Both must be members whose
 * attest can count. The session door is held to the same by the RLS
 * policies; a service-role door (v1) is held by `isAdmin` here.
 */
export async function addAttestSubstitute(
  ctx: OperationContext,
  input: AttestSubstituteInput,
  options: { isAdmin: boolean; dryRun?: boolean; writer?: SupabaseClient },
): Promise<OperationOutcome<AttestSubstituteInput & { id: string }>> {
  if (!options.isAdmin && input.user_id !== ctx.userId) return { ok: false, code: 'FORBIDDEN', messageSv: SUBSTITUTE_ADD_FORBIDDEN }
  if (input.ends_on < todayIsoStockholm()) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Perioden har redan tagit slut.', details: { field: 'ends_on' } }
  }
  const members = await loadActiveAttestMembers(serviceWriter(options.writer), ctx.companyId)
  const outsiders = [input.user_id, input.substitute_user_id].filter((id) => !members.has(id))
  if (outsiders.length > 0) return { ok: false, code: 'ATTEST_SUBSTITUTE_NOT_MEMBER', details: { user_ids: outsiders } }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { company_id: ctx.companyId, ...input } }
  const writer = options.writer ?? ctx.supabase
  const { data, error } = await writer.rpc('add_company_attest_substitute', {
    p_company_id: ctx.companyId,
    p_user_id: input.user_id,
    p_substitute_user_id: input.substitute_user_id,
    p_starts_on: input.starts_on,
    p_ends_on: input.ends_on,
    p_actor: ctx.userId,
  })
  if (error?.code === '42501') return { ok: false, code: 'FORBIDDEN', messageSv: SUBSTITUTE_ADD_FORBIDDEN }
  // The substitutes key on the policy row: a company that never saved attest rules has nobody to stand in for.
  if (error?.code === '23503') return { ok: false, code: 'ATTEST_SUBSTITUTE_NO_POLICY' }
  // The table's own checks (someone else, a period of at most a year); the doors' schema says the same first.
  if (error?.code === '23514') {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Välj någon annan som ersättare, för en period på högst ett år.' }
  }
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
  return { ok: true, data: { id: data as string, ...input } }
}

/**
 * Remove a substitute, ending it at once. An owner or admin removes any; the
 * attester who is away removes their own.
 */
export async function removeAttestSubstitute(
  ctx: OperationContext,
  substituteId: string,
  options: { isAdmin: boolean; dryRun?: boolean; writer?: SupabaseClient },
): Promise<OperationOutcome<{ id: string; removed: true }>> {
  const { data: existing, error: readError } = await ctx.supabase
    .from('company_attest_substitutes')
    .select('id, user_id')
    .eq('company_id', ctx.companyId)
    .eq('id', substituteId)
    .maybeSingle()
  if (readError) return { ok: false, code: 'INTERNAL_ERROR', error: readError }
  const row = existing as { id: string; user_id: string } | null
  if (!row) return { ok: false, code: 'ATTEST_SUBSTITUTE_NOT_FOUND' }
  if (!options.isAdmin && row.user_id !== ctx.userId) return { ok: false, code: 'FORBIDDEN', messageSv: SUBSTITUTE_REMOVE_FORBIDDEN }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { id: row.id, removed: true } }
  const writer = options.writer ?? ctx.supabase
  const { data, error } = await writer.rpc('remove_company_attest_substitute', { p_company_id: ctx.companyId, p_id: row.id, p_actor: ctx.userId })
  if (error?.code === '42501') return { ok: false, code: 'FORBIDDEN', messageSv: SUBSTITUTE_REMOVE_FORBIDDEN }
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
  if (data !== true) return { ok: false, code: 'ATTEST_SUBSTITUTE_NOT_FOUND' }
  return { ok: true, data: { id: row.id, removed: true } }
}
