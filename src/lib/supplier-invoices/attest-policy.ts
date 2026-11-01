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
 *
 * Levels (attestnivåer, #135): an attester may have a limit in SEK
 * (company_attest_limits; no row or null = no limit), and the policy may ask
 * for two attesters from an amount (two_step_from_sek). Below that amount one
 * approval by an attester whose limit covers the invoice satisfies the
 * policy; at or above it, two different attesters must approve and at least
 * one of them must have a covering limit, in either order. Under mode 'all'
 * every eligible attester still approves, and the levels add that one of
 * them covers the amount and that there are two of them from the two-step
 * amount. With levels on, an attest through an API key or an agent's key is
 * capped by the lower of the person's limit and the key's unattended
 * ceiling. The limits read as they stand now, like the attesters: lowering
 * a limit after an approval can make it stop covering.
 *
 * The database applies the same rules when it records an approval: the
 * attest_supplier_invoice RPC (supplier_invoice_attest_ruling), which locks
 * the invoice and sets the marker only when the policy is met. This module is
 * what the pages, the dry runs and the worklist read;
 * tests/pg/supplier-invoice-attest-levels.pg.test.ts proves the two agree.
 */

import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
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
  /** Two different attesters from this amount in SEK; null = one is always enough. */
  two_step_from_sek: number | null
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
  two_step_from_sek: null,
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

/** The attesters' limits in SEK (company_attest_limits, scope supplier_invoice): user id to limit, null = no limit. A user without an entry has no limit. */
export type AttestLimits = ReadonlyMap<string, number | null>

export const NO_ATTEST_LIMITS: AttestLimits = new Map()

/** Who attests and through what: the levels' inputs beside the policy. */
export interface AttestLevels {
  limits?: AttestLimits
  /** The attest comes through a key credential (an API key, an agent's OAuth key or a service account's key). */
  viaKey?: boolean
  /** That key's unattended ceiling in SEK; null or not positive = none. */
  keyCeiling?: number | null
}

/**
 * The invoice's total in SEK, to the öre: the stored SEK total when there is
 * one, the total itself for a SEK invoice, the total at the invoice's rate
 * otherwise. Null when a foreign invoice has no rate: the threshold and the
 * limits cannot be judged. Rounded so the database, which computes it in
 * exact numeric (round(..., 2)), judges the same amount.
 */
export function invoiceTotalSek(invoice: Pick<AttestInvoiceFacts, 'currency' | 'total' | 'total_sek' | 'exchange_rate'>): number | null {
  if (invoice.total_sek !== null && invoice.total_sek !== undefined && Number.isFinite(Number(invoice.total_sek))) {
    return roundOre(Math.abs(Number(invoice.total_sek)))
  }
  if (invoice.currency === 'SEK') return roundOre(Math.abs(Number(invoice.total)))
  const rate = Number(invoice.exchange_rate)
  if (!invoice.exchange_rate || !Number.isFinite(rate) || rate <= 0) return null
  // In decimals, not floats: 33.33 × 11.5 is 383.30 kr in SQL and must be here too.
  return sekOfForeign(Math.abs(Number(invoice.total)), rate)
}

/** The person's limit; null = no limit. */
export function attestLimitOf(limits: AttestLimits | undefined, userId: string): number | null {
  const limit = limits?.get(userId)
  return limit === undefined || limit === null ? null : Number(limit)
}

/** True when a limit covers the amount: no limit covers everything, and an amount that cannot be judged only that. */
export function limitCovers(limit: number | null, amountSek: number | null): boolean {
  if (limit === null) return true
  return amountSek !== null && amountSek <= limit
}

/** Levels are on when the policy asks for two attesters from an amount or one of its attesters has a limit. */
export function attestLevelsOn(policy: Pick<AttestPolicy, 'two_step_from_sek' | 'attesters'>, limits: AttestLimits | undefined): boolean {
  if (policy.two_step_from_sek !== null && policy.two_step_from_sek !== undefined) return true
  return policy.attesters.some((id) => attestLimitOf(limits, id) !== null)
}

/** How many different attesters the invoice needs: two at or above the two-step amount (and when its amount cannot be judged), else one. */
export function attestStepsRequired(policy: Pick<AttestPolicy, 'two_step_from_sek'>, amountSek: number | null): 1 | 2 {
  if (policy.two_step_from_sek === null || policy.two_step_from_sek === undefined) return 1
  return amountSek === null || amountSek >= Number(policy.two_step_from_sek) ? 2 : 1
}

/** The lower of two limits, where null is no limit. */
function lowerLimit(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/** A key's ceiling as the rules read it: a positive amount, else none. */
function keyCeilingOf(levels: AttestLevels | undefined): number | null {
  const ceiling = levels?.keyCeiling
  return typeof ceiling === 'number' && Number.isFinite(ceiling) && ceiling > 0 ? ceiling : null
}

/**
 * The limit that applies to this person's attest: their own, and through a
 * key with levels on also the key's ceiling, whichever is lower.
 */
export function effectiveAttestLimit(
  policy: Pick<AttestPolicy, 'two_step_from_sek' | 'attesters'>,
  userId: string,
  levels: AttestLevels | undefined,
): number | null {
  const own = attestLimitOf(levels?.limits, userId)
  if (!levels?.viaKey || !attestLevelsOn(policy, levels.limits)) return own
  return lowerLimit(own, keyCeilingOf(levels))
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
  /**
   * Eligible attesters whose approval would move the invoice on: under `all`
   * every one still missing; under `any` all of them, or only those whose
   * limit covers the amount when a covering approval is what is left.
   */
  remaining: string[]
  /** Everyone who may attest the invoice now. */
  eligible: string[]
  /** Nobody can attest the invoice under the policy: no eligible attester, none whose limit covers it, or fewer than the steps it needs. */
  blocked: boolean
  /** The invoice's total in SEK the levels judge; null when a foreign invoice has no rate. */
  amount_sek: number | null
  /** How many different attesters the invoice needs (two at or above the two-step amount). */
  steps: 1 | 2
  /** How many more approvals the policy needs; 0 when satisfied or not required. */
  approvals_needed: number
  /** One of the missing approvals must come from someone whose limit covers amount_sek. */
  needs_covering: boolean
}

/**
 * Where the attest of an invoice stands under the policy. `any`: one
 * approval by an eligible attester satisfies it, two different ones from the
 * two-step amount, and at least one of them with a limit that covers the
 * amount. `all`: every eligible attester must approve (and one of them must
 * cover the amount). Approvals by people who are not (or no longer) eligible
 * are kept in the trail but do not count.
 */
export function attestProgress(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  attestations: readonly AttestationRecord[],
  activeMembers?: ReadonlySet<string>,
  limits?: AttestLimits,
): AttestProgress {
  const required = invoiceNeedsAttest(policy, accountingMethod, invoice)
  const eligible = required ? eligibleAttesters(policy, invoice, activeMembers) : []
  const amount = invoiceTotalSek(invoice)
  const steps = required ? attestStepsRequired(policy, amount) : 1
  const covers = (id: string) => limitCovers(attestLimitOf(limits, id), amount)
  const approvedBy: string[] = []
  for (const row of currentRound(attestations)) {
    if (row.decision === 'approved' && eligible.includes(row.user_id) && !approvedBy.includes(row.user_id)) {
      approvedBy.push(row.user_id)
    }
  }
  const covering = approvedBy.some(covers)
  const missing = eligible.filter((id) => !approvedBy.includes(id))
  const modeMet = policy.mode === 'any' ? approvedBy.length >= 1 : missing.length === 0
  const satisfied = required && eligible.length > 0 && modeMet && approvedBy.length >= steps && covering
  // Under `any`, a missing approval can come from anyone while the steps
  // still need more people than the one covering approval they need.
  const openToAnyone = steps - approvedBy.length - (covering ? 0 : 1) > 0
  const remaining = satisfied ? [] : policy.mode === 'all' || openToAnyone ? missing : missing.filter(covers)
  return {
    required,
    mode: policy.mode,
    satisfied,
    approved_by: approvedBy,
    remaining,
    eligible,
    blocked: required && (eligible.length === 0 || eligible.length < steps || !eligible.some(covers)),
    amount_sek: amount,
    steps,
    approvals_needed:
      !required || satisfied
        ? 0
        : policy.mode === 'all'
          ? missing.length
          : Math.max(steps - approvedBy.length, covering ? 0 : 1),
    needs_covering: required && !satisfied && !covering,
  }
}

export type AttestRefusalReason = 'not_attester' | 'registrant' | 'not_member'

export type AttestRuling =
  /** The policy does not govern the invoice: approval works as it always has. */
  | { kind: 'unrestricted' }
  | { kind: 'refused'; code: 'ATTEST_NOT_ALLOWED'; reason: AttestRefusalReason }
  | { kind: 'refused'; code: 'ATTEST_ALREADY_GIVEN' }
  /**
   * The person's limit does not cover the invoice and their approval cannot
   * count (`limit`), or through a key the lower of their limit and the key's
   * ceiling does not cover it (`key_limit`).
   */
  | { kind: 'refused'; code: 'ATTEST_LIMIT_EXCEEDED'; reason: 'limit' | 'key_limit'; limit_sek: number | null; amount_sek: number | null }
  /**
   * Record the decision; `satisfies` says whether it completes the policy.
   * `step` is the approval's place in the round, `limitSek` the limit that
   * applied to it: both go to the trail.
   */
  | { kind: 'record'; satisfies: boolean; remainingAfter: string[]; step: number; limitSek: number | null }

/**
 * May this user approve the invoice now, and what does the approval do?
 * `activeMembers` are the company's non-viewer members: an attester who left
 * the company or became a viewer is refused like anyone else. `levels` are
 * the attesters' limits and the key the attest comes through, if any.
 */
export function ruleOnApproval(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  attestations: readonly AttestationRecord[],
  userId: string,
  activeMembers?: ReadonlySet<string>,
  levels?: AttestLevels,
): AttestRuling {
  if (!invoiceNeedsAttest(policy, accountingMethod, invoice)) return { kind: 'unrestricted' }
  if (activeMembers && !activeMembers.has(userId)) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' }
  const may = mayAttest(policy, invoice, userId)
  if (!may.ok) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: may.reason }
  const round = currentRound(attestations)
  if (round.some((row) => row.decision === 'approved' && row.user_id === userId)) {
    return { kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' }
  }
  const limits = levels?.limits
  const before = attestProgress(policy, accountingMethod, invoice, attestations, activeMembers, limits)
  const amount = before.amount_sek
  const applied = effectiveAttestLimit(policy, userId, levels)
  if (levels?.viaKey && attestLevelsOn(policy, limits) && !limitCovers(applied, amount)) {
    return { kind: 'refused', code: 'ATTEST_LIMIT_EXCEEDED', reason: 'key_limit', limit_sek: applied, amount_sek: amount }
  }
  const own = attestLimitOf(limits, userId)
  if (policy.mode === 'any' && !limitCovers(own, amount)) {
    // Not covering: the approval counts only while the round has room for
    // someone besides the covering approver it still needs.
    const covering = before.approved_by.some((id) => limitCovers(attestLimitOf(limits, id), amount))
    if (before.steps - before.approved_by.length - (covering ? 0 : 1) <= 0) {
      return { kind: 'refused', code: 'ATTEST_LIMIT_EXCEEDED', reason: 'limit', limit_sek: own, amount_sek: amount }
    }
  }
  const after = attestProgress(
    policy,
    accountingMethod,
    invoice,
    [...attestations, { user_id: userId, decision: 'approved', decided_at: '9999-12-31T23:59:59.999Z' }],
    activeMembers,
    limits,
  )
  return {
    kind: 'record',
    satisfies: after.satisfied,
    remainingAfter: after.remaining,
    step: before.approved_by.length + 1,
    limitSek: applied,
  }
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
