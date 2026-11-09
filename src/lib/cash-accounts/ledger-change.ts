/**
 * Change which 19xx ledger account a connected bank account books on, on any
 * bank connection (crm#1395, crm#1387, PH 211).
 *
 * The bank pickers set the ledger account when a bank is connected, and the
 * Enable Banking picker could change it later. An Open Payments connection
 * had no way back: its account step locks an account the company already
 * books ("Samma som förut"), and its settings row offered only Förnya and
 * Koppla bort. A customer who mapped the plusgiro account onto 1931 instead
 * of 1920 had to ask support, and so did the next six.
 *
 * This is the one provider-neutral door for that change. It reads the
 * connection's configuration, keeps every account switched on or off as it
 * is, gives the asked accounts their new ledger accounts and saves the whole
 * selection through save_bank_account_selection, the single writer of a bank
 * account's ledger account for every aggregator. The rules are the picker's:
 *   - a posted verifikat is never rewritten: what is booked stays on the old
 *     ledger account (the count is in the preview, so the UI can say so);
 *   - the cash account row is the bank account, so its unbooked transactions
 *     follow it to the new ledger account (they resolve their ledger account
 *     from the row when they are booked);
 *   - a ledger account held by another synced account of the same connection
 *     is traded: that account takes the mover's old one (a swap, in the
 *     preview as its own line);
 *   - an account that is not synced keeps its ledger account as a soft claim
 *     and yields it when a synced account asks for it, as in the picker;
 *   - a ledger account held elsewhere (another connection, another physical
 *     account) is refused by the database with a sentence naming that account;
 *   - rows that end up on one account twice, once per channel (statement
 *     files on the new ledger account, the feed of the moved account), are
 *     folded to one per movement, as the import would have: planned before
 *     the save while the accounts are apart, set aside after it
 *     (lib/cash-accounts/move-twins.ts).
 * A dry run answers the moves with their counts and writes nothing.
 */

import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { requireCompanyAdmin } from '@/lib/operations/access'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { eventBus } from '@/lib/events/bus'
import { hasErrorEntry } from '@/lib/errors/structured-errors'
import { userFacingCode } from '@/lib/errors/user-facing'
import {
  readBankConfiguration,
  saveBankAccountSelection,
  type BankAccountSelection,
} from '@/lib/cash-accounts/configuration'
import { physicalAccountKey } from '@/lib/cash-accounts/ledger-slots'
import { ibanLast4 } from '@/lib/cash-accounts/selection-refusal'
import type { LedgerMoveTwinsPlan } from '@/lib/cash-accounts/move-twins'
import { LEDGER_MOVE_TWINS } from '@/lib/composition/ledger-move-twins'

const MAX_ACCOUNTS = 50

export interface LedgerChangeRequest {
  uid: string
  ledger_account: string
}

export interface LedgerChangeMove {
  uid: string
  name: string | null
  iban_last4: string | null
  currency: string
  cash_account_id: string | null
  /** The ledger account the account books on now; null when it has none yet. */
  from_ledger: string | null
  to_ledger: string
  /** Bank rows already booked on from_ledger: their verifikat stay there. */
  booked_rows: number
  /** Bank rows not booked yet: they book on to_ledger from now on. */
  unbooked_rows: number
  /** The account moves because another account asked for its ledger account. */
  swapped: boolean
}

export interface LedgerChangeView {
  connection_id: string
  moves: LedgerChangeMove[]
}

/** The fields of a bank_connections.accounts_data entry read here, for both aggregators. */
interface StoredAccount {
  uid: string
  name?: string | null
  iban?: string | null
  currency?: string | null
  enabled?: boolean | null
  ledger_account?: string | null
}

interface CashRow {
  id: string
  ledger_account: string
  bank_connection_id: string | null
  external_uid: string | null
  iban: string | null
  currency: string
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function invalid(reason: string, extra: Record<string, unknown> = {}): Failure {
  return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'accounts', reason, ...extra } }
}

/**
 * A refusal the selection save raised: the sentence naming the bank account
 * when it carries one (lib/cash-accounts/configuration.ts), else the
 * registered name, else a server error.
 */
function saveFailure(error: unknown): Failure {
  const named = userFacingCode(error)
  if (named) return { ok: false, code: named, error }
  const message = (error as { message?: unknown } | null)?.message
  if (typeof message === 'string' && hasErrorEntry(message)) return { ok: false, code: message }
  const code = (error as { code?: unknown } | null)?.code
  if (code === 'P0002') return { ok: false, code: 'NOT_FOUND' }
  if (typeof code === 'string' && hasErrorEntry(code)) return { ok: false, code }
  return { ok: false, code: 'INTERNAL_ERROR', error }
}

function storedAccounts(raw: unknown): StoredAccount[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is StoredAccount =>
      typeof entry === 'object' && entry !== null && typeof (entry as { uid?: unknown }).uid === 'string',
  )
}

/** The company's bank rows: how many of a cash account's rows are booked and unbooked. */
async function rowCounts(ctx: OperationContext, cashAccountId: string | null): Promise<{ booked: number; unbooked: number }> {
  if (!cashAccountId) return { booked: 0, unbooked: 0 }
  const [booked, unbooked] = await Promise.all([
    ctx.supabase.rpc('cash_account_booked_rows', { p_company_id: ctx.companyId, p_cash_account_id: cashAccountId }),
    ctx.supabase
      .from('open_bank_rows')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', ctx.companyId)
      .eq('cash_account_id', cashAccountId),
  ])
  if (booked.error) throw booked.error
  if (unbooked.error) throw unbooked.error
  return { booked: Number(booked.data) || 0, unbooked: unbooked.count ?? 0 }
}

export async function changeBankAccountLedgers(
  ctx: OperationContext,
  input: { connectionId: string; accounts: LedgerChangeRequest[] },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<LedgerChangeView>> {
  const requests = input.accounts
  if (requests.length === 0) return invalid('none_given')
  if (requests.length > MAX_ACCOUNTS) return invalid('too_many')
  if (requests.some((r) => !isCashLedger(r.ledger_account))) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'ledger_account', reason: 'not_a_bank_account' } }
  }
  if (new Set(requests.map((r) => r.uid)).size !== requests.length) return invalid('duplicate_account')
  if (new Set(requests.map((r) => r.ledger_account)).size !== requests.length) {
    return { ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' }
  }

  let snapshot
  try {
    snapshot = await readBankConfiguration(ctx.supabase, ctx.companyId, input.connectionId)
  } catch (error) {
    return saveFailure(error)
  }
  const connection = snapshot.connection
  // A connection waiting for its first account choice is configured in its
  // picker, and an ended one has nothing to change until it is renewed.
  if (connection.status !== 'active') return { ok: false, code: 'BANK_LEDGER_CHANGE_NOT_ACTIVE' }

  const stored = storedAccounts(connection.accounts_data)
  const byUid = new Map(stored.map((a) => [a.uid, a]))
  for (const request of requests) {
    const account = byUid.get(request.uid)
    if (!account) return invalid('unknown_account', { uid: request.uid })
    // Switching an account on is the account choice, made in the picker.
    if (account.enabled === false) return invalid('not_synced', { uid: request.uid })
  }

  const { data: cashData, error: cashError } = await ctx.supabase
    .from('cash_accounts')
    .select('id, ledger_account, bank_connection_id, external_uid, iban, currency')
    .eq('company_id', ctx.companyId)
  if (cashError) return saveFailure(cashError)
  const cashRows = (cashData ?? []) as CashRow[]
  const ownRow = (uid: string) => cashRows.find((r) => r.bank_connection_id === connection.id && r.external_uid === uid) ?? null
  const currentLedger = (account: StoredAccount) => ownRow(account.uid)?.ledger_account ?? account.ledger_account ?? null

  // Where every synced account ends up: the asked ones on their new ledger
  // accounts, a sibling sitting on one of those on the mover's old one.
  const finalLedger = new Map<string, string>()
  const swapped = new Set<string>()
  for (const request of requests) finalLedger.set(request.uid, request.ledger_account)
  const asked = new Map(requests.map((r) => [r.ledger_account, r.uid]))
  for (const account of stored) {
    if (account.enabled === false || finalLedger.has(account.uid)) continue
    const ledger = currentLedger(account)
    if (!ledger) continue
    const mover = asked.get(ledger)
    if (!mover) {
      finalLedger.set(account.uid, ledger)
      continue
    }
    const freed = currentLedger(byUid.get(mover)!)
    if (!freed || asked.has(freed)) return { ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' }
    finalLedger.set(account.uid, freed)
    swapped.add(account.uid)
  }
  const synced = [...finalLedger.values()]
  if (new Set(synced).size !== synced.length) return { ok: false, code: 'BANK_SELECTION_LEDGER_CONFLICT' }

  const changed = stored.filter((a) => finalLedger.has(a.uid) && finalLedger.get(a.uid) !== currentLedger(a))
  let moves: LedgerChangeMove[]
  try {
    moves = await Promise.all(
      changed.map(async (account): Promise<LedgerChangeMove> => {
        const row = ownRow(account.uid)
        const counts = await rowCounts(ctx, row?.id ?? null)
        return {
          uid: account.uid,
          name: account.name?.trim() || null,
          iban_last4: ibanLast4(account.iban) ?? null,
          currency: (account.currency ?? row?.currency ?? 'SEK').toUpperCase(),
          cash_account_id: row?.id ?? null,
          from_ledger: currentLedger(account),
          to_ledger: finalLedger.get(account.uid)!,
          booked_rows: counts.booked,
          unbooked_rows: counts.unbooked,
          swapped: swapped.has(account.uid),
        }
      }),
    )
  } catch (error) {
    return saveFailure(error)
  }
  const view: LedgerChangeView = { connection_id: connection.id, moves }
  if (options.dryRun) return { ok: true, dryRun: true, preview: { ...view } }
  if (moves.length === 0) return { ok: true, data: view }

  // The rows this move will put on one account that no import compared,
  // planned while the accounts are still apart (lib/cash-accounts/move-twins.ts).
  const twinPlans = await planMoveTwins(ctx, connection.id, moves, cashRows)

  const selections: BankAccountSelection[] = stored.map((account) => {
    const currency = (account.currency ?? 'SEK').toUpperCase()
    const ledger = finalLedger.get(account.uid)
    if (ledger) {
      // The row of the same physical account already on that ledger account
      // is kept (the picker's rule); a row of this connection that moves is
      // re-ledgered in place by the save.
      const physical = physicalAccountKey({ iban: account.iban, currency })
      const reuse = physical
        ? cashRows.find((r) => physicalAccountKey(r) === physical && r.ledger_account === ledger)?.id ?? null
        : null
      return { uid: account.uid, enabled: true, currency, ledger_account: ledger, reuse_cash_account_id: reuse }
    }
    // Not synced: it keeps its ledger account until a synced account takes it.
    const kept = account.ledger_account && !synced.includes(account.ledger_account) ? account.ledger_account : null
    return { uid: account.uid, enabled: false, currency, ...(kept ? { ledger_account: kept } : {}), reuse_cash_account_id: null }
  })

  let saved
  try {
    saved = await saveBankAccountSelection(ctx.supabase, ctx.companyId, ctx.userId, connection.id, snapshot.token, selections)
  } catch (error) {
    return saveFailure(error)
  }
  try {
    await eventBus.emit({
      type: 'bank_connection.account_selection_changed',
      payload: {
        connectionId: connection.id,
        bankName: connection.bank_name,
        previousStatus: connection.status,
        newStatus: saved.status,
        enabledCount: synced.length,
        totalCount: stored.length,
        userId: ctx.userId,
        companyId: ctx.companyId,
        ledgerChanges: moves.map((m) => ({ cashAccountId: m.cash_account_id, uid: m.uid, from: m.from_ledger, to: m.to_ledger })),
      },
    })
  } catch (emitError) {
    ctx.log.error('bank ledger change event not emitted', {
      connectionId: connection.id,
      message: emitError instanceof Error ? emitError.message : String(emitError),
    })
  }
  ctx.log.info('bank account ledger changed', { connectionId: connection.id, moves: moves.length })
  await applyMoveTwins(ctx, connection.id, twinPlans)
  return { ok: true, data: view }
}

/**
 * Per move: the moving account against the accounts already on the ledger
 * account it moves to that the save can merge into it, i.e. not this
 * connection's (those trade places) and with no bank identity (an account of
 * statement files; one with the same IBAN was compared by every import, one
 * with another IBAN is another bank account). Never fails the move: a plan
 * that cannot be read is skipped and the rows stay as they are.
 */
async function planMoveTwins(
  ctx: OperationContext,
  connectionId: string,
  moves: LedgerChangeMove[],
  cashRows: CashRow[],
): Promise<LedgerMoveTwinsPlan[]> {
  const plans: LedgerMoveTwinsPlan[] = []
  for (const move of moves) {
    if (!move.cash_account_id) continue
    const targets = cashRows
      .filter((r) => r.ledger_account === move.to_ledger && r.id !== move.cash_account_id)
      .filter((r) => r.bank_connection_id !== connectionId && physicalAccountKey(r) === null)
      .map((r) => r.id)
    if (targets.length === 0) continue
    try {
      plans.push(await LEDGER_MOVE_TWINS.prepare(ctx.supabase, ctx.companyId, move.cash_account_id, targets))
    } catch (error) {
      ctx.log.warn('channel twins not planned for a ledger move', {
        connectionId,
        cashAccountId: move.cash_account_id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return plans
}

/** After the save: the planned copies now on one account are set aside. Never fails the move, which is done. */
async function applyMoveTwins(ctx: OperationContext, connectionId: string, plans: LedgerMoveTwinsPlan[]): Promise<void> {
  for (const plan of plans) {
    if (plan.setAside.length === 0 && plan.overBookedBuckets === 0) continue
    try {
      const setAside = plan.setAside.length > 0
        ? await LEDGER_MOVE_TWINS.apply(ctx.supabase, ctx.companyId, plan, { actorUserId: ctx.userId, correlationId: connectionId })
        : 0
      ctx.log.info('channel twins after a ledger move', {
        connectionId,
        planned: plan.setAside.length,
        setAside,
        overBookedBuckets: plan.overBookedBuckets,
      })
    } catch (error) {
      ctx.log.error('channel twins not set aside after a ledger move', {
        connectionId,
        planned: plan.setAside.length,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export interface CashAccountLedgerRequest {
  cash_account_id: string
  ledger_account: string
}

const LEDGER_ADMIN_MESSAGE = 'Bara företagets ägare eller en administratör kan byta bokföringskonto på ett bankkonto.'

/**
 * The same change, named by the cash accounts an agent lists
 * (gnubok_list_cash_accounts) instead of the connection's account uids: the
 * door of operation cash-accounts.change-ledgers (crm#1663). Every named
 * account must be synced by one bank connection; the rest is
 * changeBankAccountLedgers. Owner/admin only, on a dry run too, so a stage is
 * refused up front and the approval checks the approving user.
 */
export async function changeCashAccountLedgers(
  ctx: OperationContext,
  input: { accounts: CashAccountLedgerRequest[] },
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<LedgerChangeView>> {
  const denied = await requireCompanyAdmin(ctx, LEDGER_ADMIN_MESSAGE)
  if (denied) return denied
  const requests = input.accounts
  if (requests.length === 0) return invalid('none_given')
  if (requests.length > MAX_ACCOUNTS) return invalid('too_many')
  const ids = [...new Set(requests.map((r) => r.cash_account_id))]
  if (ids.length !== requests.length) return invalid('duplicate_account')

  const { data, error } = await ctx.supabase
    .from('cash_accounts')
    .select('id, bank_connection_id, external_uid')
    .eq('company_id', ctx.companyId)
    .in('id', ids)
  if (error) return saveFailure(error)
  const rows = new Map(
    ((data ?? []) as Array<{ id: string; bank_connection_id: string | null; external_uid: string | null }>).map((r) => [r.id, r]),
  )
  const missing = ids.find((id) => !rows.has(id))
  if (missing) return { ok: false, code: 'CASH_ACCOUNT_NOT_FOUND', details: { cash_account_id: missing } }
  // An account no bank connection syncs has no bank feed to follow it: its
  // ledger account is not this door's to change.
  const unsynced = ids.find((id) => !rows.get(id)!.bank_connection_id || !rows.get(id)!.external_uid)
  if (unsynced) return invalid('not_bank_connected', { cash_account_id: unsynced })
  const connections = new Set(ids.map((id) => rows.get(id)!.bank_connection_id!))
  if (connections.size > 1) return invalid('several_connections')

  return changeBankAccountLedgers(
    ctx,
    {
      connectionId: [...connections][0],
      accounts: requests.map((r) => ({ uid: rows.get(r.cash_account_id)!.external_uid!, ledger_account: r.ledger_account })),
    },
    options,
  )
}
