/**
 * The attest policy for supplier invoices (attestflöde): the one place that
 * decides whether an invoice needs attest, who may attest it and whether the
 * attest it has is enough. Pure: every door (the dashboard, v1, the approved
 * agent operation, the mail's link) and the payment paths read these rules
 * through lib/supplier-invoices/attest-service.ts, so none of them can grow a
 * rule of its own.
 *
 * A company without a policy row, or with the policy off, attests the way it
 * always has: one click by anyone with write access, and payment only warns
 * about an unattested invoice. With the policy on, an invoice at or above the
 * threshold (in SEK) needs attest by the attesters; until the policy is
 * satisfied, payments leave it out. Kontantmetoden has no attest step at all
 * (companyAttestsSupplierInvoices), so the policy never applies there, and a
 * credit note is never a payable to attest.
 *
 * Rounds: a rejection ends the round. Approvals given before the latest
 * rejection no longer count, so after a "Neka" the attesters start over.
 */

import { companyAttestsSupplierInvoices } from './lifecycle'

export type AttestMode = 'any' | 'all'
export type AttestDecision = 'approved' | 'rejected'
export type AttestSource = 'app' | 'email_link' | 'api' | 'mcp'

export const ATTEST_COMMENT_MAX = 1000
export const ATTEST_MAX_ATTESTERS = 50

export interface AttestPolicy {
  enabled: boolean
  /** Attest is required at or above this amount in SEK; null = every invoice. */
  threshold_amount: number | null
  mode: AttestMode
  /** Company members who attest (user ids). */
  attesters: string[]
  /** False: the person who registered the invoice cannot attest it (four eyes). */
  preparer_may_attest: boolean
  updated_by: string | null
  updated_at: string | null
}

/** What a company without a policy row has: no policy. */
export const NO_ATTEST_POLICY: AttestPolicy = {
  enabled: false,
  threshold_amount: null,
  mode: 'any',
  attesters: [],
  preparer_may_attest: false,
  updated_by: null,
  updated_at: null,
}

/** The facts of an invoice the rules read. */
export interface AttestInvoiceFacts {
  /** The person who registered the invoice. */
  user_id: string
  is_credit_note?: boolean | null
  currency: string
  total: number
  total_sek?: number | null
  exchange_rate?: number | null
}

export interface AttestationRecord {
  user_id: string
  decision: AttestDecision
  decided_at: string
  comment?: string | null
  source?: AttestSource
}

/**
 * The invoice's total in SEK: the stored SEK total when there is one, the
 * total itself for a SEK invoice, the total at the invoice's rate otherwise.
 * Null when a foreign invoice has no rate: the threshold cannot be judged.
 */
export function invoiceTotalSek(invoice: Pick<AttestInvoiceFacts, 'currency' | 'total' | 'total_sek' | 'exchange_rate'>): number | null {
  if (invoice.total_sek !== null && invoice.total_sek !== undefined && Number.isFinite(Number(invoice.total_sek))) {
    return Math.abs(Number(invoice.total_sek))
  }
  if (invoice.currency === 'SEK') return Math.abs(Number(invoice.total))
  const rate = Number(invoice.exchange_rate)
  if (!invoice.exchange_rate || !Number.isFinite(rate) || rate <= 0) return null
  return Math.abs(Number(invoice.total) * rate)
}

/**
 * True when the policy requires attest for this invoice: the policy is on,
 * the company keeps faktureringsmetoden, the invoice is a payable (not a
 * credit note) and its total in SEK is at or above the threshold. A foreign
 * invoice without a rate fails closed: it needs attest.
 */
export function invoiceNeedsAttest(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
): boolean {
  if (!policy.enabled) return false
  if (!companyAttestsSupplierInvoices(accountingMethod)) return false
  if (invoice.is_credit_note) return false
  if (policy.threshold_amount === null || policy.threshold_amount === undefined) return true
  const sek = invoiceTotalSek(invoice)
  if (sek === null) return true
  return sek >= Number(policy.threshold_amount)
}

/**
 * The attesters who may attest this invoice: the policy's attesters, without
 * the registrant unless the policy lets the registrant attest, and only those
 * still active in the company (`activeMembers`: non-viewer members; omitted =
 * all of them count).
 */
export function eligibleAttesters(
  policy: AttestPolicy,
  invoice: Pick<AttestInvoiceFacts, 'user_id'>,
  activeMembers?: ReadonlySet<string>,
): string[] {
  return [...new Set(policy.attesters)].filter(
    (id) => (policy.preparer_may_attest || id !== invoice.user_id) && (!activeMembers || activeMembers.has(id)),
  )
}

export type MayAttestResult = { ok: true } | { ok: false; reason: 'not_attester' | 'registrant' }

/** Whether this user may attest an invoice the policy requires attest for. */
export function mayAttest(
  policy: AttestPolicy,
  invoice: Pick<AttestInvoiceFacts, 'user_id'>,
  userId: string,
): MayAttestResult {
  if (!policy.attesters.includes(userId)) return { ok: false, reason: 'not_attester' }
  if (!policy.preparer_may_attest && invoice.user_id === userId) return { ok: false, reason: 'registrant' }
  return { ok: true }
}

/** The decisions of the current round: everything after the latest rejection, oldest first. */
export function currentRound(attestations: readonly AttestationRecord[]): AttestationRecord[] {
  const sorted = [...attestations].sort((a, b) => a.decided_at.localeCompare(b.decided_at))
  let start = 0
  sorted.forEach((row, index) => {
    if (row.decision === 'rejected') start = index + 1
  })
  return sorted.slice(start)
}

/** The latest rejection, if any: the comment the registrant reads. */
export function latestRejection(attestations: readonly AttestationRecord[]): AttestationRecord | null {
  const rejections = attestations.filter((row) => row.decision === 'rejected')
  if (rejections.length === 0) return null
  return rejections.reduce((latest, row) => (row.decided_at > latest.decided_at ? row : latest))
}

export interface AttestProgress {
  /** The policy requires attest for this invoice. */
  required: boolean
  mode: AttestMode
  /** The policy is satisfied by the current round (always false when not required). */
  satisfied: boolean
  /** Eligible attesters who approved in the current round, in order. */
  approved_by: string[]
  /** Eligible attesters whose approval is still missing (any: all of them until one approves). */
  remaining: string[]
  /** Everyone who may attest the invoice now. */
  eligible: string[]
  /** Nobody can attest the invoice under the policy (no eligible attester left). */
  blocked: boolean
}

/**
 * Where the attest of an invoice stands under the policy. `any`: one
 * approval by an eligible attester satisfies it. `all`: every eligible
 * attester must approve. Approvals by people who are not (or no longer)
 * eligible are kept in the trail but do not count.
 */
export function attestProgress(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  attestations: readonly AttestationRecord[],
  activeMembers?: ReadonlySet<string>,
): AttestProgress {
  const required = invoiceNeedsAttest(policy, accountingMethod, invoice)
  const eligible = required ? eligibleAttesters(policy, invoice, activeMembers) : []
  const approvedBy: string[] = []
  for (const row of currentRound(attestations)) {
    if (row.decision === 'approved' && eligible.includes(row.user_id) && !approvedBy.includes(row.user_id)) {
      approvedBy.push(row.user_id)
    }
  }
  const missing = eligible.filter((id) => !approvedBy.includes(id))
  const satisfied =
    required && eligible.length > 0 && (policy.mode === 'any' ? approvedBy.length >= 1 : missing.length === 0)
  return {
    required,
    mode: policy.mode,
    satisfied,
    approved_by: approvedBy,
    remaining: satisfied ? [] : missing,
    eligible,
    blocked: required && eligible.length === 0,
  }
}

export type AttestRuling =
  /** The policy does not govern the invoice: approval works as it always has. */
  | { kind: 'unrestricted' }
  | { kind: 'refused'; code: 'ATTEST_NOT_ALLOWED'; reason: 'not_attester' | 'registrant' | 'not_member' }
  | { kind: 'refused'; code: 'ATTEST_ALREADY_GIVEN' }
  /** Record the decision; `satisfies` says whether it completes the policy. */
  | { kind: 'record'; satisfies: boolean; remainingAfter: string[] }

/**
 * May this user approve the invoice now, and what does the approval do?
 * `activeMembers` are the company's non-viewer members: an attester who left
 * the company or became a viewer is refused like anyone else.
 */
export function ruleOnApproval(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  attestations: readonly AttestationRecord[],
  userId: string,
  activeMembers?: ReadonlySet<string>,
): AttestRuling {
  if (!invoiceNeedsAttest(policy, accountingMethod, invoice)) return { kind: 'unrestricted' }
  if (activeMembers && !activeMembers.has(userId)) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' }
  const may = mayAttest(policy, invoice, userId)
  if (!may.ok) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: may.reason }
  const round = currentRound(attestations)
  if (round.some((row) => row.decision === 'approved' && row.user_id === userId)) {
    return { kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' }
  }
  const after = attestProgress(
    policy,
    accountingMethod,
    invoice,
    [...attestations, { user_id: userId, decision: 'approved', decided_at: '9999-12-31T23:59:59.999Z' }],
    activeMembers,
  )
  return { kind: 'record', satisfies: after.satisfied, remainingAfter: after.remaining }
}

/**
 * May this user reject the invoice? Whoever may approve may reject: under
 * the policy only an eligible attester (and one who already approved in this
 * round may still change their mind), without it anyone with write access.
 */
export function ruleOnRejection(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  userId: string,
  activeMembers?: ReadonlySet<string>,
): { kind: 'unrestricted' } | { kind: 'record' } | Extract<AttestRuling, { code: 'ATTEST_NOT_ALLOWED' }> {
  if (!invoiceNeedsAttest(policy, accountingMethod, invoice)) return { kind: 'unrestricted' }
  if (activeMembers && !activeMembers.has(userId)) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' }
  const may = mayAttest(policy, invoice, userId)
  if (!may.ok) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: may.reason }
  return { kind: 'record' }
}

/**
 * True when payment must wait: the policy requires attest for the invoice and
 * it has not been given. approved_at is set exactly when the policy is
 * satisfied (or the invoice was attested before the policy), so it is the
 * marker; payment never re-derives the round.
 */
export function paymentWaitsForAttest(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts & { approved_at: string | null },
): boolean {
  return !invoice.approved_at && invoiceNeedsAttest(policy, accountingMethod, invoice)
}
