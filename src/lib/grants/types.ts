/**
 * Grants: dated company rules that let an agent book a known counterparty's
 * bank lines without waiting for a person, within limits, reviewed after
 * (Profiles and Suggestions, step 4; migrations 20261017100000-100500).
 *
 * A grant is a versioned rule (company_grants): the operation it covers, the
 * counterparty, the booking pattern the company approved, the limits (SEK per
 * posting, optionally per month), who may use it (any key credential, or one
 * named API key or service account), and who accepted it when. Two
 * operations today:
 *   - categorize_transaction, a bank line booked by category: keyed by the
 *     counterparty as the bank text names it (grant_counterparty_key), the
 *     pattern is the direction, category, VAT treatment, the business
 *     account and every account the posting touches;
 *   - create_supplier_invoice_from_inbox, a known supplier's invoice from the
 *     inbox registered and booked in one commit (slice 2, migrations
 *     20261018100000-100300): keyed by the supplier's id, the pattern is the
 *     VAT treatment, the reverse-charge kind, every invoice line's account
 *     and VAT rate, and every account the registration verifikat touches.
 * It is
 * created only by an approved create_grant operation and revoked only by an
 * approved revoke_grant, so each change has a receipt, an audit row and a
 * dated line in behandlingshistorik (BFNAR 2013:2 p. 9.16).
 *
 * Pure types and schemas, no server imports.
 */
import { z } from 'zod'

/** The operations a grant can cover today. */
export const GRANT_OPERATION_TYPES = ['categorize_transaction', 'create_supplier_invoice_from_inbox'] as const
export type GrantOperationType = (typeof GRANT_OPERATION_TYPES)[number]

/** The supplier-invoice grant's operation: a known supplier's invoice from the inbox. */
export const SUPPLIER_INVOICE_GRANT_OPERATION = 'create_supplier_invoice_from_inbox' as const

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

/** The VAT treatments a supplier invoice is registered under (gnubok_create_supplier_invoice_from_inbox). */
export const SUPPLIER_INVOICE_VAT_TREATMENTS = ['standard_25', 'reduced_12', 'reduced_6', 'reverse_charge', 'export', 'exempt'] as const

/** The reverse-charge kind a supplier's type books (reverseChargeKindForSupplierType). */
export const SUPPLIER_REVERSE_CHARGE_KINDS = ['eu_services', 'non_eu_services', 'domestic_services'] as const

/** One invoice line's booking: '<account>:<VAT %>', e.g. '6212:25'. */
export const GRANT_ITEM_LINE = /^(\d{4}):(0|6|12|25)$/

/** The booking pattern a supplier-invoice grant permits: exactly this, nothing near it. */
export const SupplierInvoiceGrantPatternSchema = z
  .object({
    vat_treatment: z.enum(SUPPLIER_INVOICE_VAT_TREATMENTS),
    reverse_charge_kind: z.enum(SUPPLIER_REVERSE_CHARGE_KINDS).nullable(),
    // Which accounts a line may use (cost accounts, never representation or
    // a balance account) and that the verifikat credits the supplier debt
    // are the database's to decide: create_company_grant and
    // grant_item_account_allowed (migration 20261018100100) refuse the rest.
    item_lines: z.array(z.string().regex(GRANT_ITEM_LINE)).min(1).max(12),
    line_accounts: z.array(ACCOUNT).min(2).max(16),
  })
  .strict()
  .refine((p) => (p.reverse_charge_kind !== null) === (p.vat_treatment === 'reverse_charge'), {
    message: 'a reverse-charge kind exactly under reverse charge',
    path: ['reverse_charge_kind'],
  })
  .refine((p) => p.item_lines.every((l) => p.line_accounts.includes(l.split(':')[0])), {
    message: 'line_accounts must include every line account',
    path: ['line_accounts'],
  })
export type SupplierInvoiceGrantPattern = z.infer<typeof SupplierInvoiceGrantPatternSchema>

const GrantLimitsShape = {
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
}

const monthlyAtLeastLimit = {
  check: (p: { amount_limit_sek: number; monthly_limit_sek?: number | null }) =>
    p.monthly_limit_sek == null || p.monthly_limit_sek >= p.amount_limit_sek,
  message: { message: 'monthly_limit_sek must be at least amount_limit_sek', path: ['monthly_limit_sek'] },
}

/** create_grant for a bank line booked by category (slice 1). */
export const CategorizeGrantParamsSchema = z
  .object({
    operation_type: z.literal('categorize_transaction'),
    counterparty_key: z.string().min(2).max(200),
    counterparty_label: z.string().min(1).max(200),
    pattern: GrantPatternSchema,
    ...GrantLimitsShape,
  })
  .strict()
  .refine(monthlyAtLeastLimit.check, monthlyAtLeastLimit.message)

/** create_grant for a known supplier's invoices from the inbox (slice 2). */
export const SupplierInvoiceGrantParamsSchema = z
  .object({
    operation_type: z.literal(SUPPLIER_INVOICE_GRANT_OPERATION),
    supplier_id: z.string().uuid(),
    counterparty_label: z.string().min(1).max(200),
    pattern: SupplierInvoiceGrantPatternSchema,
    ...GrantLimitsShape,
  })
  .strict()
  .refine(monthlyAtLeastLimit.check, monthlyAtLeastLimit.message)

/** pending_operations.params of create_grant: one of the two shapes, by operation_type. */
export const CreateGrantParamsSchema = z.discriminatedUnion('operation_type', [
  CategorizeGrantParamsSchema,
  SupplierInvoiceGrantParamsSchema,
])
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
  // A supplier invoice from the inbox (slice 2).
  'unknown_supplier',
  'register_booked',
  'unsupported_params',
  'foreign_currency',
  'special_payroll_tax',
  'credit_note',
  'negative_line',
  'payment_details',
  'preview_warning',
  'underlag_missing',
  'inbox_item_not_found',
  'inbox_item_already_booked',
  'inbox_item_already_claimed',
  'duplicate_invoice_number',
  'registration_not_booked',
] as const

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
  // No rule for the supplier the staged invoice names.
  'unknown_supplier',
])

/** One posting a grant let through, as Att göra and the agent briefing list it. */
export interface GrantPosting {
  use_id: string
  grant_id: string
  grant_version: number
  /** The operation the rule covers; categorize_transaction before migration 20261018100200. */
  operation_type: GrantOperationType
  counterparty_label: string
  /** A bank-line rule's business account; empty for a supplier-invoice rule (see item_lines). */
  account_number: string
  /** A supplier-invoice rule's line bookings ('6212:25'); empty for a bank-line rule. */
  item_lines: string[]
  amount_limit_sek: number
  grant_accepted_at: string
  grant_revoked_at: string | null
  pending_operation_id: string | null
  transaction_id: string | null
  /** The supplier invoice a supplier-invoice rule registered; null for a bank line. */
  supplier_invoice_id: string | null
  /** The inbox item a supplier-invoice rule booked; null for a bank line. */
  inbox_item_id: string | null
  journal_entry_id: string | null
  voucher: string | null
  entry_status: string | null
  entry_date: string
  amount_sek: number
  /** After the commit: the posted lines touch exactly the grant's accounts, within its limit. Null when unchecked. */
  pattern_verified: boolean | null
  committed_at: string | null
  reviewed_at: string | null
  /**
   * The agent that staged the operation the rule let through, and the person
   * it acted for (its pending_operations row). Read only when asked for
   * (loadGrantReview withAgents); null when not read or not found.
   */
  agent?: { actor_type: string; actor_label: string | null; user_id: string | null } | null
}

/** What the review surfaces read: the postings to look at and whether grants are paused. */
export interface GrantReview {
  postings: GrantPosting[]
  paused: boolean
  /** The company has at least one active grant. */
  has_active_grants: boolean
}
