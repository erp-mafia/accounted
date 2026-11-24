/**
 * The attest policy for supplier invoices (attestflöde): the one place that
 * decides whether an invoice needs attest, who may attest it and whether the
 * attest it has is enough. Pure: every door (the dashboard, v1, the approved
 * agent operation, the mail's link) and the payment paths read these rules
 * through lib/supplier-invoices/attest-service.ts, so none of them can grow a
 * rule of its own.
 *
 * A company without a policy row, or with the policy off, has no attest step
 * (companyAttestsSupplierInvoices): its invoices are ready to pay once
 * registered, and an attest asked for through the API or MCP is one click by
 * anyone who keeps the books. With the policy on, an invoice at or above the
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
 * Ordered steps (#192): the policy may ask for a förattest first. Every
 * project (dimension 6) on the invoice's lines needs one approval by that
 * project's attesters (project_attesters), a line without a project of its
 * own one by pre_attesters; one approval covers every group its giver is in.
 * Until each group has its förattest the attesters cannot attest; after it,
 * the attest goes as above. A person's approval counts once per round, in the
 * step it was given in, so whoever förattested cannot also attest the same
 * invoice. No limit applies to a förattest.
 *
 * Substitutes (#192): while an attester's substitution runs (policy
 * substitutes, active today), the substitute attests wherever the attester
 * may, as the attester: their place in the order, their limit. The approval
 * counts as the attester's (on_behalf_of) and is still one person's: someone
 * who approved in their own name cannot approve again for someone else.
 *
 * A company that names no förattestant, no project attester and no
 * substitute is ruled exactly as before: every new field is optional, and
 * the rulings and progress carry nothing new for it.
 *
 * The database applies the same rules when it records an approval: the
 * attest_supplier_invoice RPC (supplier_invoice_attest_ruling), which locks
 * the invoice and sets the marker only when the policy is met. This module is
 * what the pages, the dry runs and the worklist read;
 * tests/pg/supplier-invoice-attest-levels.pg.test.ts and
 * supplier-invoice-attest-steps.pg.test.ts prove the two agree.
 */

import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { DIM_PROJECT, mergeDimensionBags, type LineDimensions } from '@/lib/bookkeeping/dimension-resolver'
import { roundOre } from '@/lib/money'
import { companyAttestsSupplierInvoices } from './lifecycle'

export type AttestMode = 'any' | 'all'
export type AttestDecision = 'approved' | 'rejected'
export type AttestSource = 'app' | 'email_link' | 'api' | 'mcp'
/** The step an approval is given in: the förattest, or the attest the policy asks for. */
export type AttestStage = 'pre' | 'final'

export const ATTEST_COMMENT_MAX = 1000
export const ATTEST_MAX_ATTESTERS = 50
/** How many projects may name their own förattestants (attest_project_attesters_valid). */
export const ATTEST_MAX_PROJECTS = 500
/** The longest substitution, in days between its first and last day. */
export const ATTEST_SUBSTITUTE_MAX_DAYS = 366

/** A substitution that runs today: `substitute_user_id` attests in the place of `user_id`. */
export interface AttestSubstitution {
  user_id: string
  substitute_user_id: string
}

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
  /** Förattest for an invoice (or a line) without a project of its own in project_attesters; empty or left out = none. */
  pre_attesters?: string[]
  /** Förattest per project: dimension 6 code to its attesters. Empty or left out = no project routing. */
  project_attesters?: Readonly<Record<string, readonly string[]>>
  /** The substitutions that run today (company_attest_substitutes). */
  substitutes?: readonly AttestSubstitution[]
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
  /**
   * The project (dimension 6) of each of its lines, null for a line without
   * one, distinct (invoiceProjects). Read only where the policy routes
   * projects (policyRoutesProjects); left out, the invoice reads as having
   * no project.
   */
  projects?: ReadonlyArray<string | null>
}

export interface AttestationRecord {
  user_id: string
  decision: AttestDecision
  decided_at: string
  comment?: string | null
  source?: AttestSource
  /** The step it was given in; null or left out = the attest (rows before #192). */
  stage?: AttestStage | null
  /** The attester a substitute acted for: the approval counts as theirs. */
  on_behalf_of?: string | null
}

/** The attesters' limits in SEK (company_attest_limits, scope supplier_invoice): user id to limit, null = no limit. A user without an entry has no limit. */
export type AttestLimits = ReadonlyMap<string, number | null>

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
  if (!companyAttestsSupplierInvoices(accountingMethod, policy.enabled)) return false
  if (invoice.is_credit_note) return false
  if (policy.threshold_amount === null || policy.threshold_amount === undefined) return true
  const sek = invoiceTotalSek(invoice)
  if (sek === null) return true
  return sek >= Number(policy.threshold_amount)
}

/**
 * The attesters who may attest this invoice: the policy's attesters, without
 * the registrant unless the policy lets the registrant attest, and only those
 * still active in the company (`activeMembers`: members whose attest can
 * count, isAttestRole; omitted = all of them count).
 */
export function eligibleAttesters(
  policy: AttestPolicy,
  invoice: Pick<AttestInvoiceFacts, 'user_id'>,
  activeMembers?: ReadonlySet<string>,
): string[] {
  return eligibleAmong(policy, invoice, policy.attesters, activeMembers)
}

/** `ids` without the registrant unless the policy lets the registrant attest, and only those still active. */
function eligibleAmong(
  policy: Pick<AttestPolicy, 'preparer_may_attest'>,
  invoice: Pick<AttestInvoiceFacts, 'user_id'>,
  ids: readonly string[],
  activeMembers?: ReadonlySet<string>,
): string[] {
  return [...new Set(ids)].filter(
    (id) => (policy.preparer_may_attest || id !== invoice.user_id) && (!activeMembers || activeMembers.has(id)),
  )
}

/** Byte order, as Postgres orders uuids and text under COLLATE "C". */
export const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** The same people, in any order. */
export const sameIdSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort(byteOrder).join(',') === [...b].sort(byteOrder).join(',')

const bagOf = (raw: unknown): LineDimensions | null => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as LineDimensions) : null)

/**
 * The projects of an invoice for the förattest: the project each line books
 * to, the line's dimension 6 merged over the invoice's (mergeDimensionBags,
 * the rule the registration verifikat uses: an empty line value clears it);
 * an invoice without lines has its own. Distinct, null for a line without a
 * project. The twin of the codes in supplier_invoice_pre_attest_groups.
 */
export function invoiceProjects(defaultDimensions: unknown, lines: ReadonlyArray<{ dimensions?: unknown }>): Array<string | null> {
  const projectOf = (line: unknown) => mergeDimensionBags(bagOf(defaultDimensions), bagOf(line))?.[DIM_PROJECT] ?? null
  if (lines.length === 0) return [projectOf(null)]
  return [...new Set(lines.map((line) => projectOf(line.dimensions)))]
}

/** The policy names förattestants per project: an invoice's projects decide its förattest. */
export function policyRoutesProjects(policy: Pick<AttestPolicy, 'project_attesters'>): boolean {
  return Object.values(policy.project_attesters ?? {}).some((ids) => ids.length > 0)
}

/** One förattest the invoice needs: by one of `attesters`, for `project` (null: lines without a project of their own). */
export interface PreAttestGroup {
  project: string | null
  attesters: string[]
}

/**
 * The förattest groups of an invoice: one per project on its lines that the
 * policy names attesters for, then one of pre_attesters when a line has no
 * project, or a project nobody is named for. Empty: no förattest, the
 * invoice goes straight to the attesters. The twin of
 * supplier_invoice_pre_attest_groups.
 */
export function preAttestGroups(policy: AttestPolicy, invoice: Pick<AttestInvoiceFacts, 'projects'>): PreAttestGroup[] {
  const routes = policy.project_attesters ?? {}
  const fallback = policy.pre_attesters ?? []
  const codes = invoice.projects && invoice.projects.length > 0 ? new Set(invoice.projects) : new Set<string | null>([null])
  const groups: PreAttestGroup[] = []
  let unrouted = false
  for (const code of codes) {
    const routed = code !== null && Object.prototype.hasOwnProperty.call(routes, code) ? routes[code] : undefined
    if (routed && routed.length > 0) groups.push({ project: code, attesters: [...new Set(routed)] })
    else unrouted = true
  }
  groups.sort((a, b) => byteOrder(a.project ?? '', b.project ?? ''))
  if (unrouted && fallback.length > 0) groups.push({ project: null, attesters: [...new Set(fallback)] })
  return groups
}

/** Whoever the user may act for today: themselves, then each attester whose substitute they are, in id order. */
export function actsFor(policy: Pick<AttestPolicy, 'substitutes'>, userId: string): string[] {
  const principals = (policy.substitutes ?? [])
    .filter((s) => s.substitute_user_id === userId && s.user_id !== userId)
    .map((s) => s.user_id)
  return [userId, ...[...new Set(principals)].sort(byteOrder)]
}

/** True when the user (or someone they stand in for today) attests at some step: an attester, a förattestant (default or for any project). */
export function attestsAtAnyStep(policy: AttestPolicy, userId: string): boolean {
  const named = new Set([...policy.attesters, ...(policy.pre_attesters ?? []), ...Object.values(policy.project_attesters ?? {}).flat()])
  return actsFor(policy, userId).some((id) => named.has(id))
}

export type MayAttestResult = { ok: true } | { ok: false; reason: 'not_attester' | 'registrant' }

/** True when `id` attests the invoice at some step: an attester, or a förattestant of one of its groups. */
function attestsInvoice(policy: AttestPolicy, groups: readonly PreAttestGroup[], id: string): boolean {
  return policy.attesters.includes(id) || groups.some((g) => g.attesters.includes(id))
}

/**
 * Whether this user may attest an invoice the policy requires attest for, at
 * some step: they (or someone they stand in for today) attest it, and they
 * did not register it unless the policy allows that. Which step and whose
 * place is ruleOnApproval's.
 */
export function mayAttest(
  policy: AttestPolicy,
  invoice: Pick<AttestInvoiceFacts, 'user_id' | 'projects'>,
  userId: string,
  groups: readonly PreAttestGroup[] = preAttestGroups(policy, invoice),
): MayAttestResult {
  if (!actsFor(policy, userId).some((id) => attestsInvoice(policy, groups, id))) return { ok: false, reason: 'not_attester' }
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

/** Whose approval a decision is: the attester a substitute acted for, else who made it. */
export function attestSlotOf(row: Pick<AttestationRecord, 'user_id' | 'on_behalf_of'>): string {
  return row.on_behalf_of ?? row.user_id
}

/** A förattest group as it stands: done once one of its attesters gave a förattest this round. */
export interface PreAttestGroupProgress extends PreAttestGroup {
  done: boolean
  /** Who gave it this round (the attester it counts for); null while missing. */
  approved_by: string | null
  /** Its attesters who may give the förattest (eligibleAmong). */
  eligible: string[]
}

/** A substitute who may give a missing approval in an attester's place today. */
export interface AttestStandIn {
  user_id: string
  /** The attester they stand in for (one of `remaining`). */
  for_user_id: string
}

export interface AttestProgress {
  /** The policy requires attest for this invoice. */
  required: boolean
  mode: AttestMode
  /** The policy is satisfied by the current round (always false when not required). */
  satisfied: boolean
  /** Eligible attesters whose attest (not förattest) counts in the current round, in order. */
  approved_by: string[]
  /**
   * Eligible attesters whose approval would move the invoice on, at the step
   * it is at: while a förattest is missing, the attesters of the groups
   * without one; then under `all` every attester still missing, under `any`
   * all of them, or only those whose limit covers the amount when a covering
   * approval is what is left.
   */
  remaining: string[]
  /** Everyone who may attest the invoice now (the attest step; whoever gave a förattest is no longer among them). */
  eligible: string[]
  /** Nobody can attest the invoice under the policy: a förattest group without an eligible attester, no eligible attester, none whose limit covers it, or fewer than the steps it needs. */
  blocked: boolean
  /** The invoice's total in SEK the levels judge; null when a foreign invoice has no rate. */
  amount_sek: number | null
  /** How many different attesters the attest needs (two at or above the two-step amount). */
  steps: 1 | 2
  /** How many more approvals the policy needs, förattests included; 0 when satisfied or not required. */
  approvals_needed: number
  /** One of the missing approvals must come from someone whose limit covers amount_sek. */
  needs_covering: boolean
  /** Only with förattest groups: 'pre' while one is missing, then 'final'. */
  stage?: AttestStage
  /** Only with förattest groups: each group, whether it is done and who may give it. */
  pre_groups?: PreAttestGroupProgress[]
  /** Only with förattest groups: whose förattest counts this round, in order. */
  pre_approved_by?: string[]
  /** Only with substitutes running: who may give a missing approval in the place of someone in `remaining`. */
  stand_ins?: AttestStandIn[]
}

/**
 * Where the attest of an invoice stands under the policy. A förattest first
 * when the invoice has förattest groups (preAttestGroups): every group needs
 * one approval by its eligible attesters. Then `any`: one approval by an
 * eligible attester satisfies it, two different ones from the two-step
 * amount, and at least one of them with a limit that covers the amount.
 * `all`: every eligible attester must approve (and one of them must cover
 * the amount). Approvals by people who are not (or no longer) eligible are
 * kept in the trail but do not count; an approval a substitute gave counts
 * as the attester's.
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
  const groups = required ? preAttestGroups(policy, invoice) : []
  const round = currentRound(attestations)
  const approvals = round.filter((row) => row.decision === 'approved')

  // The förattest: whose counts, and which groups it covers.
  const eligibleIn = groups.map((g) => eligibleAmong(policy, invoice, g.attesters, activeMembers))
  const preEligible = new Set(eligibleIn.flat())
  const preApprovedBy: string[] = []
  for (const row of approvals) {
    const slot = attestSlotOf(row)
    if (row.stage === 'pre' && preEligible.has(slot) && !preApprovedBy.includes(slot)) preApprovedBy.push(slot)
  }
  const preGroups: PreAttestGroupProgress[] = groups.map((g, i) => {
    const by = preApprovedBy.find((id) => g.attesters.includes(id)) ?? null
    return { ...g, eligible: eligibleIn[i]!, approved_by: by, done: by !== null }
  })
  const preMet = preGroups.every((g) => g.done)

  // The attest: the attesters, less whoever gave a förattest this round.
  const eligible = required ? eligibleAttesters(policy, invoice, activeMembers).filter((id) => !preApprovedBy.includes(id)) : []
  const amount = invoiceTotalSek(invoice)
  const steps = required ? attestStepsRequired(policy, amount) : 1
  const covers = (id: string) => limitCovers(attestLimitOf(limits, id), amount)
  const approvedBy: string[] = []
  for (const row of approvals) {
    const slot = attestSlotOf(row)
    if (row.stage !== 'pre' && eligible.includes(slot) && !approvedBy.includes(slot)) approvedBy.push(slot)
  }
  const covering = approvedBy.some(covers)
  const missing = eligible.filter((id) => !approvedBy.includes(id))
  const modeMet = policy.mode === 'any' ? approvedBy.length >= 1 : missing.length === 0
  const satisfied = required && preMet && eligible.length > 0 && modeMet && approvedBy.length >= steps && covering
  // Under `any`, a missing approval can come from anyone while the steps
  // still need more people than the one covering approval they need.
  const openToAnyone = steps - approvedBy.length - (covering ? 0 : 1) > 0
  const finalRemaining = policy.mode === 'all' || openToAnyone ? missing : missing.filter(covers)
  const preRemaining = [...new Set(preGroups.filter((g) => !g.done).flatMap((g) => g.eligible))].filter((id) => !approvedBy.includes(id))
  const remaining = satisfied ? [] : preMet ? finalRemaining : preRemaining
  const finalNeeded = policy.mode === 'all' ? missing.length : Math.max(steps - approvedBy.length, covering ? 0 : 1)
  const progress: AttestProgress = {
    required,
    mode: policy.mode,
    satisfied,
    approved_by: approvedBy,
    remaining,
    eligible,
    blocked:
      required &&
      (preGroups.some((g) => !g.done && g.eligible.length === 0) || eligible.length === 0 || eligible.length < steps || !eligible.some(covers)),
    amount_sek: amount,
    steps,
    approvals_needed: !required || satisfied ? 0 : finalNeeded + preGroups.filter((g) => !g.done).length,
    needs_covering: required && !satisfied && !covering,
  }
  if (preGroups.length > 0) {
    progress.stage = preMet ? 'final' : 'pre'
    progress.pre_groups = preGroups
    progress.pre_approved_by = preApprovedBy
  }
  const standIns = standInsFor(policy, invoice, round, remaining, activeMembers)
  if (standIns.length > 0) progress.stand_ins = standIns
  return progress
}

/**
 * The substitutes who may give a missing approval in the place of someone in
 * `remaining`: still members whose attest can count, not the registrant
 * unless allowed, not one of `remaining` themselves, and not someone who
 * already approved this round.
 */
function standInsFor(
  policy: AttestPolicy,
  invoice: Pick<AttestInvoiceFacts, 'user_id'>,
  round: readonly AttestationRecord[],
  remaining: readonly string[],
  activeMembers?: ReadonlySet<string>,
): AttestStandIn[] {
  const out: AttestStandIn[] = []
  for (const s of policy.substitutes ?? []) {
    if (!remaining.includes(s.user_id) || remaining.includes(s.substitute_user_id) || s.substitute_user_id === s.user_id) continue
    if (activeMembers && !activeMembers.has(s.substitute_user_id)) continue
    if (!policy.preparer_may_attest && s.substitute_user_id === invoice.user_id) continue
    if (round.some((row) => row.decision === 'approved' && row.user_id === s.substitute_user_id)) continue
    if (out.some((o) => o.user_id === s.substitute_user_id && o.for_user_id === s.user_id)) continue
    out.push({ user_id: s.substitute_user_id, for_user_id: s.user_id })
  }
  return out
}

/** Everyone whose approval would move the invoice on: `remaining` and the substitutes standing in for them. */
export function attestAskees(progress: Pick<AttestProgress, 'remaining' | 'stand_ins'>): string[] {
  return [...new Set([...progress.remaining, ...(progress.stand_ins ?? []).map((s) => s.user_id)])]
}

export type AttestRefusalReason = 'not_attester' | 'registrant' | 'not_member' | 'other_step'

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
   * applied to it: both go to the trail. With förattest groups `stage` says
   * which step it is given in; `onBehalfOf` names the attester a substitute
   * acts for.
   */
  | {
      kind: 'record'
      satisfies: boolean
      remainingAfter: string[]
      step: number
      limitSek: number | null
      stage?: AttestStage
      onBehalfOf?: string
    }

/**
 * May this user approve the invoice now, and what does the approval do?
 * `activeMembers` are the company's members whose attest can count
 * (isAttestRole, a viewer included): an attester who left the company or
 * became an invoicer is refused like anyone else. `levels` are the
 * attesters' limits and the key the attest comes through, if any.
 *
 * The approval takes the place of the first of the user and those they stand
 * in for today (actsFor) whom the step the invoice is at still needs; at the
 * attest step that person's limit applies.
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
  const groups = preAttestGroups(policy, invoice)
  const may = mayAttest(policy, invoice, userId, groups)
  if (!may.ok) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: may.reason }
  const candidates = actsFor(policy, userId)
  const round = currentRound(attestations)
  if (round.some((row) => row.decision === 'approved' && row.user_id === userId)) {
    return { kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' }
  }
  const limits = levels?.limits
  const before = attestProgress(policy, accountingMethod, invoice, attestations, activeMembers, limits)
  const pre = before.stage === 'pre'
  const used = [...(before.pre_approved_by ?? []), ...before.approved_by]
  // Who the step the invoice is at still needs.
  const stageSet = pre
    ? new Set((before.pre_groups ?? []).filter((g) => !g.done).flatMap((g) => g.eligible))
    : new Set(before.eligible)
  const slot = candidates.find((id) => stageSet.has(id) && !used.includes(id))
  if (slot === undefined) {
    if (candidates.some((id) => stageSet.has(id))) return { kind: 'refused', code: 'ATTEST_ALREADY_GIVEN' }
    return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'other_step' }
  }
  const amount = before.amount_sek
  let applied: number | null = null
  if (!pre) {
    applied = effectiveAttestLimit(policy, slot, levels)
    if (levels?.viaKey && attestLevelsOn(policy, limits) && !limitCovers(applied, amount)) {
      return { kind: 'refused', code: 'ATTEST_LIMIT_EXCEEDED', reason: 'key_limit', limit_sek: applied, amount_sek: amount }
    }
    const own = attestLimitOf(limits, slot)
    if (policy.mode === 'any' && !limitCovers(own, amount)) {
      // Not covering: the approval counts only while the round has room for
      // someone besides the covering approver it still needs.
      const covering = before.approved_by.some((id) => limitCovers(attestLimitOf(limits, id), amount))
      if (before.steps - before.approved_by.length - (covering ? 0 : 1) <= 0) {
        return { kind: 'refused', code: 'ATTEST_LIMIT_EXCEEDED', reason: 'limit', limit_sek: own, amount_sek: amount }
      }
    }
  }
  const stage: AttestStage = pre ? 'pre' : 'final'
  const after = attestProgress(
    policy,
    accountingMethod,
    invoice,
    [
      ...attestations,
      {
        user_id: userId,
        decision: 'approved',
        decided_at: '9999-12-31T23:59:59.999Z',
        stage,
        on_behalf_of: slot === userId ? null : slot,
      },
    ],
    activeMembers,
    limits,
  )
  return {
    kind: 'record',
    satisfies: after.satisfied,
    remainingAfter: after.remaining,
    step: used.length + 1,
    limitSek: applied,
    ...(groups.length > 0 ? { stage } : {}),
    ...(slot === userId ? {} : { onBehalfOf: slot }),
  }
}

/**
 * May this user reject the invoice? Whoever may approve at any step may
 * reject, at any step: under the policy an eligible attester or förattestant
 * of the invoice, or a substitute in their place (and one who already
 * approved in this round may still change their mind), without it anyone
 * with write access. `onBehalfOf` names the attester a substitute rejects for.
 */
export function ruleOnRejection(
  policy: AttestPolicy,
  accountingMethod: string | null | undefined,
  invoice: AttestInvoiceFacts,
  userId: string,
  activeMembers?: ReadonlySet<string>,
): { kind: 'unrestricted' } | { kind: 'record'; onBehalfOf?: string } | Extract<AttestRuling, { code: 'ATTEST_NOT_ALLOWED' }> {
  if (!invoiceNeedsAttest(policy, accountingMethod, invoice)) return { kind: 'unrestricted' }
  if (activeMembers && !activeMembers.has(userId)) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_member' }
  const groups = preAttestGroups(policy, invoice)
  const may = mayAttest(policy, invoice, userId, groups)
  if (!may.ok) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: may.reason }
  const slot = actsFor(policy, userId).find(
    (id) => attestsInvoice(policy, groups, id) && (policy.preparer_may_attest || id !== invoice.user_id) && (!activeMembers || activeMembers.has(id)),
  )
  if (slot === undefined) return { kind: 'refused', code: 'ATTEST_NOT_ALLOWED', reason: 'not_attester' }
  return slot === userId ? { kind: 'record' } : { kind: 'record', onBehalfOf: slot }
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
