import { NextResponse } from 'next/server'
import { DimensionValidationError, MandatoryDimensionMissingError } from './dimension-errors'
import { conflictCode, getErrorEntry } from '@/lib/errors/structured-errors'
import { databaseRefusal, type DatabaseRefusalCode } from '@/lib/errors/database-refusal'

// ============================================================================
// Dimension validation errors: the classes live in ./dimension-errors.ts
// (pure module, no next/server) because dimension-resolver.ts is reachable
// from client bundles via lib/api/schemas.ts. The two error classes are
// re-exported here so this file stays the import surface for typed
// bookkeeping errors; codes, formatters and issue types are imported from
// ./dimension-errors directly.
// ============================================================================

export { DimensionValidationError, MandatoryDimensionMissingError } from './dimension-errors'

// ============================================================================
// Error codes
// ============================================================================

export const ACCOUNTS_NOT_IN_CHART = 'ACCOUNTS_NOT_IN_CHART' as const
export const JOURNAL_ENTRY_NOT_BALANCED = 'JOURNAL_ENTRY_NOT_BALANCED' as const
export const JOURNAL_LINE_NEGATIVE_AMOUNT = 'JOURNAL_LINE_NEGATIVE_AMOUNT' as const
export const JOURNAL_LINE_BOTH_SIDES_NONZERO = 'JOURNAL_LINE_BOTH_SIDES_NONZERO' as const
export const FISCAL_PERIOD_NOT_FOUND = 'FISCAL_PERIOD_NOT_FOUND' as const
export const ENTRY_DATE_OUTSIDE_FISCAL_PERIOD = 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD' as const
export const JOURNAL_ENTRY_NOT_FOUND = 'JOURNAL_ENTRY_NOT_FOUND' as const
export const CANNOT_REVERSE_NON_POSTED = 'CANNOT_REVERSE_NON_POSTED' as const
export const CANNOT_REVERSE_STORNO = 'CANNOT_REVERSE_STORNO' as const
export const CANNOT_REVERSE_COLLECTED_PAYMENT = 'CANNOT_REVERSE_COLLECTED_PAYMENT' as const
export const CANNOT_CORRECT_NON_POSTED = 'CANNOT_CORRECT_NON_POSTED' as const
export const CANNOT_EDIT_NON_DRAFT = 'CANNOT_EDIT_NON_DRAFT' as const
export const CANNOT_CANCEL_NON_DRAFT = 'CANNOT_CANCEL_NON_DRAFT' as const
export const ENTRY_ALREADY_REVERSED = 'ENTRY_ALREADY_REVERSED' as const
export const MIGRATED_DEDUCTION_HELD_BY_REQUEST = 'MIGRATED_DEDUCTION_HELD_BY_REQUEST' as const
export const REVERSAL_HOOK_MISSING = 'REVERSAL_HOOK_MISSING' as const
export const CURRENCY_REVALUATION_ALREADY_EXISTS = 'CURRENCY_REVALUATION_ALREADY_EXISTS' as const
export const ASSET_DEPRECIATION_REFUSED = 'ASSET_DEPRECIATION_REFUSED' as const
export const INVALID_MAPPING_RESULT = 'INVALID_MAPPING_RESULT' as const
export const TX_MISSING_SEK_VALUE = 'TX_MISSING_SEK_VALUE' as const
export const TX_LINES_NOT_BALANCED = 'TX_LINES_NOT_BALANCED' as const
export const BOOKKEEPING_DATABASE_ERROR = 'BOOKKEEPING_DATABASE_ERROR' as const
/** guard_bank_booking_context's refusal of a bank row's verifikat that does not name its row (23514). */
export const BANK_BOOKING_CONTEXT_REQUIRED = 'BANK_BOOKING_CONTEXT_REQUIRED' as const
export const MEANINGLESS_CORRECTION = 'MEANINGLESS_CORRECTION' as const
export const CORRECTION_CHAIN_TOO_DEEP = 'CORRECTION_CHAIN_TOO_DEEP' as const
export const NO_OPEN_PERIOD_FOR_DATE = 'NO_OPEN_PERIOD_FOR_DATE' as const
export const TARGET_PERIOD_CLOSED = 'TARGET_PERIOD_CLOSED' as const
export const TARGET_PERIOD_LOCKED = 'TARGET_PERIOD_LOCKED' as const
export const SI_ACCRUED_COST_PERIOD_INVALID = 'SI_ACCRUED_COST_PERIOD_INVALID' as const
export const SI_ACCRUED_COST_PERIOD_LOCKED = 'SI_ACCRUED_COST_PERIOD_LOCKED' as const
export const INVOICE_ACCRUED_INCOME_PERIOD_INVALID = 'INVOICE_ACCRUED_INCOME_PERIOD_INVALID' as const
export const INVOICE_ACCRUED_INCOME_PERIOD_LOCKED = 'INVOICE_ACCRUED_INCOME_PERIOD_LOCKED' as const
export const SI_PREPAID_COST_PERIOD_PAST = 'SI_PREPAID_COST_PERIOD_PAST' as const
export const INVOICE_DEFERRED_INCOME_PERIOD_PAST = 'INVOICE_DEFERRED_INCOME_PERIOD_PAST' as const
export const CUTOFF_CARRY_REVERSAL_DATE = 'CUTOFF_CARRY_REVERSAL_DATE' as const
export const KONTANTMETOD_CARRY_HAS_SETTLEMENTS = 'KONTANTMETOD_CARRY_HAS_SETTLEMENTS' as const
export const CUTOFF_CARRY_CORRECTION_REFUSED = 'CUTOFF_CARRY_CORRECTION_REFUSED' as const
export const IMPORT_VAT_WITHOUT_BASE = 'IMPORT_VAT_WITHOUT_BASE' as const
export const CORRECTION_BANK_ACCOUNT_CHANGED = 'CORRECTION_BANK_ACCOUNT_CHANGED' as const
export const UNATTENDED_COMMIT_LIMIT_EXCEEDED = 'UNATTENDED_COMMIT_LIMIT_EXCEEDED' as const
export const BOOKING_REVIEW_REQUIRED = 'BOOKING_REVIEW_REQUIRED' as const
export const ACCRUAL_DRAFT_POSTED_BY_SCHEDULE = 'ACCRUAL_DRAFT_POSTED_BY_SCHEDULE' as const
export const BOOKING_REVIEW_LIMIT = 'BOOKING_REVIEW_LIMIT' as const

// ============================================================================
// AccountsNotInChartError: kept for back-compat (many existing call sites)
// ============================================================================

export class AccountsNotInChartError extends Error {
  readonly code = ACCOUNTS_NOT_IN_CHART
  readonly accountNumbers: string[]

  constructor(accountNumbers: string[]) {
    // Numeric-first sort so mixed-length BAS codes (rare but possible) order
    // by value rather than by UTF-16 code units: otherwise ['245', '1930']
    // would sort to ['1930', '245'] under the default string comparator,
    // confusing a user about which accounts to activate in Kontoplan.
    // Non-numeric tokens fall back to a stable string compare so the order
    // is fully deterministic for any input.
    const sorted = [...new Set(accountNumbers)].sort(compareAccountNumbers)
    super(`Accounts not enabled in chart of accounts: ${sorted.join(', ')}`)
    this.name = 'AccountsNotInChartError'
    this.accountNumbers = sorted
  }
}

function compareAccountNumbers(a: string, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  const aIsNum = Number.isFinite(na)
  const bIsNum = Number.isFinite(nb)
  if (aIsNum && bIsNum) {
    if (na !== nb) return na - nb
    // Same numeric value but different string (e.g. "0245" vs "245"):
    // break the tie deterministically by string.
    return a < b ? -1 : a > b ? 1 : 0
  }
  if (aIsNum) return -1
  if (bIsNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

export function isAccountsNotInChartError(err: unknown): err is AccountsNotInChartError {
  return err instanceof AccountsNotInChartError
}

// ============================================================================
// Semantic errors: carry structured data so getErrorMessage can format rich
// Swedish translations with amounts / period names / status.
// ============================================================================

export class JournalEntryNotBalancedError extends Error {
  readonly code = JOURNAL_ENTRY_NOT_BALANCED
  constructor(
    public readonly totalDebit: number,
    public readonly totalCredit: number,
    public readonly kind: 'draft' | 'correction' = 'draft'
  ) {
    super(`Journal entry is not balanced: debits (${totalDebit}) != credits (${totalCredit})`)
    this.name = 'JournalEntryNotBalancedError'
  }
}

/**
 * A line arrived with a negative debit_amount or credit_amount. Such a line
 * balances arithmetically (debit -0.25 nets like credit 0.25), so the balance
 * trigger never fires, but every reader assumes one non-negative side per
 * line: the verifikat page hides it, sums disagree with the visible rows.
 * Producers must flip the side instead (lib/bookkeeping/line-side.ts).
 */
export class JournalLineNegativeAmountError extends Error {
  readonly code = JOURNAL_LINE_NEGATIVE_AMOUNT
  constructor(
    public readonly accountNumber: string,
    public readonly debitAmount: number,
    public readonly creditAmount: number
  ) {
    super(
      `Journal line on ${accountNumber} has a negative amount (debit ${debitAmount}, credit ${creditAmount}); book it on the opposite side instead`
    )
    this.name = 'JournalLineNegativeAmountError'
  }
}

/**
 * A line arrived with BOTH debit_amount and credit_amount above zero. The
 * line cancels itself, and totals-only balance math cannot see it: the entry
 * "balances" and posts as a nollverifikat. A later storno then nets the line
 * to {0, 0} and dies on the voucher trigger's "has zero total" (issue #2551).
 * A journal line carries one side; a producer holding both amounts must net
 * them onto the larger side (lib/bookkeeping/line-side.ts) or split them into
 * two lines.
 */
export class JournalLineBothSidesNonZeroError extends Error {
  readonly code = JOURNAL_LINE_BOTH_SIDES_NONZERO
  constructor(
    public readonly accountNumber: string,
    public readonly debitAmount: number,
    public readonly creditAmount: number
  ) {
    super(
      `Journal line on ${accountNumber} carries both sides (debit ${debitAmount}, credit ${creditAmount}); a line carries one side only`
    )
    this.name = 'JournalLineBothSidesNonZeroError'
  }
}

export class FiscalPeriodNotFoundError extends Error {
  readonly code = FISCAL_PERIOD_NOT_FOUND
  constructor() {
    super('Fiscal period not found')
    this.name = 'FiscalPeriodNotFoundError'
  }
}

export class EntryDateOutsideFiscalPeriodError extends Error {
  readonly code = ENTRY_DATE_OUTSIDE_FISCAL_PERIOD
  constructor(
    public readonly entryDate: string,
    public readonly periodName: string,
    public readonly periodStart: string,
    public readonly periodEnd: string
  ) {
    super(
      `Entry date ${entryDate} is outside fiscal period "${periodName}" (${periodStart} - ${periodEnd})`
    )
    this.name = 'EntryDateOutsideFiscalPeriodError'
  }
}

export class JournalEntryNotFoundError extends Error {
  readonly code = JOURNAL_ENTRY_NOT_FOUND
  constructor() {
    super('Journal entry not found')
    this.name = 'JournalEntryNotFoundError'
  }
}

export class CannotReverseNonPostedError extends Error {
  readonly code = CANNOT_REVERSE_NON_POSTED
  constructor(public readonly currentStatus: string) {
    super('Can only reverse posted entries')
    this.name = 'CannotReverseNonPostedError'
  }
}

/**
 * Raised when a storno (reversal) is attempted on an entry that is itself a
 * storno. Reversing a storno would produce a storno-of-a-storno and make the
 * original verifikat's cancellation chain ambiguous, violating the
 * traceable-correction requirement of BFL 5 kap 5§. Correction entries are
 * NOT covered: a rättelseverifikation is a regular live verifikat and may be
 * stornoed like any other (its correction_of_id link keeps the chain
 * traceable). The UI hides the "Återför" action for stornos; this is the
 * server-side backstop so a direct API call cannot bypass it.
 */
export class CannotReverseStornoError extends Error {
  readonly code = CANNOT_REVERSE_STORNO
  constructor(public readonly sourceType: string) {
    super('Cannot reverse a storno entry')
    this.name = 'CannotReverseStornoError'
  }
}

/**
 * A payment the collections provider collected (invoice_payments.source
 * 'collections') is corrected only through the collections rebook, never a
 * generic storno: the payment row cannot be removed (block_delete_collected_
 * payment), so a storno would reopen the receivable in the ledger while the
 * invoice stays paid and the provider's payout still clears the capital.
 */
export class CannotReverseCollectedPaymentError extends Error {
  readonly code = CANNOT_REVERSE_COLLECTED_PAYMENT
  constructor() {
    super('A payment collected by the collections provider cannot be reversed through the generic storno')
    this.name = 'CannotReverseCollectedPaymentError'
  }
}

export class CannotCorrectNonPostedError extends Error {
  readonly code = CANNOT_CORRECT_NON_POSTED
  constructor(public readonly currentStatus: string) {
    super('Can only correct posted entries')
    this.name = 'CannotCorrectNonPostedError'
  }
}

/**
 * Raised when an edit is attempted on a committed entry. Only drafts are
 * editable in place; posted/reversed/cancelled entries are immutable per BFL
 * 5 kap. (corrections go through storno). The DB immutability trigger is the
 * backstop: this gives a clean, translatable 409 before we reach it.
 */
export class CannotEditNonDraftError extends Error {
  readonly code = CANNOT_EDIT_NON_DRAFT
  constructor(public readonly currentStatus: string) {
    super('Only draft entries can be edited')
    this.name = 'CannotEditNonDraftError'
  }
}

/**
 * Raised when a cancel is attempted on an entry that is not a draft.
 *
 * Only drafts can be cancelled: they hold no voucher_number, so removing one
 * leaves the verifikationsserie unbroken (BFL 5 kap 7 §). A posted entry
 * carries a number and may only be undone through a rättelse, never
 * overwritten: BFL 5 kap 5 § keeps the original post visible and records who
 * corrected it and when, which is what storno does. The DB immutability
 * trigger cannot make this call on its
 * own: it permits posted -> cancelled for the orphaned-voucher compensation
 * path, which pairs the cancel with a voucher-gap explanation.
 */
export class CannotCancelNonDraftError extends Error {
  readonly code = CANNOT_CANCEL_NON_DRAFT
  constructor(public readonly currentStatus: string) {
    super('Only draft entries can be cancelled')
    this.name = 'CannotCancelNonDraftError'
  }
}

export class EntryAlreadyReversedError extends Error {
  readonly code = ENTRY_ALREADY_REVERSED
  constructor() {
    super('Entry was already reversed by a concurrent operation')
    this.name = 'EntryAlreadyReversedError'
  }
}

/**
 * Raised when the reclassification voucher of a migrated invoice's household
 * deduction (source_type rot_rut_reclassification) would be reversed while a
 * begäran made here holds that invoice. The storno would put the deduction
 * back on 1510 while the begäran still asks Skatteverket for it: the begäran
 * must be cancelled first (lib/invoices/migrated-deduction-reversal.ts).
 */
export class MigratedDeductionHeldByRequestError extends Error {
  readonly code = MIGRATED_DEDUCTION_HELD_BY_REQUEST
  constructor(public readonly invoiceId: string) {
    super('The invoice is held by a ROT/RUT request; cancel the request before reversing')
    this.name = 'MigratedDeductionHeldByRequestError'
  }
}

/**
 * Raised by reverseEntry before anything is written when the entry's source
 * type needs a business-state mirror on storno (REVERSAL_MIRROR_REQUIRED in
 * lib/bookkeeping/reversal-hooks.ts) and no reversal hook for it is
 * registered (lib/composition/reversal-hooks.ts). A refused storno can be
 * retried once the hook is back; a storno that left its sub-ledger half
 * mirrored could not be detected later.
 */
export class ReversalHookMissingError extends Error {
  readonly code = REVERSAL_HOOK_MISSING
  constructor(public readonly sourceType: string) {
    super(`No reversal hook is registered for source type ${sourceType}; the storno was refused before anything was written`)
    this.name = 'ReversalHookMissingError'
  }
}

export class CurrencyRevaluationAlreadyExistsError extends Error {
  readonly code = CURRENCY_REVALUATION_ALREADY_EXISTS
  constructor() {
    super('Currency revaluation already exists for this period')
    this.name = 'CurrencyRevaluationAlreadyExistsError'
  }
}

/**
 * The two outcomes commit_asset_depreciation refuses without anything being
 * wrong with the caller: the (asset, period) pair was posted by someone else
 * first, or the asset was deleted while the posting waited on its row lock.
 * No voucher is posted in either case, so a batch can skip the asset and
 * carry on.
 */
export type AssetDepreciationRefusal = 'already_posted' | 'asset_not_found'

/** Recalculate the proposal instead of posting against an edited opening balance. */
export class AssetOpeningChangedError extends Error {
  readonly code = 'ASSET_OPENING_CHANGED'
  constructor() {
    super('Asset opening depreciation changed: recalculate the proposal before posting')
    this.name = 'AssetOpeningChangedError'
  }
}

/**
 * The K3 component split a posting was computed with no longer matches the
 * register (a component was added, replaced or removed in between):
 * recalculate the proposal.
 */
export class AssetComponentsChangedError extends Error {
  readonly code = 'ASSET_COMPONENTS_CHANGED'
  constructor() {
    super('Asset components changed: recalculate the proposal before posting')
    this.name = 'AssetComponentsChangedError'
  }
}

/** The refusals of a component replacement that leave nothing posted. */
export type AssetComponentRefusal =
  | 'ASSET_COMPONENT_NOT_FOUND'
  | 'ASSET_COMPONENT_NOT_ACTIVE'
  | 'ASSET_LAST_COMPONENT'
  | 'ASSET_COMPONENT_STATE_CHANGED'
  | 'ASSET_COMPONENT_IMPAIRED'

export class AssetComponentRefusedError extends Error {
  readonly code: AssetComponentRefusal
  constructor(reason: string) {
    const code = (
      [
        'ASSET_COMPONENT_NOT_FOUND',
        'ASSET_COMPONENT_NOT_ACTIVE',
        'ASSET_LAST_COMPONENT',
        'ASSET_COMPONENT_STATE_CHANGED',
        'ASSET_COMPONENT_IMPAIRED',
      ] as const
    ).find((known) => known === reason) ?? 'ASSET_COMPONENT_STATE_CHANGED'
    super(code)
    this.code = code
    this.name = 'AssetComponentRefusedError'
  }
}

/** Why a nedskrivning or its reversal (ÅRL 4:5, K3 27) cannot be posted. */
export type AssetValueAdjustmentBlock =
  | 'disposed'
  | 'period_locked'
  | 'before_acquisition'
  | 'not_at_balance_sheet_date'
  | 'later_depreciation_posted'
  | 'later_adjustment'
  | 'year_not_depreciated'
  | 'history_incomplete'
  | 'no_write_down'
  | 'nothing_to_reverse'
  | 'goodwill_reversal'
  | 'components_changed'
  | 'exceeds_carrying_amount'
  | 'exceeds_write_down'

const VALUE_ADJUSTMENT_BLOCK_SV: Record<AssetValueAdjustmentBlock, string> = {
  disposed: 'Tillgången är avyttrad och kan inte skrivas ned.',
  period_locked: 'Räkenskapsåret är låst eller stängt.',
  before_acquisition: 'Räkenskapsåret slutar före tillgångens anskaffningsdatum.',
  not_at_balance_sheet_date: 'En nedskrivning bokförs per balansdagen, räkenskapsårets sista dag.',
  later_depreciation_posted: 'Avskrivning för ett senare räkenskapsår är redan bokförd. Återför den med storno först.',
  later_adjustment: 'En senare nedskrivning eller återföring är redan bokförd. Återför den med storno först.',
  year_not_depreciated: 'Bokför årets avskrivning för tillgången först: nedskrivningen prövas mot det redovisade värdet efter avskrivning.',
  history_incomplete:
    'Avskrivningen för tidigare år finns inte i anläggningsregistret, så det redovisade värdet är inte känt. Bokför de åren eller ange redan avskrivet belopp först.',
  no_write_down: 'Återvinningsvärdet är inte lägre än det redovisade värdet: ingen nedskrivning behövs (K3 27.2).',
  nothing_to_reverse:
    'Det finns ingen nedskrivning att återföra: ingen är bokförd, eller återvinningsvärdet ryms inte över det redovisade värdet (K3 27.15).',
  goodwill_reversal: 'En nedskrivning av goodwill får inte återföras (ÅRL 4 kap. 5 §).',
  components_changed: 'Komponenterna har ändrats sedan beräkningen. Räkna om och försök igen.',
  exceeds_carrying_amount: 'Nedskrivningen är större än det redovisade värdet. Räkna om och försök igen.',
  exceeds_write_down: 'Återföringen är större än nedskrivningen som återstår. Räkna om och försök igen.',
}

/** The refusals commit_asset_value_adjustment raises (PT409 message) by reason. */
const VALUE_ADJUSTMENT_RPC_REFUSALS: Record<string, AssetValueAdjustmentBlock> = {
  ASSET_DISPOSED: 'disposed',
  NOT_AT_BALANCE_SHEET_DATE: 'not_at_balance_sheet_date',
  LATER_DEPRECIATION_POSTED: 'later_depreciation_posted',
  LATER_ADJUSTMENT_POSTED: 'later_adjustment',
  EXCEEDS_CARRYING_AMOUNT: 'exceeds_carrying_amount',
  EXCEEDS_WRITE_DOWN: 'exceeds_write_down',
  GOODWILL_REVERSAL_FORBIDDEN: 'goodwill_reversal',
  ASSET_COMPONENTS_CHANGED: 'components_changed',
}

export function valueAdjustmentBlockFromRpc(message: string): AssetValueAdjustmentBlock | null {
  return VALUE_ADJUSTMENT_RPC_REFUSALS[message] ?? null
}

/**
 * A nedskrivning or reversal that cannot be posted, before or by
 * commit_asset_value_adjustment; nothing was posted. The message is the
 * Swedish reason (409 ASSET_VALUE_ADJUSTMENT_BLOCKED).
 */
export class AssetValueAdjustmentBlockedError extends Error {
  readonly code = 'ASSET_VALUE_ADJUSTMENT_BLOCKED'
  constructor(readonly reason: AssetValueAdjustmentBlock) {
    super(VALUE_ADJUSTMENT_BLOCK_SV[reason])
    this.name = 'AssetValueAdjustmentBlockedError'
  }
}

/** Why the transition to K3 (BFNAR 2012:1 kap. 35), or a split at it, cannot proceed. */
export type K3TransitionBlock =
  | 'not_k3'
  | 'already_started'
  | 'not_started'
  | 'committed'
  | 'has_splits'
  | 'period_locked'
  | 'asset_disposed'
  | 'asset_not_splittable'
  | 'asset_acquired_under_k3'
  | 'later_depreciation_posted'
  | 'asset_impaired'
  | 'asset_has_components'
  | 'split_in_use'
  | 'asset_changed'

const K3_TRANSITION_BLOCK_SV: Record<K3TransitionBlock, string> = {
  not_k3: 'Räkenskapsåret upprättas inte enligt K3. Välj K3 för året först.',
  already_started: 'Övergången till K3 är redan påbörjad. Kapitel 35 tillämpas en gång (K3 punkt 35.1).',
  not_started: 'Påbörja övergången till K3 först.',
  committed:
    'Övergången till K3 är redan bokförd. Återför övergångsverifikationen med storno för att ändra den.',
  has_splits: 'Ångra komponentuppdelningarna som gjorts vid övergången först.',
  period_locked: 'Räkenskapsåret är låst eller stängt.',
  asset_disposed: 'Tillgången är avyttrad.',
  asset_not_splittable:
    'Bara materiella anläggningstillgångar delas upp på komponenter (K3 punkt 17.4), och mark skrivs aldrig av.',
  asset_acquired_under_k3:
    'Tillgången är anskaffad under ett K3-år: dela upp den på komponenter i anläggningsregistret i stället.',
  later_depreciation_posted:
    'Avskrivning är redan bokförd för tillgången från övergångsdagen. Återför den med storno först.',
  asset_impaired: 'Tillgången har en nedskrivning. Återför den innan tillgången delas upp på komponenter.',
  asset_has_components: 'Tillgången är redan uppdelad på komponenter.',
  split_in_use:
    'Uppdelningen kan inte ändras längre: en komponent har avskrivits, bytts ut eller tillkommit efter övergången.',
  asset_changed: 'Tillgången har ändrats sedan beräkningen. Räkna om och försök igen.',
}

/** The refusals the K3 transition RPCs raise (PT409 message) by reason. */
const K3_TRANSITION_RPC_REFUSALS: Record<string, K3TransitionBlock> = {
  K3_TRANSITION_NOT_STARTED: 'not_started',
  K3_TRANSITION_NOT_K3: 'not_k3',
  K3_TRANSITION_COMMITTED: 'committed',
  K3_TRANSITION_HAS_SPLITS: 'has_splits',
  ASSET_DISPOSED: 'asset_disposed',
  ASSET_NOT_SPLITTABLE: 'asset_not_splittable',
  ASSET_ACQUIRED_UNDER_K3: 'asset_acquired_under_k3',
  LATER_DEPRECIATION_POSTED: 'later_depreciation_posted',
  ASSET_IMPAIRED: 'asset_impaired',
  ASSET_HAS_COMPONENTS: 'asset_has_components',
  TRANSITION_SPLIT_IN_USE: 'split_in_use',
  ASSET_COMPONENTS_CHANGED: 'asset_changed',
}

export function k3TransitionBlockFromRpc(message: string): K3TransitionBlock | null {
  return K3_TRANSITION_RPC_REFUSALS[message] ?? null
}

/**
 * The transition to K3, or a component split at it, refused before or by
 * its RPC; nothing was written. The message is the Swedish reason (409
 * K3_TRANSITION_BLOCKED).
 */
export class K3TransitionBlockedError extends Error {
  readonly code = 'K3_TRANSITION_BLOCKED'
  constructor(readonly reason: K3TransitionBlock) {
    super(K3_TRANSITION_BLOCK_SV[reason])
    this.name = 'K3TransitionBlockedError'
  }
}

/** Transition input that cannot be booked, with the Swedish rule (400 INVALID_K3_TRANSITION). */
export class K3TransitionInvalidError extends Error {
  readonly code = 'INVALID_K3_TRANSITION'
  constructor(message: string) {
    super(message)
    this.name = 'K3TransitionInvalidError'
  }
}

/**
 * The year's deferred tax is already posted (commit_deferred_tax): a new
 * calculation needs the earlier voucher reversed first (409).
 */
export class DeferredTaxAlreadyPostedError extends Error {
  readonly code = 'DEFERRED_TAX_ALREADY_POSTED'
  constructor() {
    super('DEFERRED_TAX_ALREADY_POSTED')
    this.name = 'DeferredTaxAlreadyPostedError'
  }
}

export type ContractRevenueRefusal = 'not_k3' | 'stale' | 'later_year'

const CONTRACT_REVENUE_REFUSALS: Record<ContractRevenueRefusal, string> = {
  not_k3: 'CONTRACT_REVENUE_NOT_K3',
  stale: 'CONTRACT_REVENUE_STALE',
  later_year: 'CONTRACT_REVENUE_LATER_YEAR_BOOKED',
}

/** The refusal commit_contract_revenue raised (PT409 with this message), or null. */
export function contractRevenueRefusalFromRpc(message: string): ContractRevenueRefusal | null {
  const found = (Object.entries(CONTRACT_REVENUE_REFUSALS) as Array<[ContractRevenueRefusal, string]>).find(
    ([, raised]) => raised === message,
  )
  return found ? found[0] : null
}

/**
 * commit_contract_revenue refused the pågående-arbeten adjustment (409): the
 * year is not reported under K3, the register's verifikat, method or account
 * changed since the adjustment was computed (a double click, a concurrent
 * booking), or a later year's booking stands on this year's balance. Nothing
 * was posted.
 */
export class ContractRevenueRefusedError extends Error {
  readonly code = 'CONTRACT_REVENUE_REFUSED'
  constructor(public readonly reason: ContractRevenueRefusal) {
    super(CONTRACT_REVENUE_REFUSALS[reason])
    this.name = 'ContractRevenueRefusedError'
  }
}

export class AssetDepreciationRefusedError extends Error {
  readonly code = ASSET_DEPRECIATION_REFUSED
  constructor(public readonly reason: AssetDepreciationRefusal) {
    super(
      reason === 'already_posted'
        ? 'Depreciation is already posted for this asset and fiscal period'
        : 'Asset no longer exists: no depreciation was posted',
    )
    this.name = 'AssetDepreciationRefusedError'
  }
}

export type MeaninglessCorrectionReason =
  | 'net_zero_per_account'
  | 'identical_to_original'
  | 'no_date_change'
  | 'negates_original'
  | 'currency_incomplete'

export class MeaninglessCorrectionError extends Error {
  readonly code = MEANINGLESS_CORRECTION
  constructor(public readonly reason: MeaninglessCorrectionReason) {
    super(
      reason === 'net_zero_per_account'
        ? 'Correction lines net to zero on every account: no economic event represented (BFL 5 kap. 5 §).'
        : reason === 'no_date_change'
          ? 'New date equals the current date: nothing to move.'
          : reason === 'negates_original'
            ? 'Correction lines are the original with debit and credit swapped: the storno already reverses the original, so this would reverse it a second time. To only cancel the entry, reverse it (storno). Pass sides_swapped=true only when the original itself was booked with debit and credit swapped.'
            : reason === 'currency_incomplete'
              ? "Correction changes only currency, and a line's currency is incomplete: a line whose original is in a foreign currency would post in kronor without it, and a foreign-currency line needs its amount in currency and rate. State currency, amount_in_currency and exchange_rate on every such line, or currency 'SEK' to post it in kronor."
              : 'Correction lines are identical to the original entry: nothing to correct.'
    )
    this.name = 'MeaninglessCorrectionError'
  }
}

/**
 * Raised when a correction/reversal targets an entry that already sits
 * CORRECTION_CHAIN_GUARD_DEPTH or more links deep in a rättelse chain
 * (correction_of_id/reverses_id walked backwards). Stacking yet another
 * storno+rättelse on top buries the journal in noise vouchers; the sanctioned
 * fix is ONE correction expressing the net effect of the whole chain. The
 * guard is advisory: callers bypass it with an explicit allowDeepChain flag
 * (allow_deep_chain on the API/MCP surfaces), so it never dead-ends a
 * legitimate deep fix.
 */
export class CorrectionChainTooDeepError extends Error {
  readonly code = CORRECTION_CHAIN_TOO_DEEP
  constructor(
    public readonly depth: number,
    public readonly chainRootVoucher: string | null
  ) {
    super(
      `Correction chain is already ${depth} levels deep` +
        (chainRootVoucher ? ` (chain root: ${chainRootVoucher})` : '') +
        '. Compute the net effect of the whole chain and book ONE correction instead, ' +
        'or pass allow_deep_chain=true to override.'
    )
    this.name = 'CorrectionChainTooDeepError'
  }
}

/**
 * Raised when a verifikation is moved (recordate) to a date that no fiscal
 * period covers. We do not auto-create periods on a correction.
 */
export class NoOpenPeriodForDateError extends Error {
  readonly code = NO_OPEN_PERIOD_FOR_DATE
  constructor(public readonly date: string) {
    super(`No fiscal period covers ${date}`)
    this.name = 'NoOpenPeriodForDateError'
  }
}

/**
 * Raised when the target date of a recordate falls in a closed fiscal year
 * (bokslut). A closed year cannot be reopened: the correction must be booked
 * in the current open period instead.
 */
export class TargetPeriodClosedError extends Error {
  readonly code = TARGET_PERIOD_CLOSED
  constructor(public readonly date: string) {
    super(`The fiscal period covering ${date} is closed`)
    this.name = 'TargetPeriodClosedError'
  }
}

/**
 * Raised when the target date of a recordate falls in a locked period or is
 * covered by the company-wide bookkeeping lock date. Carries the lock date so
 * the UI can offer an unlock affordance.
 */
export class TargetPeriodLockedError extends Error {
  readonly code = TARGET_PERIOD_LOCKED
  constructor(
    public readonly date: string,
    public readonly lockDate: string | null
  ) {
    super(
      `The fiscal period covering ${date} is locked${lockDate ? ` (lock date ${lockDate})` : ''}`
    )
    this.name = 'TargetPeriodLockedError'
  }
}

/**
 * Raised before a supplier invoice registration is posted when a line books
 * an upplupen kostnad (29xx) for a period that does not end before the
 * invoice month. The cost of the invoice month itself is no accrual: the
 * line has to be split instead.
 */
export class AccruedCostPeriodInvalidError extends Error {
  readonly code = SI_ACCRUED_COST_PERIOD_INVALID
  constructor(
    public readonly periodStart: string,
    public readonly periodEnd: string,
    public readonly invoiceDate: string
  ) {
    super(
      `An accrued cost (29xx) must cover months before the invoice month: the period ${periodStart} to ${periodEnd} reaches the month of the invoice dated ${invoiceDate}. Split the line.`
    )
    this.name = 'AccruedCostPeriodInvalidError'
  }
}

/** Why a month-end date cannot take an upplupen kostnad (checkPeriodLock's reasons). */
export type AccruedCostBlockReason =
  | 'company_lock_date_covers'
  | 'period_locked_at_set'
  | 'period_is_closed'
  | 'no_fiscal_period'
  | 'lookup_failed'

export interface AccruedCostBlockedDate {
  date: string
  reason: AccruedCostBlockReason
}

/**
 * Raised before a supplier invoice registration is posted when an upplupen
 * kostnad (29xx) would book on a month-end that cannot take an entry: a
 * closed or locked period, a date on or before the company lock date, or no
 * fiscal year at all. The cost belongs
 * to that month, so it is never moved to another one: the whole registration
 * is refused and nothing is written.
 */
export class AccruedCostPeriodLockedError extends Error {
  readonly code = SI_ACCRUED_COST_PERIOD_LOCKED
  constructor(public readonly blocked: AccruedCostBlockedDate[]) {
    super(
      `An accrued cost (29xx) would post on ${blocked.map((b) => `${b.date} (${b.reason})`).join(', ')}, which cannot take entries. Nothing was booked.`
    )
    this.name = 'AccruedCostPeriodLockedError'
  }
}

/**
 * Raised before a customer invoice's revenue entry is posted when a line
 * books an upplupen intäkt (17xx) for a period that does not end before the
 * invoice month (#62). The invoice month's own revenue is no accrual: the
 * line has to be split instead.
 */
export class AccruedIncomePeriodInvalidError extends Error {
  readonly code = INVOICE_ACCRUED_INCOME_PERIOD_INVALID
  constructor(
    public readonly periodStart: string,
    public readonly periodEnd: string,
    public readonly invoiceDate: string
  ) {
    super(
      `Accrued income (17xx) must cover months before the invoice month: the period ${periodStart} to ${periodEnd} reaches the month of the invoice dated ${invoiceDate}. Split the line.`
    )
    this.name = 'AccruedIncomePeriodInvalidError'
  }
}

/**
 * Raised before a customer invoice's revenue entry is posted when an
 * upplupen intäkt (17xx) would book on a month-end that cannot take an entry
 * (the same reasons as AccruedCostPeriodLockedError). The revenue belongs to
 * that month, so it is never moved to another one: nothing is written.
 */
export class AccruedIncomePeriodLockedError extends Error {
  readonly code = INVOICE_ACCRUED_INCOME_PERIOD_LOCKED
  constructor(public readonly blocked: AccruedCostBlockedDate[]) {
    super(
      `Accrued income (17xx) would post on ${blocked.map((b) => `${b.date} (${b.reason})`).join(', ')}, which cannot take entries. Nothing was booked.`
    )
    this.name = 'AccruedIncomePeriodLockedError'
  }
}

/**
 * Raised before an invoice's verifikat is posted when a line defers
 * (förutbetald: a cost on 17xx, revenue on 29xx) a period that ends before
 * the invoice month (accounted#113). Those months are over: the deferral
 * would release all of them on the invoice date. The line needs the upplupen
 * account instead (suggestedAccount: 2990/2960 for a cost, 1790 for revenue),
 * which books each month on its own last day.
 */
export class DeferralPeriodPastError extends Error {
  readonly code: typeof SI_PREPAID_COST_PERIOD_PAST | typeof INVOICE_DEFERRED_INCOME_PERIOD_PAST
  constructor(
    public readonly direction: 'expense' | 'revenue',
    public readonly periodStart: string,
    public readonly periodEnd: string,
    public readonly invoiceDate: string,
    public readonly balanceAccount: string | null,
    public readonly suggestedAccount: string
  ) {
    super(
      `The period ${periodStart} to ${periodEnd} ends before the month of the invoice dated ${invoiceDate}, so it cannot be deferred on ${balanceAccount ?? 'the default account'}: book it as ${direction === 'expense' ? 'an accrued cost' : 'accrued income'} on ${suggestedAccount}.`
    )
    this.code = direction === 'expense' ? SI_PREPAID_COST_PERIOD_PAST : INVOICE_DEFERRED_INCOME_PERIOD_PAST
    this.name = 'DeferralPeriodPastError'
  }
}

/** The details a DeferralPeriodPastError answers with, in every envelope. */
export function deferralPeriodPastDetails(err: DeferralPeriodPastError) {
  return {
    periodStart: err.periodStart,
    periodEnd: err.periodEnd,
    invoiceDate: err.invoiceDate,
    balanceAccount: err.balanceAccount,
    suggestedAccount: err.suggestedAccount,
  }
}

/**
 * A kontantmetod year-end carry (årsomföring, #3440) may only be stornoed on
 * its own date: the moms it declared in the closed year's final VAT period
 * must leave that same period. The database refuses the same thing
 * (kontantmetod_carry_on_reversal, 20261018131100); this is the readable
 * refusal before any write.
 */
export class CutoffCarryReversalDateError extends Error {
  readonly code = CUTOFF_CARRY_REVERSAL_DATE
  constructor(
    public readonly carryDate: string,
    public readonly reversalDate: string,
  ) {
    super(
      `A kontantmetod year-end carry dated ${carryDate} can only be reversed on that date, not ${reversalDate}`
    )
    this.name = 'CutoffCarryReversalDateError'
  }
}

/**
 * A kontantmetod year-end carry whose invoice has been paid or credited since
 * cannot be stornoed: the payment or credit note cleared the 1510 / 2440 the
 * carry booked, and would be left stranded. Undo those first.
 */
export class KontantmetodCarryHasSettlementsError extends Error {
  readonly code = KONTANTMETOD_CARRY_HAS_SETTLEMENTS
  constructor(public readonly invoiceId: string) {
    super('The carried invoice has payments or a booked credit note: undo them before reversing the carry')
    this.name = 'KontantmetodCarryHasSettlementsError'
  }
}

/**
 * A kontantmetod year-end carry is never corrected in place (storno plus
 * rättelse): it is stornoed on its own date and the cut-off is run again,
 * which rebuilds it from the invoice.
 */
export class CutoffCarryCorrectionRefusedError extends Error {
  readonly code = CUTOFF_CARRY_CORRECTION_REFUSED
  constructor() {
    super('A kontantmetod year-end carry cannot be corrected: reverse it on its own date and run the cut-off again')
    this.name = 'CutoffCarryCorrectionRefusedError'
  }
}

/**
 * A rättelse that would leave importmoms (rutor 60-62) in the verifikat with
 * no beskattningsunderlag in ruta 50 (#94), the shape the booking doors refuse
 * too (#83, lib/bookkeeping/import-vat-base.ts). The message is the Swedish
 * sentence naming the accounts and what to change.
 */
export class ImportVatWithoutBaseError extends Error {
  readonly code = IMPORT_VAT_WITHOUT_BASE
  constructor(
    public readonly importVatAccounts: string[],
    messageSv: string,
  ) {
    super(messageSv)
    this.name = 'ImportVatWithoutBaseError'
  }
}

/**
 * A storno + rättelse that moves the bank leg of a bank row the original
 * anchors to another bank account (lib/core/bookkeeping/correction-bank-leg.ts):
 * the bank row says which account the money moved on. The message is the
 * Swedish sentence naming both accounts and what to do instead.
 */
export class CorrectionBankAccountChangedError extends Error {
  readonly code = CORRECTION_BANK_ACCOUNT_CHANGED
  constructor(
    public readonly bankAccount: string,
    public readonly movedTo: string[],
    messageSv: string,
  ) {
    super(messageSv)
    this.name = 'CorrectionBankAccountChangedError'
  }
}

export class InvalidMappingResultError extends Error {
  readonly code = INVALID_MAPPING_RESULT
  constructor(
    public readonly debitAccount: string | null | undefined,
    public readonly creditAccount: string | null | undefined
  ) {
    super(
      `Invalid mapping result: debit_account="${debitAccount}", credit_account="${creditAccount}". Both must be non-empty.`
    )
    this.name = 'InvalidMappingResultError'
  }
}

/**
 * A foreign-currency bank transaction has neither amount_sek nor an
 * exchange_rate, so its SEK value is unknown. Journal lines are always kronor
 * (BFL 4 kap 6 §), and the old fallback booked the raw foreign number as if it
 * were kronor: 100 CAD posted as 100 kr. Booking refuses instead; the next
 * step is the transaction's refresh-exchange-rate route, which fetches the
 * Riksbanken rate for the transaction date.
 */
export class TransactionMissingSekValueError extends Error {
  readonly code = TX_MISSING_SEK_VALUE
  constructor(
    public readonly transactionId: string,
    public readonly currency: string,
    public readonly date: string
  ) {
    super(
      `Transaction ${transactionId} is in ${currency} but has neither amount_sek nor exchange_rate; it cannot be booked until its SEK value is known`
    )
    this.name = 'TransactionMissingSekValueError'
  }
}

/**
 * The lines a kontering builds for a bank row do not balance, so the booking
 * is refused where the lines are built (buildTransactionEntryLines), before
 * any draft: the engine would refuse the same lines (hard rule 3), but only
 * after the request reached it, as a failure of ours with no word on what to
 * do. A single debit/credit pair nets its moms against the bank line and
 * balances by construction; a learned line pattern (all_lines_complete) books
 * its lines at their own amounts and sides beside the full bank amount, and a
 * pattern whose lines net on the bank's own side, or whose moms line sits
 * opposite its cost lines, cannot be replayed on the row.
 */
export class TransactionLinesNotBalancedError extends Error {
  readonly code = TX_LINES_NOT_BALANCED
  constructor(
    public readonly transactionId: string,
    public readonly totalDebit: number,
    public readonly totalCredit: number,
    /** The lines came from a learned line pattern, not a single pair. */
    public readonly fromLinePattern: boolean,
  ) {
    super(
      `The booking built for transaction ${transactionId} does not balance: debits (${totalDebit}) != credits (${totalCredit})`
    )
    this.name = 'TransactionLinesNotBalancedError'
  }
}

/**
 * A verifikat above the acting API key's unattended ceiling
 * (api_keys.unattended_commit_limit): refused before a voucher number is
 * drawn, so nothing is posted and the series has no gap. A person posts it
 * from the app, or the key stages it for approval. lib/bookkeeping/unattended-ceiling.ts
 * raises it; `attempted` and `limit` are SEK. `attempted` is null for an act
 * whose amounts are only known as it posts them (a year-end close), which a
 * key with a ceiling never runs.
 */
export class UnattendedCommitLimitExceededError extends Error {
  readonly code = UNATTENDED_COMMIT_LIMIT_EXCEEDED
  constructor(
    public readonly attempted: number | null,
    public readonly limit: number,
  ) {
    super(
      attempted === null
        ? `Unattended commit limit: a key with a limit of ${limit} SEK may not run this unattended`
        : `Unattended commit limit exceeded: ${attempted} SEK is above the key's limit of ${limit} SEK`,
    )
    this.name = 'UnattendedCommitLimitExceededError'
  }
}

/**
 * A periodisering draft (source_type 'accrual') handed to a generic commit:
 * the dashboard's, the v1 API's, an agent's. Such a verifikat is posted only
 * by the periodisering itself, in the transaction that marks the month (or
 * the rest of the schedule) it books (commit_accrual_installment,
 * commit_accrual_dissolution). A draft a killed run left behind, posted from
 * here, would be a verifikat no month points at, and the posting run would
 * book the month again: the interim account dissolved twice. Nothing is
 * posted and no number is drawn; the next posting run books the month and
 * cancels the draft.
 */
export class AccrualDraftPostedByScheduleError extends Error {
  readonly code = ACCRUAL_DRAFT_POSTED_BY_SCHEDULE
  /** The draft, when one exists: createJournalEntry and createJournalEntries refuse before drafting. */
  constructor(public readonly journalEntryId: string | null = null) {
    super('A periodisering verifikat is posted by its schedule, together with the month it books')
    this.name = 'AccrualDraftPostedByScheduleError'
  }
}

/**
 * A booking a booking review rule matches (booking_review_rules, accounted#130
 * step 2) that was about to be posted without a person's review: by a key,
 * an agent, a grant, cron, a bulk path or a one click. commit_journal_entry
 * refused it before a voucher number was drawn, so nothing is posted. A
 * person books it from its review in the app; an agent stages it.
 */
export class BookingReviewRequiredError extends Error {
  readonly code = BOOKING_REVIEW_REQUIRED
  constructor(public readonly journalEntryId: string | null = null) {
    super('A booking review rule matches this booking, so a person books it from its review')
    this.name = 'BookingReviewRequiredError'
  }
}

/**
 * A person reviewed a booking a rule matches, but the company has set
 * booking_review limits (company_attest_limits) and theirs does not cover
 * the bank rows' amount, or they have none. Nothing is posted.
 */
export class BookingReviewLimitError extends Error {
  readonly code = BOOKING_REVIEW_LIMIT
  constructor(
    public readonly amountSek: number | null,
    public readonly limitSek: number | null,
  ) {
    super(
      limitSek === null
        ? 'Booking review limit: the reviewer has no booking_review limit, and the company has set them'
        : `Booking review limit: ${amountSek} SEK is above the reviewer's limit of ${limitSek} SEK`,
    )
    this.name = 'BookingReviewLimitError'
  }
}

// ============================================================================
// BookkeepingDatabaseError: single wrapper for all "Failed to <op>: <cause>"
// engine throws. The `operation` tag is preserved for logs; the cause string
// stays in `message` so period-lock / trigger messages can still be matched
// by regex patterns in get-error-message.ts.
// ============================================================================

export type BookkeepingOperation =
  | 'import_sie_chunk'
  | 'undo_sie_import_chunk'
  | 'undo_sie_duplicate_repair_chunk'
  | 'get_next_voucher_number'
  | 'peek_next_voucher_number'
  | 'resolve_account_ids'
  | 'create_draft_entry'
  | 'create_entry_lines'
  | 'cancel_draft_entry'
  | 'commit_entry'
  | 'commit_asset_disposal'
  | 'fetch_asset_disposal_entry'
  | 'commit_asset_depreciation'
  | 'fetch_asset_depreciation_entry'
  | 'commit_asset_component_replacement'
  | 'fetch_asset_component_replacement_entry'
  | 'commit_asset_value_adjustment'
  | 'fetch_asset_value_adjustment_entry'
  | 'commit_accrual_installment'
  | 'fetch_accrual_installment_entry'
  | 'commit_accrual_dissolution'
  | 'fetch_accrual_dissolution_entry'
  | 'commit_deferred_tax'
  | 'fetch_deferred_tax_entry'
  | 'commit_contract_revenue'
  | 'fetch_contract_revenue_entry'
  | 'commit_k3_transition'
  | 'fetch_k3_transition_entry'
  | 'load_collected_payment_rows'
  | 'load_collections_rebook'
  | 'create_reversal_entry'
  | 'create_reversal_lines'
  | 'post_reversal_entry'
  | 'replace_opening_balance'
  | 'create_corrected_entry'
  | 'create_corrected_lines'
  | 'post_corrected_entry'
  | 'fetch_currency_receivables'
  | 'fetch_currency_payables'
  | 'check_existing_revaluation'
  | 'resolve_settlement_account'
  // The account a payment file pays from (lib/payments/paying-account.ts).
  | 'resolve_paying_account'
  // Posting port (lib/posting), strict mode only: the business event or its
  // link to the draft could not be written, so nothing was posted.
  | 'record_business_event'
  | 'link_business_event'

export class BookkeepingDatabaseError extends Error {
  readonly code:
    | typeof BOOKKEEPING_DATABASE_ERROR
    | typeof BANK_BOOKING_CONTEXT_REQUIRED
    | ReturnType<typeof conflictCode>
    | DatabaseRefusalCode
  constructor(
    public readonly operation: BookkeepingOperation,
    public readonly cause: string | undefined,
    public readonly pgCode?: string,
  ) {
    super(cause ? `Database operation "${operation}" failed: ${cause}` : `Database operation "${operation}" failed`)
    this.name = 'BookkeepingDatabaseError'
    // A PT409 refusal keeps the name the database raised it with, so the
    // user reads what was refused rather than a generic conflict. So does
    // the bank-booking guard's 23514 for a bank row's verifikat that does not
    // name its row: no retry posts it, and "Verifikationen kunde inte sparas.
    // Försök igen." sent a person round that loop (2026-11-16). And so does a
    // write behind a period lock, a closed year or the lock date: the lock
    // holds, so it is PERIOD_LOCKED, not a retryable 500 (2026-11-22).
    const refusal = cause ? databaseRefusal(cause) : null
    this.code =
      pgCode === 'PT409'
        ? conflictCode(cause)
        : isBankBookingContextRefusal(pgCode, cause)
          ? BANK_BOOKING_CONTEXT_REQUIRED
          : refusal
            ? refusal.code
            : BOOKKEEPING_DATABASE_ERROR
  }
}

/**
 * guard_bank_booking_context's refusal as the database raises it: 23514,
 * named BANK_BOOKING_CONTEXT_REQUIRED. An answer, not a failure: the doors
 * reply 409 with where to book the bank row instead.
 */
export function isBankBookingContextRefusal(pgCode: unknown, message: unknown): boolean {
  return pgCode === '23514' && message === BANK_BOOKING_CONTEXT_REQUIRED
}

/**
 * An SIE voucher chunk refused by journal_import_source_owned_idx: one of its
 * vouchers has the source series and number of a posted imported verifikat
 * of the same fiscal year. The chunk is refused the same way on every try,
 * so the SIE worker stops the job instead of retrying it. `voucherRef` names
 * the voucher ("A762") when the refusal's key does.
 */
export class SIESourceVoucherTakenError extends BookkeepingDatabaseError {
  constructor(cause: string, readonly voucherRef: string | null) {
    super('import_sie_chunk', cause, '23505')
    this.name = 'SIESourceVoucherTakenError'
  }
}

/**
 * The journal_import_source_owned_idx refusal in an import_sie_chunk error,
 * or null for any other failure. The unique violation's detail names the key:
 * "Key (company_id, fiscal_period_id, source_voucher_series,
 * source_voucher_number)=(<uuid>, <uuid>, A, 762) already exists."
 */
export function sieSourceVoucherTaken(error: { code?: string; message: string; details?: string | null }): SIESourceVoucherTakenError | null {
  if (error.code !== '23505' || !error.message.includes('"journal_import_source_owned_idx"')) return null
  const key = /=\([0-9a-f-]{36}, [0-9a-f-]{36}, (.*), (-?\d+)\) already exists/.exec(error.details ?? '')
  return new SIESourceVoucherTakenError(error.message, key ? `${key[1]!.trim()}${key[2]}` : null)
}

export interface UnusedVoucherAllocation {
  fiscalPeriodId: string
  voucherSeries: string
  voucherNumber: number
}

const UNUSED_VOUCHER_ALLOCATION = Symbol('unused-voucher-allocation')

/**
 * Preserve the exact durable sequence allocation when an engine operation
 * fails before any journal-entry row uses the number. The original error type
 * is retained so existing API mappings remain unchanged.
 */
export function withUnusedVoucherAllocation<T>(
  error: T,
  allocation: UnusedVoucherAllocation,
): T {
  if (error instanceof Error) {
    Object.defineProperty(error, UNUSED_VOUCHER_ALLOCATION, {
      value: allocation,
      enumerable: false,
    })
  }
  return error
}

export function getUnusedVoucherAllocation(error: unknown): UnusedVoucherAllocation | null {
  if (!(error instanceof Error)) return null
  return (
    error as Error & { [UNUSED_VOUCHER_ALLOCATION]?: UnusedVoucherAllocation }
  )[UNUSED_VOUCHER_ALLOCATION] ?? null
}

// ============================================================================
// Type guard
// ============================================================================

/**
 * True if `err` is any typed bookkeeping error. Use this in inner catch blocks
 * that want to re-throw domain errors so the outer handler can translate them
 * via bookkeepingErrorResponse().
 */
export function isBookkeepingError(err: unknown): boolean {
  return (
    err instanceof AccountsNotInChartError ||
    err instanceof JournalEntryNotBalancedError ||
    err instanceof JournalLineNegativeAmountError ||
    err instanceof JournalLineBothSidesNonZeroError ||
    err instanceof FiscalPeriodNotFoundError ||
    err instanceof EntryDateOutsideFiscalPeriodError ||
    err instanceof JournalEntryNotFoundError ||
    err instanceof CannotReverseNonPostedError ||
    err instanceof CannotReverseStornoError ||
    err instanceof CannotReverseCollectedPaymentError ||
    err instanceof CannotCorrectNonPostedError ||
    err instanceof CannotEditNonDraftError ||
    err instanceof CannotCancelNonDraftError ||
    err instanceof EntryAlreadyReversedError ||
    err instanceof MigratedDeductionHeldByRequestError ||
    err instanceof ReversalHookMissingError ||
    err instanceof CurrencyRevaluationAlreadyExistsError ||
    err instanceof InvalidMappingResultError ||
    err instanceof TransactionMissingSekValueError ||
    err instanceof TransactionLinesNotBalancedError ||
    err instanceof UnattendedCommitLimitExceededError ||
    err instanceof BookingReviewRequiredError ||
    err instanceof AccrualDraftPostedByScheduleError ||
    err instanceof BookingReviewLimitError ||
    err instanceof BookkeepingDatabaseError ||
    err instanceof MeaninglessCorrectionError ||
    err instanceof CorrectionChainTooDeepError ||
    err instanceof NoOpenPeriodForDateError ||
    err instanceof TargetPeriodClosedError ||
    err instanceof TargetPeriodLockedError ||
    err instanceof AccruedCostPeriodInvalidError ||
    err instanceof AccruedCostPeriodLockedError ||
    err instanceof AccruedIncomePeriodInvalidError ||
    err instanceof AccruedIncomePeriodLockedError ||
    err instanceof DeferralPeriodPastError ||
    err instanceof CutoffCarryReversalDateError ||
    err instanceof KontantmetodCarryHasSettlementsError ||
    err instanceof CutoffCarryCorrectionRefusedError ||
    err instanceof ImportVatWithoutBaseError ||
    err instanceof CorrectionBankAccountChangedError ||
    err instanceof DimensionValidationError ||
    err instanceof MandatoryDimensionMissingError
  )
}

// ============================================================================
// Response helpers
// ============================================================================

/**
 * Build a structured 400 response for AccountsNotInChartError.
 * Kept for back-compat with existing callers; new code should prefer
 * bookkeepingErrorResponse() which covers all typed bookkeeping errors.
 */
export function accountsNotInChartResponse(err: AccountsNotInChartError) {
  return NextResponse.json(
    {
      error: {
        code: err.code,
        message: `Följande konton behöver aktiveras: ${err.accountNumbers.join(', ')}`,
        // Dual-emit: top-level for legacy frontend callers, nested under
        // `details` to match the v1 envelope shape so a single client (MCP
        // or external) can read `error.details.account_numbers` regardless
        // of which categorize endpoint it hit.
        account_numbers: err.accountNumbers,
        details: { account_numbers: err.accountNumbers },
      },
    },
    { status: 400 }
  )
}

/**
 * Build a structured JSON response for any typed bookkeeping error.
 * Returns null if `err` is not a recognized bookkeeping error so callers can
 * fall through to their existing generic handling.
 *
 * Response shape: { error: { code, message, details? } }
 * HTTP status: 404 for *_NOT_FOUND, 409 for concurrent/duplicate conflicts,
 * 500 for BOOKKEEPING_DATABASE_ERROR, 400 for a lock refusal and otherwise.
 */
export function bookkeepingErrorResponse(err: unknown): NextResponse | null {
  if (err instanceof AccountsNotInChartError) {
    return accountsNotInChartResponse(err)
  }

  if (err instanceof JournalEntryNotBalancedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            totalDebit: err.totalDebit,
            totalCredit: err.totalCredit,
            kind: err.kind,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof JournalLineNegativeAmountError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            accountNumber: err.accountNumber,
            debitAmount: err.debitAmount,
            creditAmount: err.creditAmount,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof JournalLineBothSidesNonZeroError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            accountNumber: err.accountNumber,
            debitAmount: err.debitAmount,
            creditAmount: err.creditAmount,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof FiscalPeriodNotFoundError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 404 }
    )
  }

  if (err instanceof EntryDateOutsideFiscalPeriodError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            entryDate: err.entryDate,
            periodName: err.periodName,
            periodStart: err.periodStart,
            periodEnd: err.periodEnd,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof JournalEntryNotFoundError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 404 }
    )
  }

  if (err instanceof CannotReverseNonPostedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CannotReverseStornoError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { sourceType: err.sourceType },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CannotCorrectNonPostedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CannotEditNonDraftError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof CannotCancelNonDraftError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { currentStatus: err.currentStatus },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof EntryAlreadyReversedError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 409 }
    )
  }

  if (err instanceof MigratedDeductionHeldByRequestError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: { invoiceId: err.invoiceId } } },
      { status: 409 }
    )
  }

  if (err instanceof ReversalHookMissingError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: { sourceType: err.sourceType } } },
      { status: 500 }
    )
  }

  if (err instanceof CurrencyRevaluationAlreadyExistsError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 409 }
    )
  }

  if (err instanceof InvalidMappingResultError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            debitAccount: err.debitAccount,
            creditAccount: err.creditAccount,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof TransactionMissingSekValueError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            transactionId: err.transactionId,
            currency: err.currency,
            date: err.date,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof TransactionLinesNotBalancedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: {
            transactionId: err.transactionId,
            totalDebit: err.totalDebit,
            totalCredit: err.totalCredit,
            fromLinePattern: err.fromLinePattern,
          },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof MeaninglessCorrectionError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { reason: err.reason },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CorrectionChainTooDeepError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { depth: err.depth, chainRootVoucher: err.chainRootVoucher },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof NoOpenPeriodForDateError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof TargetPeriodClosedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof TargetPeriodLockedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { date: err.date, lockDate: err.lockDate },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof CutoffCarryReversalDateError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { carryDate: err.carryDate, reversalDate: err.reversalDate },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof KontantmetodCarryHasSettlementsError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { invoiceId: err.invoiceId },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof CutoffCarryCorrectionRefusedError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message } },
      { status: 409 }
    )
  }

  if (err instanceof ImportVatWithoutBaseError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { import_vat_accounts: err.importVatAccounts },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof CorrectionBankAccountChangedError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { bank_account: err.bankAccount, moved_to: err.movedTo },
        },
      },
      { status: 409 }
    )
  }

  if (err instanceof DimensionValidationError) {
    // err.message is already the user-facing Swedish sentence(s) naming the
    // offending code(s); details.issues carries the machine-readable list.
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { issues: err.issues },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof MandatoryDimensionMissingError) {
    // Policy rejection at commit (dimensions PR10): the message names every
    // account + required dimension so a user or agent self-corrects in one
    // pass; details.violations is the machine-readable list.
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { violations: err.violations },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof BookkeepingDatabaseError) {
    // A refusal the database raised on purpose answers with its code's
    // registry status: 409 for a conflict or the bank-booking guard, 400 for
    // a lock (PERIOD_LOCKED, as the doors that check the lock first answer).
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { operation: err.operation },
        },
      },
      { status: err.code === BOOKKEEPING_DATABASE_ERROR ? 500 : (getErrorEntry(err.code)?.httpStatus ?? 409) }
    )
  }

  if (err instanceof AccruedCostPeriodInvalidError || err instanceof AccruedIncomePeriodInvalidError) {
    return NextResponse.json(
      {
        error: {
          code: err.code,
          message: err.message,
          details: { periodStart: err.periodStart, periodEnd: err.periodEnd, invoiceDate: err.invoiceDate },
        },
      },
      { status: 400 }
    )
  }

  if (err instanceof DeferralPeriodPastError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: deferralPeriodPastDetails(err) } },
      { status: 400 }
    )
  }

  if (err instanceof AccruedCostPeriodLockedError || err instanceof AccruedIncomePeriodLockedError) {
    return NextResponse.json(
      { error: { code: err.code, message: err.message, details: { blocked: err.blocked } } },
      { status: 400 }
    )
  }

  return null
}
