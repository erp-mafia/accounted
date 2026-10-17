/**
 * Grants: dated company rules that let an agent book a known counterparty's
 * bank lines without waiting for a person, within limits, reviewed after
 * (Profiles and Suggestions, step 4; migrations 20261017100000-100500).
 *
 * A grant is a versioned rule (company_grants): the operation it covers
 * (today only categorize_transaction, a bank line booked by category), the
 * counterparty as the system keys it (grant_counterparty_key), the booking
 * pattern the company approved (direction, category, VAT treatment, the
 * business account and every account the posting touches), the limits (SEK
 * per posting, optionally per month), who may use it (any key credential, or
 * one named API key or service account), and who accepted it when. It is
 * created only by an approved create_grant operation and revoked only by an
 * approved revoke_grant, so each change has a receipt, an audit row and a
 * dated line in behandlingshistorik (BFNAR 2013:2 p. 9.16).
 *
 * Pure types and schemas, no server imports.
 */
import { z } from 'zod'

/** The operations a grant can cover today. */
export const GRANT_OPERATION_TYPES = ['categorize_transaction'] as const
export type GrantOperationType = (typeof GRANT_OPERATION_TYPES)[number]

/**
 * Bump when the rule a grant decision is made under changes on purpose (the
 * claim gate's checks). Recorded in the receipt's policy_version with the
 * grant id and version, so a receipt names the exact rule that let the
 * posting through.
 */
export const GRANT_POLICY_REVISION = 1

/** The receipt's policy_version for a posting a grant let through. */
export function grantPolicyVersion(grant: { grantId: string; grantVersion: number }): string {
  return `grant.${GRANT_POLICY_REVISION};grant_id=${grant.grantId};grant_version=${grant.grantVersion}`
}

/** Whether a receipt's policy_version names a grant, and which. */
export function parseGrantPolicyVersion(policy: string | null | undefined): { grantId: string; grantVersion: number } | null {
  if (!policy) return null
  const match = /^grant\.\d+;grant_id=([0-9a-f-]{36});grant_version=(\d+)$/i.exec(policy)
  return match ? { grantId: match[1].toLowerCase(), grantVersion: Number(match[2]) } : null
}

const ACCOUNT = z.string().regex(/^\d{4}$/)

/** Who may use a grant. */
export const GrantCredentialSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('any') }).strict(),
  z.object({ kind: z.literal('api_key'), api_key_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal('service_account'), service_account_id: z.string().uuid() }).strict(),
])
export type GrantCredential = z.infer<typeof GrantCredentialSchema>

/** The booking pattern a grant permits: exactly this, nothing near it. */
export const GrantPatternSchema = z
  .object({
    direction: z.enum(['out', 'in']),
    category: z
      .string()
      .regex(/^(expense|income)_[a-z_]+$/)
      .refine((c) => c !== 'expense_representation', { message: 'representation is never granted' }),
    vat_treatment: z.string().regex(/^[a-z0-9_]{1,40}$/).nullable(),
    reverse_charge_kind: z.string().regex(/^[a-z_]{1,40}$/).nullable(),
    account_number: ACCOUNT,
    line_accounts: z.array(ACCOUNT).min(2).max(8),
  })
  .strict()
  .refine((p) => p.line_accounts.includes(p.account_number), { message: 'line_accounts must include account_number' })
export type GrantPattern = z.infer<typeof GrantPatternSchema>

/** pending_operations.params of create_grant. */
export const CreateGrantParamsSchema = z
  .object({
    operation_type: z.enum(GRANT_OPERATION_TYPES),
    counterparty_key: z.string().min(2).max(200),
    counterparty_label: z.string().min(1).max(200),
    pattern: GrantPatternSchema,
    amount_limit_sek: z.number().positive().max(10_000_000),
    monthly_limit_sek: z.number().positive().max(100_000_000).nullable().optional(),
    credential: GrantCredentialSchema,
    evidence: z
      .object({
        booking_count: z.number().int().nonnegative(),
        max_amount_sek: z.number().nonnegative().nullable(),
        last_booked: z.string().nullable(),
      })
      .partial()
      .optional(),
    /** suggestion: the grant-suggestion detector proposed it. */
    source: z.enum(['suggestion']).optional(),
    /** Set by stage_company_suggestion on every suggestion. */
    suggestion_key: z.string().optional(),
  })
  .strict()
  .refine((p) => p.monthly_limit_sek == null || p.monthly_limit_sek >= p.amount_limit_sek, {
    message: 'monthly_limit_sek must be at least amount_limit_sek',
    path: ['monthly_limit_sek'],
  })
export type CreateGrantParams = z.infer<typeof CreateGrantParamsSchema>

/** pending_operations.params of revoke_grant. */
export const RevokeGrantParamsSchema = z
  .object({
    grant_id: z.string().uuid(),
    /** The rule as the person saw it when they asked to revoke it (for the approval card). */
    counterparty_label: z.string().max(200).optional(),
  })
  .strict()
export type RevokeGrantParams = z.infer<typeof RevokeGrantParamsSchema>

/**
 * Why a staged operation did not go through under a grant. Every reason
 * leaves the operation pending for a person, exactly as without grants.
 */
export const GRANT_REFUSAL_REASONS = [
  'no_grant',
  'operation_not_found',
  'operation_not_pending',
  'operation_type_not_granted',
  'batch_staged',
  'not_a_key_credential',
  'credential_mismatch',
  'paused',
  'credential_revoked',
  'credential_not_live',
  'credential_not_member',
  'allow_duplicate',
  'vat_amount_override',
  'dimensions',
  'transaction_not_found',
  'transaction_already_booked',
  'transaction_already_claimed',
  'unknown_counterparty',
  'pattern_unreadable',
  'period_locked',
  'no_grant_for_counterparty',
  'pattern_mismatch',
  'credential_not_allowed',
  'above_limit',
  'above_unattended_limit',
  'above_monthly_limit',
] as const
export type GrantRefusalReason = (typeof GRANT_REFUSAL_REASONS)[number]

/**
 * Refusals that mean "no grant was in play" for this operation: the agent is
 * told nothing about grants for them. The rest name a grant the operation
 * came close to, and the agent is told why it still waits for a person.
 */
export const SILENT_GRANT_REFUSALS: ReadonlySet<string> = new Set([
  // GRANT_SUGGESTIONS is off: the feature does not exist on this installation.
  'switched_off',
  'no_grant',
  'operation_not_found',
  'operation_not_pending',
  'operation_type_not_granted',
  'not_a_key_credential',
  'unknown_counterparty',
  'no_grant_for_counterparty',
])

/** One posting a grant let through, as Att göra and the agent briefing list it. */
export interface GrantPosting {
  use_id: string
  grant_id: string
  grant_version: number
  counterparty_label: string
  account_number: string
  amount_limit_sek: number
  grant_accepted_at: string
  grant_revoked_at: string | null
  pending_operation_id: string | null
  transaction_id: string | null
  journal_entry_id: string | null
  voucher: string | null
  entry_status: string | null
  entry_date: string
  amount_sek: number
  /** After the commit: the posted lines touch exactly the grant's accounts, within its limit. Null when unchecked. */
  pattern_verified: boolean | null
  committed_at: string | null
  reviewed_at: string | null
}

/** What the review surfaces read: the postings to look at and whether grants are paused. */
export interface GrantReview {
  postings: GrantPosting[]
  paused: boolean
  /** The company has at least one active grant. */
  has_active_grants: boolean
}
