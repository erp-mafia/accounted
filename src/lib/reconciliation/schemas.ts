import { z } from 'zod'
import { MAX_BANK_ROW_SPLIT, MAX_LINK_REQUEST_ENTRIES } from './limits'

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

export const ReconciliationKindSchema = z.enum(['bank', 'skattekonto', 'manual'])

/**
 * One link request: outside rows against verifikat (N:1, on the skattekonto
 * optionally with a remainder), one row against several verifikat (1:N: bank
 * with optional allocations, skattekonto at the open amounts), or, on a bank
 * account, NO outside rows and two or more
 * verifikat that take each other out on the account (a wrong verifikat and
 * the rättelse booked by hand: lib/reconciliation/ledger-settlement.ts).
 */
export const ReconciliationPairSchema = z
  .object({
    // Empty or omitted only for the ledger-only shape.
    external_ids: z.array(z.string().uuid()).max(50).default([]),
    // Up to MAX_BANK_ROW_SPLIT for a bank 1:N split; the other shapes carry
    // one verifikat, or are capped by their own engine (ledger-settlement.ts).
    journal_entry_ids: z.array(z.string().uuid()).min(1).max(MAX_BANK_ROW_SPLIT),
    // 1:N only: the signed slice per verifikat (the row's sign convention).
    // Bank, omitted: each slice defaults to the voucher's bank line.
    // Skattekonto: must equal each verifikat's open amount on 1630.
    allocations: z
      .array(z.object({ journal_entry_id: z.string().uuid(), amount: z.number() }))
      .min(2)
      .max(MAX_BANK_ROW_SPLIT)
      .optional(),
    // Skattekonto only: link although the rows do not settle the verifikat's
    // 1630 movement (a summarised verifikat that books more events than these).
    // What the rows do not explain stays on the verifikat as its remainder.
    allow_remainder: z.boolean().optional(),
  })
  .refine((pair) => pair.external_ids.length > 0 || pair.journal_entry_ids.length >= 2, {
    path: ['external_ids'],
    message:
      'Ange minst en händelse i external_ids, eller minst två verifikat i journal_entry_ids som tar ut varandra på kontot.',
  })

/** Body fields shared by the dashboard and v1 POST .../links routes (spread into z.object). */
export const reconciliationLinksBodyFields = {
  pairs: z
    .array(ReconciliationPairSchema)
    .max(200)
    .refine(
      (pairs) => pairs.reduce((sum, p) => sum + p.journal_entry_ids.length, 0) <= MAX_LINK_REQUEST_ENTRIES,
      { message: `Högst ${MAX_LINK_REQUEST_ENTRIES} verifikat per anrop, sammanlagt över alla par.` },
    )
    .optional(),
  use_proposals: z.boolean().optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
}

/** The links body must carry explicit pairs or opt into the persisted proposals. */
export const reconciliationLinksBodyRefinement = [
  (b: { pairs?: unknown[]; use_proposals?: boolean }) =>
    (b.pairs && b.pairs.length > 0) || b.use_proposals === true,
  { message: 'Ange pairs eller use_proposals: true.' },
] as const

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

/** One underlag file attached to an account's balansdag (account_reconciliation_attachments). */
export const ReconciliationAttachmentSchema = z.object({
  id: z.string(),
  account_key: AccountKeySchema,
  through_date: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int(),
  sha256: z.string(),
  note: z.string().nullable(),
  uploaded_by: z.string(),
  uploaded_at: z.string(),
  removed_at: z.string().nullable(),
  removed_by: z.string().nullable(),
  removed_reason: z.string().nullable(),
})
export type ReconciliationAttachment = z.infer<typeof ReconciliationAttachmentSchema>

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
  /** Balance the outside last reported (bank or Skatteverket saldo); null when unknown, absent for manual accounts. */
  balance: z.number().nullable().optional(),
  /** ISO timestamp of that balance; null when unknown. */
  balance_at: z.string().nullable().optional(),
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
  /**
   * Only when asked for by name: rows dated before history_start, outside
   * the bridge and its counts. Skattekonto: open rows (not linked, not
   * ignored) the 1630 ingående balans carries (crm#1153), listed so an agent
   * can link them to the imported verifikat (a standing proposal rides
   * along) or ignore them. Bank: verifikat with no bank link dated before the
   * first day the bank side covers (bank.history_start, crm#1221); no bank
   * row can match them until older bank history is imported.
   */
  'before_history',
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

/** One verifikat of a set proposal: its bank leg in the row's direction, positive, in the account currency. */
export const ReconciliationProposalVoucherSchema = z.object({
  journal_entry_id: z.string(),
  voucher_number: z.number().int().nullable(),
  voucher_series: z.string().nullable(),
  entry_date: z.string(),
  description: z.string(),
  amount: z.number(),
})

export const ReconciliationProposalSchema = z.object({
  journal_entry_id: z.string(),
  voucher_number: z.number().int().nullable(),
  voucher_series: z.string().nullable(),
  entry_date: z.string(),
  description: z.string(),
  entry_status: z.enum(['draft', 'posted', 'reversed']),
  confidence: z.number().min(0).max(1),
  reasons: z.array(z.string()),
  /**
   * Present when the proposal is an explaining SET of unlinked verifikat whose
   * bank legs sum exactly to the row (#2293, computed at read time): the row
   * is linked to all of them (1:N) and journal_entry_id is the first. Length 1
   * is one voucher of the exact amount the 1:1 matcher missed (dated 4 to 7
   * days off). Absent on persisted 1:1 proposals. Apply with explicit pairs
   * (journal_entry_ids = every voucher) or use_proposals, which links the
   * listing's own proposals (crm#1668).
   */
  vouchers: z.array(ReconciliationProposalVoucherSchema).min(1).optional(),
  /**
   * Skattekonto only: present when several open Skatteverket rows settle this
   * verifikat together (one combined 1630 line for avdragen skatt +
   * arbetsgivaravgift, crm#128). Every row id of the group, this one
   * included; apply them as ONE pair (external_ids = this list), all or
   * nothing. use_proposals groups them the same way.
   */
  external_ids: z.array(z.string()).min(2).optional(),
})
export type ReconciliationProposal = z.infer<typeof ReconciliationProposalSchema>

/**
 * A ledger-only settlement a verifikat belongs to: verifikat on the account
 * that take each other out (a wrong verifikat and its hand-made rättelse).
 */
export const ReconciliationSettlementSchema = z.object({
  /** Undo with DELETE .../links/{settlement_id}, or reconcile_unmatch with settlement_id. */
  settlement_id: z.string(),
  /**
   * settled: the settlement holds and the verifikat is listed under matched.
   * broken: another verifikat of it has since been linked to a bank row,
   * makulerat or changed, so this one is unmatched again until the settlement
   * is undone.
   */
  state: z.enum(['settled', 'broken']),
  settled_at: z.string(),
  settled_by: z.string(),
  /** The other verifikat of the settlement, each with the amount it was settled at (debit positive). */
  counterparts: z.array(
    z.object({
      journal_entry_id: z.string(),
      voucher_series: z.string().nullable(),
      voucher_number: z.number().int().nullable(),
      entry_date: z.string().nullable(),
      amount: z.number(),
    }),
  ),
})

export const ReconciliationItemSchema = z.object({
  /** Qualified id of the row on its side: skattekonto_transaction_id, transaction_id or journal_entry_id. */
  item_id: z.string(),
  item_type: z.enum(['skattekonto_transaction', 'transaction', 'journal_entry']),
  side: z.enum(['external', 'ledger']),
  bucket: ReconciliationItemBucketSchema,
  date: z.string(),
  description: z.string(),
  /** Signed amount in the account's natural direction (debit positive on the ledger side), in `currency`. */
  amount: z.number(),
  /**
   * The currency `amount` is in. A bank row is in the account's currency. A
   * verifikat on a foreign account is too when its lines state their amount
   * in it; otherwise it is listed in SEK and says so.
   */
  currency: z.string(),
  voucher_number: z.number().int().nullable().optional(),
  voucher_series: z.string().nullable().optional(),
  entry_status: z.enum(['draft', 'posted', 'reversed']).optional(),
  /** Linked counterpart on the other side, when any. */
  linked_journal_entry_id: z.string().nullable().optional(),
  /** The linked verifikat's date, label and text, so the ledger side reads as a verifikat and not as an id. */
  linked_entry: z
    .object({
      entry_date: z.string(),
      voucher_series: z.string().nullable(),
      voucher_number: z.number().int().nullable(),
      description: z.string(),
    })
    .nullable()
    .optional(),
  /** Why a linked row is not counted as settled (the entry was reversed or is still a draft). */
  link_problem: z.enum(['entry_reversed', 'entry_draft', 'entry_missing']).nullable().optional(),
  proposal: ReconciliationProposalSchema.nullable().optional(),
  /** Ledger line dated within AWAITING_EXTERNAL_DAYS of the snapshot: the outside side may simply not have posted it yet. */
  awaiting_external: z.boolean().optional(),
  /**
   * Bank ledger rows only: the verifikat could be the account's opening
   * balance (booked manually or by import, dated on its fiscal year's first
   * day, no bank link), so "Märk som IB" applies. False for a verifikat dated
   * in the year: a rättelse or payment is a movement, never an IB.
   */
  ib_eligible: z.boolean().optional(),
  /**
   * Skattekonto ledger rows only: Skatteverket rows are linked to this
   * verifikat without explaining all of it (a summarised verifikat, or one
   * matched line of several on 1630). `amount` is then what remains:
   * entry_amount - linked_amount, in ledger sign, of either sign.
   */
  partially_linked: z
    .object({
      /** The verifikat's whole net on 1630. */
      entry_amount: z.number(),
      /** Sum of the Skatteverket rows linked to it. */
      linked_amount: z.number(),
      linked_count: z.number().int(),
    })
    .optional(),
  /**
   * Skattekonto ledger rows only: Skatteverket rows point at this verifikat
   * without being counted in the comparison yet (an upcoming row booked
   * ahead, or a row dated after the fetched saldo), so `amount` does not
   * subtract them. A new link to the verifikat is still judged with them on
   * it and can answer ALREADY_LINKED: unlink a holder by its id when its
   * link is the wrong one. `amount` is their sum; external_ids lists at most
   * 20 of them.
   */
  held_by_uncounted_rows: z
    .object({
      count: z.number().int(),
      amount: z.number(),
      external_ids: z.array(z.string()),
    })
    .optional(),
  /**
   * Skattekonto outside rows only: the event is already in the ledger through
   * verifikat on 1630 that no row is linked to (see skattekonto.covered).
   * Link it; booking it would record it a second time.
   */
  covered_by_ledger: z.boolean().optional(),
  /**
   * Bucket before_history: the row is dated before history_start and counts
   * in no bridge line. Skattekonto outside row: the ingående balans on 1630
   * carries it; link it to the verifikat that holds it, or ignore it. Bank
   * ledger row: the bank has no row that early; import the older history to
   * match it.
   */
  before_history: z.boolean().optional(),
  /** Ledger rows: the settlement the verifikat is part of, when any (bank, and the skattekonto's 1:N links). */
  settlement: ReconciliationSettlementSchema.nullable().optional(),
  actions: z.array(ReconciliationItemActionSchema),
})
export type ReconciliationItem = z.infer<typeof ReconciliationItemSchema>

export const SkattekontoStatusBlockSchema = z.object({
  saldo_skatteverket: z.number().nullable(),
  /**
   * Why saldo_skatteverket is null: 'not_connected' when the company has no
   * Skatteverket connection (a saldo fetched before a disconnect is no
   * reading either, crm#1701), 'not_fetched' when none was fetched yet.
   * Null when the saldo is known.
   */
  saldo_missing_reason: z.enum(['not_connected', 'not_fetched']).nullable().optional(),
  /** ISO timestamp of the saldo snapshot; null when never synced or not connected. */
  fetched_at: z.string().nullable(),
  /** Start of the comparable history: the earliest SKV-posted row we hold, or the 1630 IB date when that is later. */
  history_start: z.string().nullable(),
  /** saldo_at_start - ledger balance before history_start. Null without a snapshot. */
  opening_difference: z.number().nullable(),
  upcoming_count: z.number().int(),
  upcoming_total: z.number(),
  ledger_balance_before_start: z.number().nullable(),
  /**
   * Open Skatteverket rows (not linked, not ignored) dated before
   * history_start: what the item bucket before_history lists. Outside every
   * bridge line and count, and out of Att göra: the IB carries them
   * (crm#1153, crm#2010). Set by the skattekonto engine on every status.
   */
  before_history_count: z.number().int().optional(),
  before_history_total: z.number().optional(),
  /**
   * Set when unbooked Skatteverket rows are already in the ledger through
   * verifikat on 1630 that no row is linked to: every open row dated on or
   * before through_date. 'events_equal': those verifikat sum exactly to the
   * rows. 'ledger_agrees': 1630 already equals Skatteverket at that date, so
   * what the verifikat hold beyond the rows is the opening difference (events
   * before the fetched history). Booking such a row records it twice: link
   * the rows to the verifikat instead (allow_remainder when the sums differ).
   */
  covered: z
    .object({
      through_date: z.string(),
      kind: z.enum(['events_equal', 'ledger_agrees']),
      event_count: z.number().int(),
      event_total: z.number(),
      /** The unlinked verifikat on 1630 up to through_date, largest first (at most 10). */
      journal_entry_ids: z.array(z.string()),
      entry_count: z.number().int(),
    })
    .nullable()
    .optional(),
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
