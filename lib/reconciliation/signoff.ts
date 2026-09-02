import type { SupabaseClient } from '@supabase/supabase-js'
import { ISO_DATE_RE } from '@/lib/invariants'
import { eventBus } from '@/lib/events/bus'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { todayIsoUtc } from '@/lib/dates/iso'
import { parseAccountKey, type ReconciliationSignoff, type ReconciliationStatus } from './schemas'
import { getAccountStatus } from './service'
import { getLatestSignoff, getSignoffById, insertSignoff, stampReopen } from './signoff-store'

const log = createLogger('reconciliation/signoff')

/**
 * Sign-off ("Markera som avstämd t.o.m. <datum>") and reopen on one
 * reconcilable account. The policy layer over signoff-store.ts: a sign-off
 * is refused unless the engine says the account is reconciled through that
 * date, or the signer explicitly overrides with a note. Writes nothing to
 * the ledger; the row is the attestation the overview, the Hem row and an
 * auditor read.
 *
 * Same function for the dashboard routes, the v1 API and the MCP executor,
 * so the rule is one rule.
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

export class ReconciliationSignoffError extends Error {
  readonly code: SignoffErrorCode
  constructor(message: string, code: SignoffErrorCode) {
    super(message)
    this.name = 'ReconciliationSignoffError'
    this.code = code
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
   * negative). Only for manual accounts without a system specification; the
   * bank, the skattekonto and the reskontra/semesterskuld accounts have their
   * own outside truth and refuse it.
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
  unexplained_difference: number | null
  is_reconciled: boolean
  forced: boolean
  /** The active sign-off this one supersedes in the rail, when any (earlier through_date). */
  previous_through_date: string | null
}

export type SignoffResult =
  | { dry_run: true; would_sign: SignoffPreview }
  | { dry_run: false; signoff: ReconciliationSignoff }

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
  const today = options.today ?? todayIsoUtc()
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
  // bridge is a period movement, so the window simply ends on the date.
  const status: ReconciliationStatus | null = await getAccountStatus(supabase, companyId, accountKey, {
    today,
    windowTo: throughDate,
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
  // number would only hide a real difference, so it is refused there.
  if (input.external_balance != null) {
    if (status.kind !== 'manual' || status.manual?.specification) {
      throw new ReconciliationSignoffError(
        'Kontot har redan en sanning utanför bokföringen (bank, Skatteverket, reskontra eller beräkning). Ange inget saldo manuellt; signera med en notering om något avviker.',
        'EXTERNAL_BALANCE_NOT_ALLOWED',
      )
    }
    const external = roundOre(input.external_balance)
    const difference = status.ledger_balance == null ? null : roundOre(status.ledger_balance - external)
    status.external_balance = external
    status.difference = difference
    status.unexplained_difference = difference
    status.is_reconciled = difference != null && Math.abs(difference) < 0.005
  }

  const unexplained = status.unexplained_difference
  const reconciled = unexplained != null && Math.abs(unexplained) < 0.005
  if (!reconciled && !force) {
    if (unexplained == null) {
      throw new ReconciliationSignoffError(
        'Saldot utanför bokföringen är okänt, så kontot kan inte stämmas av. Hämta det först, eller signera med en notering.',
        'OUTSIDE_UNKNOWN',
      )
    }
    throw new ReconciliationSignoffError(
      'Kontot har en oförklarad differens. Koppla eller bokför raderna först, eller signera med en notering.',
      'NOT_RECONCILED',
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
    is_reconciled: reconciled,
    forced: !reconciled,
    previous_through_date: latest?.through_date ?? null,
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
  return { dry_run: false, signoff }
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
