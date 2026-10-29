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
 * Writes: a decision goes to supplier_invoice_attestations as the service
 * role (the trail is append only and no session writes it), after the rules
 * here said yes. The invoice's approved_at/approved_by (the attest marker
 * payments read) is set as the service role too: the database refuses it
 * from a session (guard_supplier_invoice_attest_marker), so no member can set
 * it past these rules. The same optimistic guard as before the policy
 * existed makes two concurrent approvals set it once and emit
 * supplier_invoice.approved once.
 * Under mode 'all' every approval is recorded first and the round is read
 * back afterwards: whichever approval lands last sees every other one, so a
 * satisfied policy is never missed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getSwedishLocalDate } from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events'
import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'
import type { SupplierInvoice } from '@/types'
import {
  ATTEST_COMMENT_MAX,
  attestProgress,
  latestRejection,
  ruleOnApproval,
  ruleOnRejection,
  type AttestationRecord,
  type AttestDecision,
  type AttestInvoiceFacts,
  type AttestPolicy,
  type AttestProgress,
  type AttestSource,
} from './attest-policy'
import { canApproveSupplierInvoice, resolveUnsettledStatus } from './lifecycle'
import { loadAttestBlockedInvoiceIds, loadAttestPolicy, POLICY_COLUMNS, toPolicy, type PolicyRow } from './attest-policy-read'
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'

export { loadAttestBlockedInvoiceIds, loadAttestPolicy }

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

/** The company's members who may write (owner, admin, member): the only people whose attest counts. */
export async function loadActiveAttestMembers(service: SupabaseClient, companyId: string): Promise<Set<string>> {
  const { data, error } = await service.from('company_members').select('user_id, role').eq('company_id', companyId)
  if (error) throw error
  return new Set(
    ((data ?? []) as Array<{ user_id: string; role: string }>).filter((m) => isBookkeepingWriterRole(m.role)).map((m) => m.user_id),
  )
}

interface AttestationRow extends AttestationRecord {
  id: string
}

async function loadAttestations(supabase: SupabaseClient, companyId: string, invoiceId: string): Promise<AttestationRow[]> {
  const { data, error } = await supabase
    .from('supplier_invoice_attestations')
    .select('id, user_id, decision, comment, source, decided_at')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoiceId)
    .order('decided_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as AttestationRow[]
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
): Promise<string> {
  const { data, error } = await service
    .from('supplier_invoice_attestations')
    .insert({ company_id: companyId, supplier_invoice_id: invoiceId, user_id: userId, decision, source, comment })
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

export interface ApproveSupplierInvoiceInput {
  invoiceId: string
  source: AttestSource
  /** Answer what the approval would do and write nothing (v1 ?dry_run, the agent's staging preview). */
  dryRun?: boolean
  /** The invoice columns to answer; defaults to every column. */
  select?: string
  /** Pin the update to the due date read here (v1 does: the derived status follows it). */
  pinDueDate?: boolean
  /** A service-role client the door already holds (see serviceWriter). */
  writer?: SupabaseClient
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
 * Approve (attest) a supplier invoice as `ctx.userId`. Without a policy that
 * governs the invoice this is the approval it has always been, now with a
 * row in the trail. Under the policy the decision is refused for anyone who
 * may not attest (ATTEST_NOT_ALLOWED) or already did in this round
 * (ATTEST_ALREADY_GIVEN); an allowed one is recorded, and approved_at is set
 * once the policy is satisfied.
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

  const [policy, accountingMethod, attestations] = await Promise.all([
    loadAttestPolicy(supabase, companyId),
    loadAccountingMethod(supabase, companyId),
    loadAttestations(supabase, companyId, invoice.id),
  ])
  const service = serviceWriter(input.writer)
  // Only someone who keeps the books attests, policy or not. The marker is
  // written as the service role (no RLS), so this is the check the session's
  // own write used to get from current_user_can_write().
  const writers = await loadActiveAttestMembers(service, companyId)
  if (!writers.has(userId)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      messageSv: 'Bara den som för företagets bokföring (ägare, administratör eller medlem) kan attestera leverantörsfakturor.',
      details: { reason: 'not_member' },
    }
  }
  const members = policy.enabled ? writers : undefined
  const ruling = ruleOnApproval(policy, accountingMethod, invoice, attestations, userId, members)
  if (ruling.kind === 'refused') {
    return {
      ok: false,
      code: ruling.code,
      details: ruling.code === 'ATTEST_NOT_ALLOWED' ? { reason: ruling.reason } : undefined,
    }
  }

  const today = getSwedishLocalDate()
  const setsMarker = ruling.kind === 'unrestricted' || ruling.satisfies
  const nextStatus = setsMarker ? resolveUnsettledStatus({ ...invoice, approved_at: 'now' }, today) : invoice.status

  if (input.dryRun) {
    const remaining = ruling.kind === 'record' ? ruling.remainingAfter : []
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        status: nextStatus,
        attest_required: ruling.kind === 'record',
        completes_attest: setsMarker,
        attest_remaining_user_ids: remaining,
      },
    }
  }

  const selectColumns = input.select ?? '*'
  let attestationId: string | null = null

  if (ruling.kind === 'record') {
    // Recorded first: the round read back below then includes it, whoever else approves meanwhile.
    attestationId = await recordDecision(service, companyId, invoice.id, userId, 'approved', input.source, null)
    if (!ruling.satisfies) {
      // A concurrent approval may have completed the round meanwhile.
      const after = await loadAttestations(supabase, companyId, invoice.id)
      const progress = attestProgress(policy, accountingMethod, invoice, after, members)
      if (!progress.satisfied) {
        const current = await readInvoiceRow(supabase, companyId, invoice.id, selectColumns)
        return { ok: true, data: { invoice: current, approved: false, attest: progress, attestation_id: attestationId } }
      }
    }
  }

  const approvedAt = new Date().toISOString()
  // The service role, as the trail: a session may not write the marker. The
  // door already proved the caller may write (requireWrite, the key's scope,
  // the link's member check) and the rules above proved they may attest.
  let update = service
    .from('supplier_invoices')
    .update({ status: resolveUnsettledStatus({ ...invoice, approved_at: approvedAt }, today), approved_at: approvedAt, approved_by: userId })
    .eq('company_id', companyId)
    .eq('id', invoice.id)
    // Optimistic concurrency on the pre-approval state: two concurrent
    // approvals must not both write approved_at and both emit the event.
    .in('status', ['registered', 'overdue'])
    .is('approved_at', null)
  if (input.pinDueDate) update = update.eq('due_date', invoice.due_date)
  const { data: updated, error: updateError } = await update.select(selectColumns).maybeSingle()
  if (updateError) {
    log.error('supplier invoice attest update failed', updateError, { invoiceId: invoice.id })
    return { ok: false, code: 'SI_APPROVE_UPDATE_FAILED' }
  }

  const finalAttestations = ruling.kind === 'record' ? await loadAttestations(supabase, companyId, invoice.id) : attestations
  if (!updated) {
    if (ruling.kind === 'unrestricted') {
      // Lost the race: another approval (or a status change) landed first.
      return { ok: false, code: 'SI_APPROVE_NOT_REGISTERED', details: { reason: 'race' } }
    }
    // Another attester's approval set the marker first: this one is recorded and the policy is satisfied.
    const current = await readInvoiceRow(supabase, companyId, invoice.id, selectColumns)
    return {
      ok: true,
      data: { invoice: current, approved: false, attest: attestProgress(policy, accountingMethod, invoice, finalAttestations, members), attestation_id: attestationId },
    }
  }

  if (ruling.kind === 'unrestricted') {
    // The trail holds every approval, also the ones no policy asked for.
    attestationId = await recordDecision(service, companyId, invoice.id, userId, 'approved', input.source, null).catch((error) => {
      log.warn('attest trail row not written for an unrestricted approval', { invoiceId: invoice.id, message: error instanceof Error ? error.message : String(error) })
      return null
    })
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.approved',
      payload: { supplierInvoice: updated as unknown as SupplierInvoice, companyId, userId },
    })
  } catch (error) {
    log.warn('supplier_invoice.approved emit failed', error as Error)
  }

  return {
    ok: true,
    data: {
      invoice: updated as unknown as Record<string, unknown>,
      approved: true,
      attest: attestProgress(policy, accountingMethod, invoice, finalAttestations, members),
      attestation_id: attestationId,
    },
  }
}

async function readInvoiceRow(supabase: SupabaseClient, companyId: string, invoiceId: string, select: string): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.from('supplier_invoices').select(select).eq('company_id', companyId).eq('id', invoiceId).maybeSingle()
  if (error) throw error
  return (data ?? {}) as Record<string, unknown>
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
  input: { invoiceId: string; comment?: string | null; source: AttestSource; writer?: SupabaseClient; dryRun?: boolean },
): Promise<OperationOutcome<RejectSupplierInvoiceResult>> {
  const { supabase, companyId, userId } = ctx
  const invoice = await loadInvoice(supabase, companyId, input.invoiceId)
  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  if (!canApproveSupplierInvoice(invoice)) {
    return { ok: false, code: 'ATTEST_NOT_PENDING', details: { current_status: invoice.status } }
  }
  const [policy, accountingMethod] = await Promise.all([loadAttestPolicy(supabase, companyId), loadAccountingMethod(supabase, companyId)])
  const service = serviceWriter(input.writer)
  const members = policy.enabled ? await loadActiveAttestMembers(service, companyId) : undefined
  const ruling = ruleOnRejection(policy, accountingMethod, invoice, userId, members)
  if (ruling.kind === 'refused') return { ok: false, code: ruling.code, details: { reason: ruling.reason } }
  if (input.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        status: resolveUnsettledStatus({ ...invoice, approved_at: null }, getSwedishLocalDate()),
        comment: normalizeComment(input.comment),
        restarts_attest_round: ruling.kind === 'record',
      },
    }
  }

  const attestationId = await recordDecision(service, companyId, invoice.id, userId, 'rejected', input.source, normalizeComment(input.comment))
  await consumeOpenLinks(service, companyId, invoice.id)
  return {
    ok: true,
    data: {
      supplier_invoice_id: invoice.id,
      attestation_id: attestationId,
      status: resolveUnsettledStatus({ ...invoice, approved_at: null }, getSwedishLocalDate()),
    },
  }
}

export interface AttestPerson {
  user_id: string
  name: string | null
  email: string | null
}

export interface SupplierInvoiceAttestState {
  supplier_invoice_id: string
  policy: { enabled: boolean; mode: 'any' | 'all'; threshold_amount: number | null; preparer_may_attest: boolean }
  required: boolean
  satisfied: boolean
  blocked: boolean
  approved_at: string | null
  approved_by: AttestPerson | null
  approved: AttestPerson[]
  remaining: AttestPerson[]
  latest_rejection: { user: AttestPerson; comment: string | null; decided_at: string } | null
  attestations: Array<{
    attestation_id: string
    user: AttestPerson
    decision: AttestDecision
    comment: string | null
    source: AttestSource
    decided_at: string
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
  const invoice = await loadInvoice(supabase, companyId, invoiceId)
  if (!invoice) return { ok: false, code: 'SI_NOT_FOUND' }
  const service = serviceWriter(options.writer)
  const [policy, accountingMethod, attestations, members] = await Promise.all([
    loadAttestPolicy(supabase, companyId),
    loadAccountingMethod(supabase, companyId),
    loadAttestations(supabase, companyId, invoice.id),
    loadActiveAttestMembers(service, companyId),
  ])
  const progress = attestProgress(policy, accountingMethod, invoice, attestations, policy.enabled ? members : undefined)
  const people = await loadAttestPeople(service, [
    ...attestations.map((a) => a.user_id),
    ...progress.remaining,
    ...(invoice.approved_by ? [invoice.approved_by] : []),
  ])
  const person = (id: string): AttestPerson => people.get(id) ?? { user_id: id, name: null, email: null }

  const pending = canApproveSupplierInvoice(invoice)
  const approval = pending ? ruleOnApproval(policy, accountingMethod, invoice, attestations, userId, policy.enabled ? members : undefined) : null
  const rejection = pending ? ruleOnRejection(policy, accountingMethod, invoice, userId, policy.enabled ? members : undefined) : null
  const isWriter = members.has(userId)
  const mayApprove = !!approval && approval.kind !== 'refused' && isWriter
  const mayReject = !!rejection && rejection.kind !== 'refused' && isWriter
  const reason = !pending
    ? invoice.approved_at
      ? 'already_approved'
      : 'not_pending'
    : approval?.kind === 'refused'
      ? approval.code === 'ATTEST_ALREADY_GIVEN'
        ? 'already_given'
        : approval.reason
      : !isWriter
        ? 'not_member'
        : null
  const rejected = latestRejection(attestations)

  return {
    ok: true,
    data: {
      supplier_invoice_id: invoice.id,
      policy: {
        enabled: policy.enabled,
        mode: policy.mode,
        threshold_amount: policy.threshold_amount,
        preparer_may_attest: policy.preparer_may_attest,
      },
      required: progress.required,
      satisfied: !!invoice.approved_at || progress.satisfied,
      blocked: progress.blocked && !invoice.approved_at,
      approved_at: invoice.approved_at,
      approved_by: invoice.approved_by ? person(invoice.approved_by) : null,
      approved: progress.approved_by.map(person),
      remaining: invoice.approved_at ? [] : progress.remaining.map(person),
      latest_rejection: rejected ? { user: person(rejected.user_id), comment: rejected.comment ?? null, decided_at: rejected.decided_at } : null,
      attestations: (attestations as AttestationRow[]).map((a) => ({
        attestation_id: a.id,
        user: person(a.user_id),
        decision: a.decision,
        comment: a.comment ?? null,
        source: a.source ?? 'app',
        decided_at: a.decided_at,
      })),
      viewer: { may_approve: mayApprove, may_reject: mayReject, reason },
    },
  }
}

export interface AttestPolicyInput {
  enabled: boolean
  threshold_amount: number | null
  mode: 'any' | 'all'
  attesters: string[]
  preparer_may_attest: boolean
}

/**
 * Save the company's attest policy. Owners and admins only: the session door
 * gates with requireAdmin and the RLS policy, a service-role door passes
 * `checkAdmin` (lib/operations/access.ts does the asking). Every attester
 * must be a member who may write; a policy that is on needs at least one.
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
  const members = await loadActiveAttestMembers(serviceWriter(options.writer), ctx.companyId)
  const outsiders = attesters.filter((id) => !members.has(id))
  if (outsiders.length > 0) {
    return { ok: false, code: 'ATTEST_POLICY_ATTESTER_NOT_MEMBER', details: { user_ids: outsiders } }
  }
  const row = {
    company_id: ctx.companyId,
    enabled: input.enabled,
    threshold_amount: input.threshold_amount === null ? null : roundOre(input.threshold_amount),
    mode: input.mode,
    attesters,
    preparer_may_attest: input.preparer_may_attest,
    updated_by: ctx.userId,
  }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { ...row } }
  const writer = options.writer ?? ctx.supabase
  const { data, error } = await writer.from('company_attest_policies').upsert(row, { onConflict: 'company_id' }).select(POLICY_COLUMNS).maybeSingle()
  if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
  // RLS refuses a non-admin silently: zero rows, no error.
  if (!data) return { ok: false, code: 'FORBIDDEN', messageSv: 'Bara företagets ägare eller en administratör kan ändra attestreglerna.' }
  return { ok: true, data: toPolicy(data as PolicyRow) }
}
