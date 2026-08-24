import { z } from 'zod'

/**
 * Shared shapes for the account-keyed reconciliation surface.
 *
 * One engine, three doors: the dashboard routes, the public v1 API and the
 * MCP tools all speak these shapes, so the Zod schemas here are the single
 * source for OpenAPI (v1 registry), MCP input/output schemas and the UI
 * types. Kind-specific detail lives in a `bank` / `skattekonto` block; the
 * common block is what every caller can reason about without knowing the
 * account kind.
 *
 * Account keys:
 *   bank:<cash_account_id>   one cash_accounts row (PSD2 or file-fed)
 *   skattekonto              the company's Skatteverket tax account (BAS 1630)
 *   manual:<account_number>  any other balance account: reconciled against a
 *                            system specification (reskontra, semesterskuld)
 *                            or the balance the signer states from underlag
 */
export const ACCOUNT_KEY_REGEX =
  /^(bank:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|skattekonto|manual:\d{4})$/

export const AccountKeySchema = z.string().regex(ACCOUNT_KEY_REGEX, 'Ogiltig account_key')
export type AccountKey = z.infer<typeof AccountKeySchema>

export const ReconciliationKindSchema = z.enum(['bank', 'skattekonto', 'manual'])
export type ReconciliationKind = z.infer<typeof ReconciliationKindSchema>

export type ParsedAccountKey =
  | { kind: 'bank'; cashAccountId: string }
  | { kind: 'skattekonto' }
  | { kind: 'manual'; accountNumber: string }

export function parseAccountKey(key: string): ParsedAccountKey | null {
  if (!ACCOUNT_KEY_REGEX.test(key)) return null
  if (key === 'skattekonto') return { kind: 'skattekonto' }
  if (key.startsWith('bank:')) return { kind: 'bank', cashAccountId: key.slice('bank:'.length) }
  return { kind: 'manual', accountNumber: key.slice('manual:'.length) }
}

export function bankAccountKey(cashAccountId: string): string {
  return `bank:${cashAccountId}`
}

export const SKATTEKONTO_ACCOUNT_KEY = 'skattekonto' as const

export function manualAccountKey(accountNumber: string): string {
  return `manual:${accountNumber}`
}

export const ReconciliationSourceSchema = z.object({
  type: z.enum(['psd2', 'bank_file', 'skatteverket_api', 'skatteverket_file', 'manual']),
  /** ISO timestamp of the last successful sync / import; null when never. */
  synced_at: z.string().nullable(),
  /** True when the outside truth is older than STALE_AFTER_DAYS. */
  stale: z.boolean(),
})

export const ReconciliationStateSchema = z.enum([
  'reconciled',
  'open',
  'stale',
  'not_configured',
])

/** The latest active sign-off on an account: "avstämt t.o.m. through_date" with the numbers as they stood. */
export const ReconciliationSignoffSchema = z.object({
  id: z.string(),
  account_key: AccountKeySchema,
  through_date: z.string(),
  external_balance: z.number().nullable(),
  ledger_balance: z.number().nullable(),
  unexplained_difference: z.number().nullable(),
  note: z.string().nullable(),
  signed_by: z.string(),
  signed_at: z.string(),
  reopened_at: z.string().nullable(),
  reopened_by: z.string().nullable(),
  reopen_reason: z.string().nullable(),
})
export type ReconciliationSignoff = z.infer<typeof ReconciliationSignoffSchema>

export const ReconciliationAccountSchema = z.object({
  account_key: AccountKeySchema,
  kind: ReconciliationKindSchema,
  account_number: z.string(),
  name: z.string(),
  currency: z.string(),
  logo_url: z.string().nullable(),
  source: ReconciliationSourceSchema,
  status: z
    .object({
      state: ReconciliationStateSchema,
      /** ISO timestamp the status was computed for (snapshot time or now). */
      as_of: z.string(),
      unexplained_difference: z.number().nullable(),
      open_counts: z.object({
        proposed: z.number().int(),
        unmatched_external: z.number().int(),
        unmatched_ledger: z.number().int(),
      }),
    })
    .nullable(),
  /** Another enabled cash account shares this IBAN and currency (reconnect duplicate). */
  superseded_by: AccountKeySchema.nullable(),
  /** through_date of the latest active sign-off, null when the account was never signed off. */
  signed_off_through: z.string().nullable().optional(),
})
export type ReconciliationAccount = z.infer<typeof ReconciliationAccountSchema>

/** One explanatory line of the bridge: label + amount + the filter that lists its rows. */
export const BridgeLineSchema = z.object({
  key: z.string(),
  label_sv: z.string(),
  label_en: z.string(),
  amount: z.number(),
  count: z.number().int().nullable(),
  /** Bucket to request from the items endpoint to see these rows, when any. */
  items_bucket: z.string().nullable(),
})
export type BridgeLine = z.infer<typeof BridgeLineSchema>

export const ReconciliationItemBucketSchema = z.enum([
  'proposed',
  'unmatched_external',
  'unmatched_ledger',
  'matched',
  'ignored',
  'upcoming',
])
export type ReconciliationItemBucket = z.infer<typeof ReconciliationItemBucketSchema>

export const ReconciliationItemActionSchema = z.enum([
  'match',
  'unmatch',
  'book',
  'ignore',
  'unignore',
  'review',
])

export const ReconciliationProposalSchema = z.object({
  journal_entry_id: z.string(),
  voucher_number: z.number().int().nullable(),
  voucher_series: z.string().nullable(),
  entry_date: z.string(),
  description: z.string(),
  entry_status: z.enum(['draft', 'posted', 'reversed']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
})
export type ReconciliationProposal = z.infer<typeof ReconciliationProposalSchema>

export const ReconciliationItemSchema = z.object({
  /** Qualified id of the row on its side: skattekonto_transaction_id, transaction_id or journal_entry_id. */
  item_id: z.string(),
  item_type: z.enum(['skattekonto_transaction', 'transaction', 'journal_entry']),
  side: z.enum(['external', 'ledger']),
  bucket: ReconciliationItemBucketSchema,
  date: z.string(),
  description: z.string(),
  /** Signed amount in the account's natural direction (debit positive on the ledger side). */
  amount: z.number(),
  currency: z.string(),
  voucher_number: z.number().int().nullable().optional(),
  voucher_series: z.string().nullable().optional(),
  entry_status: z.enum(['draft', 'posted', 'reversed']).optional(),
  /** Linked counterpart on the other side, when any. */
  linked_journal_entry_id: z.string().nullable().optional(),
  /** Why a linked row is not counted as settled (the entry was reversed or is still a draft). */
  link_problem: z.enum(['entry_reversed', 'entry_draft', 'entry_missing']).nullable().optional(),
  proposal: ReconciliationProposalSchema.nullable().optional(),
  /** Ledger line dated within AWAITING_EXTERNAL_DAYS of the snapshot: the outside side may simply not have posted it yet. */
  awaiting_external: z.boolean().optional(),
  actions: z.array(ReconciliationItemActionSchema),
})
export type ReconciliationItem = z.infer<typeof ReconciliationItemSchema>

export const SkattekontoStatusBlockSchema = z.object({
  saldo_skatteverket: z.number().nullable(),
  /** ISO timestamp of the saldo snapshot; null when never synced. */
  fetched_at: z.string().nullable(),
  /** Earliest SKV-posted row we hold: the start of the comparable history. */
  history_start: z.string().nullable(),
  /** saldo_at_start - ledger balance before history_start. Null without a snapshot. */
  opening_difference: z.number().nullable(),
  upcoming_count: z.number().int(),
  upcoming_total: z.number(),
  ledger_balance_before_start: z.number().nullable(),
})

/** A specification the system keeps for a manual account, in ledger sign (debit positive). */
export const ManualSpecificationSchema = z.object({
  provider: z.enum(['ar', 'ap', 'vacation']),
  label_sv: z.string(),
  label_en: z.string(),
  amount: z.number(),
  /** Foreign-currency rows left out for lack of a rate (see lib/reports/ar-reconciliation.ts). */
  unconverted_fx_count: z.number().int(),
})
export type ManualSpecification = z.infer<typeof ManualSpecificationSchema>

export const ManualStatusBlockSchema = z.object({
  period_id: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  /** IB, movement and UB through the balansdag, debit positive (lib/reconciliation/manual-reconciliation.ts). */
  opening_balance: z.number(),
  movement: z.number(),
  closing_balance: z.number(),
  /** Null for accounts whose outside balance the signer states at sign-off. */
  specification: ManualSpecificationSchema.nullable(),
})

export const ReconciliationStatusSchema = z.object({
  account_key: AccountKeySchema,
  kind: ReconciliationKindSchema,
  account_number: z.string(),
  currency: z.string(),
  window: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  as_of: z.string(),
  stale: z.boolean(),
  /** What the outside says (bank balance or Skatteverket saldo); null when unknown. */
  external_balance: z.number().nullable(),
  /** What the ledger says on the account (balance for skattekonto, period movement for bank). */
  ledger_balance: z.number().nullable(),
  difference: z.number().nullable(),
  unexplained_difference: z.number().nullable(),
  is_reconciled: z.boolean(),
  bridge: z.array(BridgeLineSchema),
  counts: z.object({
    proposed: z.number().int(),
    unmatched_external: z.number().int(),
    unmatched_ledger: z.number().int(),
    matched: z.number().int(),
    ignored: z.number().int(),
  }),
  skattekonto: SkattekontoStatusBlockSchema.nullable(),
  /** Today's bank status fields, unchanged, for the bank kind (see bank-reconciliation.ts). */
  bank: z.record(z.string(), z.unknown()).nullable(),
  /** Balances and specification for the manual kind; absent on the other kinds. */
  manual: ManualStatusBlockSchema.nullable().optional(),
  /** Latest active sign-off on the account (lib/reconciliation/signoff.ts); null when none. */
  signoff: ReconciliationSignoffSchema.nullable().optional(),
})
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>

/** Outside truth older than this is flagged stale on every read. */
export const STALE_AFTER_DAYS = 7

/** A ledger line this close to the snapshot may simply be waiting for Skatteverket to post the same event. */
export const AWAITING_EXTERNAL_DAYS = 5
