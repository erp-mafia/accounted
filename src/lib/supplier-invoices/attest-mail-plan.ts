/**
 * The rules of the batched attest mail (crm#1569), pure: who is asked about
 * which invoices, when a company's round of registrations is complete, when
 * an attester is reminded, and when the registrant is told that an invoice
 * passed its due date without attest or that nobody can attest it. The jobs
 * that load the rows and send the mails are attest-mail-run.ts.
 *
 * One standing per invoice decides everything (attestMailStanding): an
 * invoice the policy no longer governs, that left attest (attested, paid,
 * credited) or that is satisfied is closed; one whose latest decision is a
 * rejection waits on the registrant, not on the attester, so nobody is asked
 * or reminded about it again by mail (the attester still sees it under Att
 * göra); one nobody can attest under the current rules is blocked; the rest
 * wait on the attesters attestProgress names. The attest service and the
 * worklist read the same attestProgress, so a mail never asks someone the
 * service would refuse.
 */

import { addDaysIso, daysBetweenIso, isPastDue } from '@/lib/dates/iso'
import { canApproveSupplierInvoice } from './lifecycle'
import {
  attestProgress,
  invoiceNeedsAttest,
  type AttestationRecord,
  type AttestInvoiceFacts,
  type AttestLimits,
  type AttestPolicy,
} from './attest-policy'

/** A round is complete once the company has registered nothing new for this long. */
export const ATTEST_ROUND_QUIET_MS = 15 * 60_000
/** A company that keeps registering is still mailed once its oldest queued invoice has waited this long. */
export const ATTEST_ROUND_MAX_WAIT_MS = 2 * 60 * 60_000

/** The invoice facts the rules read. */
export type AttestMailInvoice = AttestInvoiceFacts & {
  id: string
  status: string
  approved_at: string | null
  due_date: string
}

/** The company facts the rules read, loaded once per company. */
export interface AttestMailCompany {
  policy: AttestPolicy
  accountingMethod: string | null
  /** Members whose attest can count (isAttestRole: owner, admin, member, viewer): the only attesters the mails ask. */
  attesters: ReadonlySet<string>
  limits: AttestLimits
  /** Every decision on the invoices, by invoice id. */
  attestations: ReadonlyMap<string, readonly AttestationRecord[]>
  /** Attesters who switched the attest mail off (notification_settings.attest_request_email_enabled). */
  optedOut: ReadonlySet<string>
}

export type AttestMailStanding =
  | { kind: 'closed' }
  | { kind: 'rejected' }
  | { kind: 'blocked' }
  | { kind: 'waiting'; attesters: string[] }

/** The latest decision on the invoice is a rejection: it waits on the registrant now. */
function latestIsRejection(attestations: readonly AttestationRecord[]): boolean {
  let latest: AttestationRecord | null = null
  for (const row of attestations) if (!latest || row.decided_at > latest.decided_at) latest = row
  return latest?.decision === 'rejected'
}

/** Where an invoice stands for the mails: see the module comment. */
export function attestMailStanding(company: AttestMailCompany, invoice: AttestMailInvoice): AttestMailStanding {
  if (!canApproveSupplierInvoice(invoice)) return { kind: 'closed' }
  if (!invoiceNeedsAttest(company.policy, company.accountingMethod, invoice)) return { kind: 'closed' }
  const attestations = company.attestations.get(invoice.id) ?? []
  if (latestIsRejection(attestations)) return { kind: 'rejected' }
  const progress = attestProgress(company.policy, company.accountingMethod, invoice, attestations, company.attesters, company.limits)
  if (progress.satisfied) return { kind: 'closed' }
  if (progress.blocked) return { kind: 'blocked' }
  if (progress.remaining.length === 0) return { kind: 'closed' }
  return { kind: 'waiting', attesters: progress.remaining }
}

/**
 * True when the company's round of registrations is complete: nothing new
 * queued for 15 minutes, or the oldest queued invoice has waited 2 hours
 * (a company that registers all day still hears within the hour or two).
 */
export function attestRoundReady(queuedAt: readonly string[], now: number): boolean {
  if (queuedAt.length === 0) return false
  const times = queuedAt.map((at) => Date.parse(at)).filter((t) => Number.isFinite(t))
  if (times.length === 0) return true
  return Math.max(...times) <= now - ATTEST_ROUND_QUIET_MS || Math.min(...times) <= now - ATTEST_ROUND_MAX_WAIT_MS
}

/** The soonest due first, then by id so the order is stable. */
function byDueDate(a: AttestMailInvoice, b: AttestMailInvoice): number {
  return a.due_date.localeCompare(b.due_date) || a.id.localeCompare(b.id)
}

/** Group invoices by attester, each list soonest due first, without those who switched the mail off. */
function groupByAttester(company: AttestMailCompany, entries: Array<{ invoice: AttestMailInvoice; attesters: string[] }>): Map<string, string[]> {
  const sorted = [...entries].sort((a, b) => byDueDate(a.invoice, b.invoice))
  const out = new Map<string, string[]>()
  for (const { invoice, attesters } of sorted) {
    for (const attester of attesters) {
      if (company.optedOut.has(attester)) continue
      const list = out.get(attester) ?? []
      list.push(invoice.id)
      out.set(attester, list)
    }
  }
  return out
}

export interface AttestRequestPlan {
  /** The request mail per attester: the invoices waiting on them, soonest due first. */
  asks: Map<string, string[]>
  /** Invoices nobody can attest under the current rules: the registrant is told. */
  blocked: string[]
}

/** The request mails of one company's round: one per attester, listing every queued invoice waiting on them. */
export function planAttestRequests(company: AttestMailCompany, invoices: readonly AttestMailInvoice[]): AttestRequestPlan {
  const waiting: Array<{ invoice: AttestMailInvoice; attesters: string[] }> = []
  const blocked: string[] = []
  for (const invoice of invoices) {
    const standing = attestMailStanding(company, invoice)
    if (standing.kind === 'waiting') waiting.push({ invoice, attesters: standing.attesters })
    else if (standing.kind === 'blocked') blocked.push(invoice.id)
  }
  return { asks: groupByAttester(company, waiting), blocked }
}

/** What the jobs have already sent about an invoice (supplier_invoice_attest_mail_state). */
export interface AttestMailState {
  asked_at: string | null
  reminded_early_at: string | null
  reminded_last_at: string | null
  overdue_told_at: string | null
  blocked_told_at: string | null
}

export type AttestReminderSlot = 'early' | 'last'

/**
 * The reminder an invoice is due today, if any: the early one 3 days before
 * the due date and the last one the day before. A slot fires on its day, or
 * the day after when the daily job missed it, and only for an attester asked
 * before that day: a request mailed on or after a slot's day already says
 * what the reminder would (asked 3 days before the due date, the next
 * reminder is the day before). Each at most once: two reminders at most.
 */
export function attestReminderSlot(dueDate: string, today: string, state: AttestMailState, askedOn: string | null): AttestReminderSlot | null {
  if (!state.asked_at || !askedOn) return null
  const fires = (slotDay: string) => {
    const sinceSlot = daysBetweenIso(slotDay, today)
    return askedOn < slotDay && sinceSlot >= 0 && sinceSlot <= 1
  }
  if (!state.reminded_early_at && fires(addDaysIso(dueDate, -3))) return 'early'
  if (!state.reminded_last_at && fires(addDaysIso(dueDate, -1))) return 'last'
  return null
}

export interface AttestFollowUpPlan {
  /** The reminder mail per attester: the invoices due soon and still waiting on them. */
  reminders: Map<string, string[]>
  /** The invoices whose reminder slot is used up today, by slot (whether or not anyone could be mailed). */
  slots: { early: string[]; last: string[] }
  /** Past a due date that passed after the ask, still waiting, not told yet: the registrant is told once. */
  overdue: string[]
  /** Nobody can attest them, not told yet: the registrant is told once. */
  blocked: string[]
}

/**
 * The daily follow-up of one company's invoices that were asked for:
 * reminders to the attesters before the due date, and the registrant told
 * once when an invoice passes its due date without attest or nobody can
 * attest it any more.
 */
export function planAttestFollowUps(
  company: AttestMailCompany,
  rows: ReadonlyArray<{ invoice: AttestMailInvoice; state: AttestMailState; askedOn: string | null }>,
  today: string,
): AttestFollowUpPlan {
  const reminding: Array<{ invoice: AttestMailInvoice; attesters: string[] }> = []
  const slots: AttestFollowUpPlan['slots'] = { early: [], last: [] }
  const overdue: string[] = []
  const blocked: string[] = []
  for (const { invoice, state, askedOn } of rows) {
    if (!state.asked_at) continue
    const standing = attestMailStanding(company, invoice)
    if (standing.kind === 'blocked') {
      if (!state.blocked_told_at) blocked.push(invoice.id)
      continue
    }
    if (standing.kind !== 'waiting') continue
    if (isPastDue(invoice.due_date, today)) {
      // Only a due date that passed after the attester was asked is news: an
      // invoice registered already overdue was asked for as such.
      if (!state.overdue_told_at && askedOn !== null && invoice.due_date >= askedOn) overdue.push(invoice.id)
      continue
    }
    const slot = attestReminderSlot(invoice.due_date, today, state, askedOn)
    if (!slot) continue
    slots[slot].push(invoice.id)
    reminding.push({ invoice, attesters: standing.attesters })
  }
  return { reminders: groupByAttester(company, reminding), slots, overdue, blocked }
}
