/**
 * The reads behind a ledger-account suggestion (crm#1066): the company's cash
 * accounts and bank connections, the evidence from the books
 * (public.cash_account_ledger_evidence), the decision
 * (lib/cash-accounts/ledger-evidence.ts), and for each suggested change the
 * names, the count of transactions already booked, and the bank picker's own
 * save request that would make it.
 *
 * Read only. Nothing here writes cash_accounts.ledger_account: the request in
 * `selection` is sent by the client to PATCH /accounts of the bank extension,
 * the same request the picker sends, so save_bank_account_selection and its
 * named refusals stay the single writer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { isSyncedAccount } from '@/lib/bank-sync/mirror-card-account'
import { physicalAccountKey } from '@/lib/cash-accounts/ledger-slots'
import { ibanLast4 } from '@/lib/cash-accounts/selection-refusal'
import {
  suggestLedgerChanges,
  type LedgerEvidenceRow,
  type LedgerMove,
  type LedgerSuggestion,
} from '@/lib/cash-accounts/ledger-evidence'
import type {
  LedgerSelectionRequest,
  LedgerSuggestionAccount,
  LedgerSuggestionView,
} from '@/lib/cash-accounts/ledger-suggestion-view'

interface CashAccountRow {
  id: string
  ledger_account: string
  bank_connection_id: string | null
  enabled: boolean | null
  external_uid: string | null
  iban: string | null
  name: string | null
  currency: string
}

interface BankConnectionRow {
  id: string
  bank_name: string | null
  status: string | null
  accounts_data: unknown
}

/** The fields of a bank_connections.accounts_data entry read here. */
interface StoredAccountEntry {
  uid: string
  iban?: string | null
  bban?: string | null
  name?: string | null
  currency?: string | null
  enabled?: boolean | null
}

export interface LedgerSuggestionsResult {
  /** False only when `connectionId` was asked for and the company has no such connection. */
  connectionFound: boolean
  suggestions: LedgerSuggestionView[]
}

function storedAccounts(connection: BankConnectionRow | undefined): StoredAccountEntry[] {
  if (!connection || !Array.isArray(connection.accounts_data)) return []
  return (connection.accounts_data as unknown[]).filter(
    (entry): entry is StoredAccountEntry =>
      typeof entry === 'object' && entry !== null && typeof (entry as { uid?: unknown }).uid === 'string',
  )
}

/**
 * The cash account's entry in its connection's account list: by uid, and by
 * IBAN and currency when a re-authorization gave the account a new uid that
 * the cash row has not caught up with (the selection save pairs them the same
 * way).
 */
function storedAccountFor(row: CashAccountRow, stored: readonly StoredAccountEntry[]): StoredAccountEntry | null {
  const byUid = row.external_uid ? stored.find((entry) => entry.uid === row.external_uid) : undefined
  if (byUid) return byUid
  const physical = physicalAccountKey(row)
  if (!physical) return null
  const byIban = stored.filter((entry) => physicalAccountKey({ iban: entry.iban, currency: entry.currency ?? row.currency }) === physical)
  return byIban.length === 1 ? byIban[0] : null
}

function accountLabel(row: CashAccountRow, connection: BankConnectionRow | undefined): string {
  const tail = ibanLast4(row.iban)
  if (tail) return `••${tail}`
  return row.name?.trim() || connection?.bank_name?.trim() || row.ledger_account
}

/**
 * The picker's save request for a suggestion whose accounts all sit in one
 * bank connection: the accounts that sync now stay switched on, and only the
 * suggested accounts get a mapping, which leaves every other account's ledger
 * account untouched (PATCH /accounts keeps an account without a mapping as it
 * is). Null when one save cannot make the change.
 */
function selectionFor(
  moves: readonly LedgerMove[],
  uidByCashAccount: ReadonlyMap<string, StoredAccountEntry | null>,
  connections: ReadonlyMap<string, BankConnectionRow>,
): LedgerSelectionRequest | null {
  const connectionIds = new Set(moves.map((move) => move.connectionId))
  if (connectionIds.size !== 1) return null
  const connection = connections.get(moves[0].connectionId)
  if (!connection) return null
  const mappings: LedgerSelectionRequest['account_mappings'] = []
  for (const move of moves) {
    const entry = uidByCashAccount.get(move.cashAccountId)
    // Not in the connection's list, or switched off there while the cash row
    // says on: the request could not describe the account truthfully.
    if (!entry || !isSyncedAccount(entry)) return null
    mappings.push({ uid: entry.uid, ledger_account: move.to })
  }
  return {
    connection_id: connection.id,
    enabled_uids: storedAccounts(connection).filter(isSyncedAccount).map((entry) => entry.uid),
    account_mappings: mappings,
  }
}

function suggestionId(suggestion: LedgerSuggestion): string {
  const moves = suggestion.moves.map((move) => `${move.cashAccountId}>${move.to}`).sort()
  return `${suggestion.kind}:${moves.join('|')}`
}

/**
 * The ledger-account suggestions for a company, or for one of its bank
 * connections when `connectionId` is given (every suggestion that involves an
 * account of that connection).
 */
export async function loadLedgerSuggestions(
  supabase: SupabaseClient,
  companyId: string,
  options: { connectionId?: string } = {},
): Promise<LedgerSuggestionsResult> {
  const { data: connectionRows, error: connectionError } = await supabase
    .from('bank_connections')
    .select('id, bank_name, status, accounts_data')
    .eq('company_id', companyId)
  if (connectionError) throw dbError(connectionError, 'Bank connections')
  const connections = new Map(((connectionRows ?? []) as BankConnectionRow[]).map((row) => [row.id, row]))
  if (options.connectionId && !connections.has(options.connectionId)) {
    return { connectionFound: false, suggestions: [] }
  }

  const { data: cashRows, error: cashError } = await supabase
    .from('cash_accounts')
    .select('id, ledger_account, bank_connection_id, enabled, external_uid, iban, name, currency')
    .eq('company_id', companyId)
  if (cashError) throw dbError(cashError, 'Cash accounts')
  const cash = (cashRows ?? []) as CashAccountRow[]
  const accounts = cash.map((row) => ({
    id: row.id,
    ledger_account: row.ledger_account,
    bank_connection_id: row.bank_connection_id,
    enabled: row.enabled,
    connection_status: row.bank_connection_id ? connections.get(row.bank_connection_id)?.status ?? null : null,
  }))
  // The evidence is only about enabled accounts a bank connection syncs onto:
  // a company without one costs no ledger read at all.
  const anyConnected = accounts.some(
    (account) => account.bank_connection_id !== null && account.enabled !== false && account.connection_status !== 'revoked',
  )
  if (!anyConnected) return { connectionFound: true, suggestions: [] }

  const { data: evidence, error: evidenceError } = await supabase.rpc('cash_account_ledger_evidence', {
    p_company_id: companyId,
  })
  if (evidenceError) throw dbError(evidenceError, 'Ledger evidence')

  const decided = suggestLedgerChanges(accounts, (evidence ?? []) as LedgerEvidenceRow[]).filter(
    (suggestion) => !options.connectionId || suggestion.moves.some((move) => move.connectionId === options.connectionId),
  )
  if (decided.length === 0) return { connectionFound: true, suggestions: [] }

  const cashById = new Map(cash.map((row) => [row.id, row]))
  const moves = decided.flatMap((suggestion) => suggestion.moves)
  const ledgers = [...new Set(moves.flatMap((move) => [move.from, move.to]))]

  const [chart, booked] = await Promise.all([
    supabase
      .from('chart_of_accounts')
      .select('account_number, account_name')
      .eq('company_id', companyId)
      .in('account_number', ledgers),
    Promise.all(
      moves.map(async (move) => {
        const { data, error } = await supabase.rpc('cash_account_booked_rows', {
          p_company_id: companyId,
          p_cash_account_id: move.cashAccountId,
        })
        if (error) throw dbError(error, 'Booked bank rows')
        return [move.cashAccountId, Number(data) || 0] as const
      }),
    ),
  ])
  if (chart.error) throw dbError(chart.error, 'Chart of accounts')
  const ledgerNames = new Map(
    ((chart.data ?? []) as Array<{ account_number: string; account_name: string | null }>).map((row) => [
      row.account_number,
      row.account_name?.trim() || null,
    ]),
  )
  const bookedRows = new Map(booked)

  const storedByCashAccount = new Map<string, StoredAccountEntry | null>()
  for (const move of moves) {
    const row = cashById.get(move.cashAccountId)
    storedByCashAccount.set(
      move.cashAccountId,
      row ? storedAccountFor(row, storedAccounts(connections.get(move.connectionId))) : null,
    )
  }

  const suggestions = decided.map((suggestion): LedgerSuggestionView => {
    const selection = selectionFor(suggestion.moves, storedByCashAccount, connections)
    const views = suggestion.moves.map((move): LedgerSuggestionAccount => {
      const row = cashById.get(move.cashAccountId)
      return {
        cash_account_id: move.cashAccountId,
        connection_id: move.connectionId,
        uid: storedByCashAccount.get(move.cashAccountId)?.uid ?? null,
        label: row ? accountLabel(row, connections.get(move.connectionId)) : move.from,
        from_ledger: move.from,
        from_ledger_name: ledgerNames.get(move.from) ?? null,
        to_ledger: move.to,
        to_ledger_name: ledgerNames.get(move.to) ?? null,
        basis: move.basis,
        hits: move.hits,
        balance_date: move.balanceDate,
        booked_rows: bookedRows.get(move.cashAccountId) ?? 0,
      }
    })
    return {
      id: suggestionId(suggestion),
      kind: suggestion.kind,
      accounts: views,
      selection,
      one_click: selection !== null && connections.get(selection.connection_id)?.status === 'active',
      two_connections: new Set(suggestion.moves.map((move) => move.connectionId)).size > 1,
    }
  })
  return { connectionFound: true, suggestions }
}
