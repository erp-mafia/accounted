import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { formatCurrency } from '@/lib/utils'
import { bookedBalanceOnDay, type BankBalanceCheck, type BankBalanceCheckRefusal } from './bank-balance-check'
import { parseAccountKey, type ReconciliationSignoff, type ReconciliationStatus } from './schemas'
import { getAccountStatus } from './service'
import { getLatestSignoff, getSignoffById, insertSignoff, stampReopen } from './signoff-store'

const log = createLogger('reconciliation/signoff')

/**
 * Sign-off ("Markera som avstämd t.o.m. <datum>") and reopen on one
 * reconcilable account. The policy layer over signoff-store.ts: a sign-off
 * is refused unless the engine explains every difference through that date
 * (unexplained_difference 0, open rows listed on the bridge allowed), or the
 * signer explicitly overrides with a note. Writes nothing to
 * the ledger; the row is the attestation the overview, the Hem row and an
 * auditor read.
 *
 * Same function for the dashboard routes, the v1 API and the MCP executor,
 * so the rule is one rule.
 *
 * On a bank account the bridge compares movements in the window, never
 * balances. Beside it the sign-off carries the bank's own balance against the
 * books at the end of the date (bank_balance) and a warning when they differ
 * or the bank has no balance for the date. The warning never blocks. A bank
 * account no bank connection feeds may instead be signed against the
 * statement's balance (external_balance), judged as on a manual account.
 */

export type SignoffErrorCode =
  | 'INVALID_DATE'
  | 'DATE_IN_FUTURE'
  | 'NOT_FETCHED_THROUGH'
  | 'OUTSIDE_UNKNOWN'
  | 'NOT_RECONCILED'
  | 'NOTE_REQUIRED'
  | 'ALREADY_SIGNED_OFF'
  | 'SIGNOFF_NOT_FOUND'
  | 'ALREADY_REOPENED'
  | 'SIGNOFF_RACE'
  | 'EXTERNAL_BALANCE_NOT_ALLOWED'

export interface SignoffErrorDetails {
  /** NOT_RECONCILED: the unexplained difference the engine saw for the window, so a dialog can name the amount. */
  unexplained_difference?: number | null
  /** NOT_RECONCILED on a bank account: the balance comparison, so a dialog shows it before a forced sign-off too. */
  bank_balance?: SignoffBankBalance | null
  warning?: SignoffWarning | null
}

export type SignoffWarningCode = 'BANK_BALANCE_DIFFERS' | 'NO_BANK_BALANCE'

/** What the signer should see beside a sign-off; never a refusal. */
export interface SignoffWarning {
  code: SignoffWarningCode
  /** Plain Swedish, for the signer. */
  message: string
}

/**
 * Bank accounts: the bank's own balance against the booked balance on the
 * account at the end of the through-date, as the bank balance check reads
 * them (bank-balance-check.ts). Shown and warned about, never judged.
 */
export interface SignoffBankBalance {
  as_of: string
  /** What the bank reported for the day, else the balance after its last row through it; null when the feed has none. */
  bank_balance: number | null
  /** Booked balance at the end of as_of, opening balance included; null when it cannot be read in the account's currency. */
  booked_balance: number | null
  /** bank_balance - booked_balance; null when either is unknown. */
  difference: number | null
  /** Bank rows through as_of without a verifikat (BankBalanceCheck.unbooked); null without a comparison. */
  unbooked: { count: number; total: number } | null
  /**
   * The part of the difference from before the bank's first row
   * (BankBalanceCheck.before_history): usually an opening balance that never
   * reached the books. Null without a comparison or a first row.
   */
  before_history: { history_start: string; difference: number } | null
  /** The rest of the difference (BankBalanceCheck.rest); null without a comparison. */
  rest: number | null
}

export class ReconciliationSignoffError extends Error {
  readonly code: SignoffErrorCode
  readonly details: SignoffErrorDetails | null
  constructor(message: string, code: SignoffErrorCode, details: SignoffErrorDetails | null = null) {
    super(message)
    this.name = 'ReconciliationSignoffError'
    this.code = code
    this.details = details
  }
}

export interface SignoffInput {
  /** Inclusive ISO date the account is asserted reconciled through. */
  through_date: string
  /** Free text; required when signing with an unexplained difference (force). */
  note?: string | null
  /** Sign even though the engine reports an unexplained difference or an unknown outside balance. Needs a note. */
  force?: boolean
  /**
   * The balance per the signer's underlag, in ledger sign (liabilities
   * negative). For manual accounts without a system specification, and bank
   * accounts no bank connection feeds (the statement's balance at the end of
   * the date); a connected bank account, the skattekonto and the
   * reskontra/semesterskuld accounts have their own outside truth and refuse
   * it. Judged against the booked balance at the end of the date.
   */
  external_balance?: number | null
}

export interface SignoffOptions {
  dryRun?: boolean
  /** ISO date for "today" (tests). */
  today?: string
}

export interface SignoffPreview {
  account_key: string
  through_date: string
  external_balance: number | null
  ledger_balance: number | null
  /** What the sign-off judges: 0 means every difference is explained, open rows included. */
  unexplained_difference: number | null
  /**
   * The engine's verdict for the same window, the very field the account
   * status carries: explained AND nothing left open (crm#1183: the preview
   * said true while the status said false). A sign-off does not need it.
   */
  is_reconciled: boolean
  /** Signed despite an unexplained difference or an unknown outside balance (force + note). */
  forced: boolean
  /** The active sign-off this one supersedes in the rail, when any (earlier through_date). */
  previous_through_date: string | null
  /** Bank accounts (null for the others): the bank's balance against the books at the end of through_date. */
  bank_balance: SignoffBankBalance | null
  /** The bank's balance differs from the books on through_date, or there is none to compare with. */
  warning: SignoffWarning | null
}

export type SignoffResult =
  | { dry_run: true; would_sign: SignoffPreview }
  | { dry_run: false; signoff: ReconciliationSignoff; bank_balance: SignoffBankBalance | null; warning: SignoffWarning | null }

/**
 * The start of the fiscal period that covers `throughDate`, or null when no
 * period does (or the read fails). The bank bridge is a period movement, so
 * its lower bound decides the verdict: without this the sign-off judged the
 * calendar year from 1 January, while the page the signer looked at was
 * scoped to the fiscal period. A company with a broken fiscal year (September
 * to August) then saw the dialog allow a sign-off the server refused.
 */
async function fiscalPeriodStartFor(
  supabase: SupabaseClient,
  companyId: string,
  throughDate: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('period_start')
    .eq('company_id', companyId)
    .lte('period_start', throughDate)
    .gte('period_end', throughDate)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    log.warn('fiscal period lookup failed for sign-off window', {
      companyId,
      throughDate,
      error: error.message,
    })
    return null
  }
  const start = (data as { period_start?: string | null } | null)?.period_start
  return typeof start === 'string' && ISO_DATE_RE.test(start) ? start : null
}

/**
 * Whether a bank connection feeds the cash account: the same test the
 * account list makes for its source (psd2 when it has one). A failed read
 * is no answer, so it throws rather than let a stated balance through, and a
 * row that is gone (removed while the sign-off ran) counts as connected:
 * only an account known to have no connection takes a stated balance.
 */
async function hasBankConnection(supabase: SupabaseClient, companyId: string, cashAccountId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('bank_connection_id')
    .eq('company_id', companyId)
    .eq('id', cashAccountId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa kassakontot: ${error.message}`)
  const row = data as { bank_connection_id?: string | null } | null
  return row === null || Boolean(row.bank_connection_id)
}

/**
 * The bank's balance against the books at the end of the through-date, from
 * the status read with balanceCheckOn, with the check's parts of the
 * difference. Without a balance from the bank the booked side still comes
 * along, so the signer can hold it against the statement. None for an
 * account kept in another currency than the ledger, or a date outside every
 * fiscal year: the books hold no balance to compare the bank's with there,
 * while the bank may well have one, so nothing is claimed either way.
 */
async function bankBalanceAt(
  supabase: SupabaseClient,
  companyId: string,
  status: ReconciliationStatus,
  throughDate: string,
): Promise<SignoffBankBalance | null> {
  if (status.kind !== 'bank') return null
  const bank = status.bank as unknown as {
    balance_check?: BankBalanceCheck | null
    balance_check_refusal?: BankBalanceCheckRefusal | null
  } | null
  const check = bank?.balance_check ?? null
  if (check) {
    return {
      as_of: check.as_of,
      bank_balance: check.bank_balance,
      booked_balance: check.booked_balance,
      difference: check.difference,
      unbooked: check.unbooked,
      before_history: check.before_history
        ? { history_start: check.before_history.history_start, difference: check.before_history.difference }
        : null,
      rest: check.rest,
    }
  }
  const refusal = bank?.balance_check_refusal ?? null
  if (refusal === 'FOREIGN_CURRENCY_ACCOUNT' || refusal === 'NO_FISCAL_PERIOD') return null
  let booked: number | null = null
  if (refusal === 'NO_BANK_BALANCE') {
    booked = await bookedBalanceOnDay(supabase, companyId, status.account_number, throughDate).catch((err) => {
      log.warn('booked balance for sign-off failed', {
        companyId,
        accountKey: status.account_key,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    })
  }
  return {
    as_of: throughDate,
    bank_balance: null,
    booked_balance: booked,
    difference: null,
    unbooked: null,
    before_history: null,
    rest: null,
  }
}

function bankBalanceWarning(
  comparison: SignoffBankBalance | null,
  accountNumber: string,
  currency: string,
): SignoffWarning | null {
  if (!comparison) return null
  const { as_of: date, bank_balance: bank, booked_balance: booked, difference, unbooked, before_history: before } = comparison
  const money = (amount: number) => formatCurrency(amount, currency)
  if (bank !== null && booked !== null && difference !== null) {
    if (Math.abs(difference) < 0.005) return null
    // The parts the user can act on, as the account page names them.
    const unbookedPart =
      unbooked && unbooked.count > 0
        ? ` ${unbooked.count === 1 ? '1 banktransaktion' : `${unbooked.count} banktransaktioner`} utan verifikation står för ${money(unbooked.total)}.`
        : ''
    const beforePart =
      before && Math.abs(before.difference) >= 0.005
        ? ` Av skillnaden ligger ${money(before.difference)} före bankens första transaktion ${before.history_start}, oftast ett ingående saldo som aldrig bokfördes.`
        : ''
    return {
      code: 'BANK_BALANCE_DIFFERS',
      message: `Bankens saldo per ${date} är ${money(bank)}, men ${accountNumber} visar ${money(booked)} samma dag: en skillnad på ${money(difference)}.${unbookedPart}${beforePart} Signeringen stoppas inte av det; kontrollera skillnaden mot kontoutdraget.`,
    }
  }
  return {
    code: 'NO_BANK_BALANCE',
    message: `Det finns inget saldo från banken per ${date} att jämföra ${accountNumber} med${booked !== null ? ` (bokfört samma dag: ${money(booked)})` : ''}. Signeringen stoppas inte av det; kontrollera saldot mot kontoutdraget.`,
  }
}

/**
 * Sign one account off through a date. Returns null when the account key does
 * not resolve for this company (callers map that to 404); throws
 * ReconciliationSignoffError for every policy refusal.
 */
export async function signOffAccount(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  input: SignoffInput,
  options: SignoffOptions = {},
): Promise<SignoffResult | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  const today = options.today ?? todayIsoStockholm()
  const throughDate = input.through_date
  if (!ISO_DATE_RE.test(throughDate) || Number.isNaN(Date.parse(throughDate))) {
    throw new ReconciliationSignoffError('Ogiltigt datum. Ange ÅÅÅÅ-MM-DD.', 'INVALID_DATE')
  }
  if (throughDate > today) {
    throw new ReconciliationSignoffError('Du kan inte stämma av framåt i tiden.', 'DATE_IN_FUTURE')
  }
  const note = input.note?.trim() ? input.note.trim() : null
  const force = input.force === true
  if (force && !note) {
    throw new ReconciliationSignoffError(
      'Skriv en rad om varför du signerar trots att allt inte är förklarat.',
      'NOTE_REQUIRED',
    )
  }

  // The engine's view through the requested date. The skattekonto bridge is
  // anchored at the saldo snapshot, so the date cannot pass it; the bank
  // bridge is a period movement, so the window runs from the start of the
  // fiscal period that covers the date (the opening balance) to the date. A
  // manual account is a balance and ignores the lower bound.
  const windowFrom = parsed.kind === 'bank' ? await fiscalPeriodStartFor(supabase, companyId, throughDate) : null
  const status: ReconciliationStatus | null = await getAccountStatus(supabase, companyId, accountKey, {
    today,
    windowTo: throughDate,
    ...(windowFrom ? { windowFrom } : {}),
    ...(parsed.kind === 'bank' ? { balanceCheckOn: throughDate } : {}),
  })
  if (!status) return null
  const asOfDate = status.as_of.slice(0, 10)
  if (status.kind === 'skattekonto' && throughDate > asOfDate) {
    throw new ReconciliationSignoffError(
      `Skattekontot är hämtat t.o.m. ${asOfDate}. Hämta igen innan du stämmer av ett senare datum.`,
      'NOT_FETCHED_THROUGH',
    )
  }

  // A stated outside balance is the manual adapter's outside truth for the
  // date. Where the system keeps a specification (or a feed) the stated
  // number would only hide a real difference, so it is refused there. A bank
  // account no bank connection feeds, though it has a cash account (a card
  // or a cash box kept by hand or from files), has no balance from the bank
  // to hold the books against: there the statement's balance for the date is
  // taken as on a manual account (decision 2026-11-23).
  const stated = input.external_balance != null ? roundOre(input.external_balance) : null
  const statedOnBank =
    stated != null &&
    parsed.kind === 'bank' &&
    status.kind === 'bank' &&
    !(await hasBankConnection(supabase, companyId, parsed.cashAccountId))
  if (stated != null && !statedOnBank && (status.kind !== 'manual' || status.manual?.specification)) {
    throw new ReconciliationSignoffError(
      'Kontot har redan en sanning utanför bokföringen (bank, Skatteverket, reskontra eller beräkning). Ange inget saldo manuellt; signera med en notering om något avviker.',
      'EXTERNAL_BALANCE_NOT_ALLOWED',
    )
  }
  const bankRefusal = (status.bank as { balance_check_refusal?: BankBalanceCheckRefusal | null } | null)?.balance_check_refusal
  if (statedOnBank && bankRefusal === 'FOREIGN_CURRENCY_ACCOUNT') {
    throw new ReconciliationSignoffError(
      'Kontot förs i en annan valuta än bokföringen, så ett angivet saldo kan inte jämföras med det bokförda. Signera utan saldo, med en notering om något avviker.',
      'EXTERNAL_BALANCE_NOT_ALLOWED',
    )
  }

  const bankBalance = await bankBalanceAt(supabase, companyId, status, throughDate)
  let warning = bankBalanceWarning(bankBalance, status.account_number, status.currency)

  if (stated != null) {
    // The booked side at the end of the date. A bank account's own
    // ledger_balance is what the books moved in the window, so on a bank
    // account it is the booked side of the bank balance comparison.
    const ledger = statedOnBank ? (bankBalance?.booked_balance ?? null) : status.ledger_balance
    const difference = ledger == null ? null : roundOre(ledger - stated)
    status.external_balance = stated
    status.ledger_balance = ledger
    status.difference = difference
    status.unexplained_difference = difference
    status.is_reconciled = difference != null && Math.abs(difference) < 0.005
    // The statement's balance is the one the bank had none of.
    if (warning?.code === 'NO_BANK_BALANCE') warning = null
  }

  // The sign-off's rule is the explained difference (decision 2026-08-23):
  // open rows that the bridge lists are the specification an attestation may
  // carry. Whether nothing is left open is the status's is_reconciled, which
  // the preview reports unchanged rather than a second meaning of the word.
  const unexplained = status.unexplained_difference
  const explained = unexplained != null && Math.abs(unexplained) < 0.005
  if (!explained && !force) {
    if (unexplained == null) {
      throw new ReconciliationSignoffError(
        'Saldot utanför bokföringen är okänt, så kontot kan inte stämmas av. Hämta det först, eller signera med en notering.',
        'OUTSIDE_UNKNOWN',
      )
    }
    throw new ReconciliationSignoffError(
      'Kontot har en oförklarad differens. Koppla eller bokför raderna först, eller signera med en notering.',
      'NOT_RECONCILED',
      { unexplained_difference: unexplained, ...(bankBalance ? { bank_balance: bankBalance, warning } : {}) },
    )
  }

  const latest = await getLatestSignoff(supabase, companyId, accountKey)
  if (latest && latest.through_date >= throughDate) {
    throw new ReconciliationSignoffError(
      `Kontot är redan avstämt t.o.m. ${latest.through_date}. Öppna den signeringen igen om du vill ändra.`,
      'ALREADY_SIGNED_OFF',
    )
  }

  const preview: SignoffPreview = {
    account_key: accountKey,
    through_date: throughDate,
    external_balance: status.external_balance,
    ledger_balance: status.ledger_balance,
    unexplained_difference: unexplained,
    is_reconciled: status.is_reconciled,
    forced: !explained,
    previous_through_date: latest?.through_date ?? null,
    bank_balance: bankBalance,
    warning,
  }
  if (options.dryRun) return { dry_run: true, would_sign: preview }

  let signoff: ReconciliationSignoff
  try {
    signoff = await insertSignoff(supabase, companyId, {
      account_key: accountKey,
      through_date: throughDate,
      external_balance: status.external_balance,
      ledger_balance: status.ledger_balance,
      unexplained_difference: unexplained,
      note,
      signed_by: userId,
    })
  } catch (err) {
    // The partial unique index turns a concurrent identical sign-off into a
    // constraint error; surface it as a race rather than a 500.
    const message = err instanceof Error ? err.message : String(err)
    if (/ux_account_reconciliations_active|duplicate key/i.test(message)) {
      throw new ReconciliationSignoffError('Kontot signerades precis av någon annan. Ladda om.', 'SIGNOFF_RACE')
    }
    throw err
  }

  try {
    await eventBus.emit({
      type: 'reconciliation.signed_off',
      payload: {
        accountKey,
        signoffId: signoff.id,
        throughDate,
        unexplainedDifference: unexplained,
        userId,
        companyId,
      },
    })
  } catch (err) {
    log.warn('reconciliation.signed_off emit failed', { companyId, accountKey, error: err instanceof Error ? err.message : String(err) })
  }
  return { dry_run: false, signoff, bank_balance: bankBalance, warning }
}

/**
 * Reopen a sign-off (the undo). The row stays as history with the reopen
 * stamp; the account shows its previous active sign-off, if any, afterwards.
 */
export async function reopenSignoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  signoffId: string,
  input: { reason?: string | null } = {},
): Promise<ReconciliationSignoff | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed) return null
  const existing = await getSignoffById(supabase, companyId, accountKey, signoffId)
  if (!existing) {
    throw new ReconciliationSignoffError('Signeringen hittades inte.', 'SIGNOFF_NOT_FOUND')
  }
  if (existing.reopened_at) {
    throw new ReconciliationSignoffError('Signeringen är redan öppnad igen.', 'ALREADY_REOPENED')
  }
  const reason = input.reason?.trim() ? input.reason.trim() : null
  const updated = await stampReopen(supabase, companyId, signoffId, { reopened_by: userId, reason })
  if (!updated) {
    throw new ReconciliationSignoffError('Signeringen öppnades precis av någon annan.', 'SIGNOFF_RACE')
  }
  try {
    await eventBus.emit({
      type: 'reconciliation.reopened',
      payload: { accountKey, signoffId, throughDate: updated.through_date, reason, userId, companyId },
    })
  } catch (err) {
    log.warn('reconciliation.reopened emit failed', { companyId, accountKey, error: err instanceof Error ? err.message : String(err) })
  }
  return updated
}
