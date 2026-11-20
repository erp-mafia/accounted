import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { dbError } from '@/lib/errors/db-error'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { fetchUnlinkedGLLines, openAmountByEntry } from './bank-reconciliation'
import {
  fetchLiveLedgerSettlements,
  insertLedgerSettlement,
  stampLedgerSettlementUndone,
} from './ledger-settlement-store'
import { parseAccountKey } from './schemas'

const log = createLogger('reconciliation/ledger-settlement')

/**
 * Settle verifikat on one bank account against each other, and undo it.
 *
 * "I bokföringen, saknas på banken" lists what the ledger claims about the
 * account that the bank does not show. A wrong verifikat and the verifikat
 * that takes it back claim nothing together. A rättelse made through
 * reverseEntry says so itself (it is a storno); one booked by hand, or
 * imported from another system, does not, so both stayed in the list for
 * good and the only way out was to mislabel one of them (crm#1074).
 *
 * The policy is one sentence: what you can settle is what the list shows, at
 * the amount it shows. Every verifikat must be in the account's ledger-only
 * list right now (posted, the company's own, a line on this account, no bank
 * row, not an opening balance or a storno), be in no other live settlement,
 * and the open amounts must sum to exactly zero. A verifikat that 1:N slices
 * settle in part takes part with what it has left, because that remainder is
 * what the list and the bridge count for it.
 *
 * Nothing is booked and no verifikat is touched, so period locks and a
 * signed-off reconciliation do not stop it, exactly as for a link between a
 * bank row and a verifikat. A sign-off cannot be made untrue by it either: a
 * settlement never moves unexplained_difference (bank-reconciliation.ts).
 *
 * Reads cash_accounts, journal_entries and the candidate RPC only: whichever
 * provider feeds the bank rows, the ledger side is the same.
 *
 * Same function for the dashboard route, the v1 API and the MCP executor.
 */

export type LedgerSettlementRefusal =
  | 'UNSUPPORTED_PAIR_SHAPE'
  | 'NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'ENTRY_REVERSED'
  | 'ENTRY_NOT_OPEN'
  | 'ALREADY_SETTLED'
  | 'PAIR_NOT_CLOSED'
  | 'LINK_RACE'

export interface SettledEntry {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  /** What the verifikat leaves open on the account, debit positive. */
  amount: number
}

export interface LedgerSettlement {
  /** Null on a dry run: nothing was written. */
  settlement_id: string | null
  account_number: string
  entries: SettledEntry[]
}

export type SettleLedgerResult =
  | { ok: true; settlement: LedgerSettlement }
  | { ok: false; code: LedgerSettlementRefusal; message: string }

const MAX_ENTRIES = 50

function refuse(code: LedgerSettlementRefusal, message: string): SettleLedgerResult {
  return { ok: false, code, message }
}

/** The SEK bank ledger account behind an account key, or why it cannot be settled on. */
async function settlementAccount(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
): Promise<{ ok: true; ledgerAccount: string } | { ok: false; code: LedgerSettlementRefusal; message: string }> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind !== 'bank') {
    return {
      ok: false,
      code: 'UNSUPPORTED_PAIR_SHAPE',
      message: 'Verifikat kan bara kopplas mot varandra på ett bankkonto. Ett par på det här kontot behöver minst en händelse.',
    }
  }
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account, currency')
    .eq('company_id', companyId)
    .eq('id', parsed.cashAccountId)
    .maybeSingle<{ ledger_account: string; currency: string | null }>()
  if (error) throw dbError(error, 'Kunde inte läsa bankkontot')
  if (!data) return { ok: false, code: 'NOT_FOUND', message: 'Bankkontot finns inte i företaget.' }
  if ((data.currency ?? 'SEK') !== 'SEK') {
    // The candidate list carries SEK amounts only, so "nets to zero" cannot
    // be judged in the account's own currency yet.
    return {
      ok: false,
      code: 'UNSUPPORTED_PAIR_SHAPE',
      message: 'Verifikat kan ännu bara kopplas mot varandra på bankkonton i SEK.',
    }
  }
  return { ok: true, ledgerAccount: data.ledger_account }
}

export async function settleLedgerEntries(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  journalEntryIds: string[],
  options: { dryRun?: boolean } = {},
): Promise<SettleLedgerResult> {
  const ids = [...new Set(journalEntryIds)]
  if (ids.length < 2) {
    return refuse('UNSUPPORTED_PAIR_SHAPE', 'Det behövs minst två olika verifikat för att koppla dem mot varandra.')
  }
  if (ids.length > MAX_ENTRIES) {
    return refuse('UNSUPPORTED_PAIR_SHAPE', `Högst ${MAX_ENTRIES} verifikat kan kopplas mot varandra åt gången.`)
  }
  const account = await settlementAccount(supabase, companyId, accountKey)
  if (!account.ok) return account
  const ledgerAccount = account.ledgerAccount

  const { data: entryRows, error: entryError } = await supabase
    .from('journal_entries')
    .select('id, status, entry_date, voucher_series, voucher_number')
    .eq('company_id', companyId)
    .in('id', ids)
  if (entryError) throw dbError(entryError, 'Kunde inte läsa verifikaten')
  const entries = new Map(
    ((entryRows ?? []) as Array<{
      id: string
      status: string
      entry_date: string
      voucher_series: string | null
      voucher_number: number | null
    }>).map((e) => [e.id, e]),
  )
  for (const id of ids) {
    const entry = entries.get(id)
    if (!entry) return refuse('ENTRY_NOT_FOUND', `Verifikationen ${id} finns inte i företaget. Kontrollera id:t.`)
    if (entry.status === 'reversed') {
      return refuse('ENTRY_REVERSED', `Verifikat ${formatVoucher(entry)} (${id}) är makulerat: makuleringen tar redan ut det.`)
    }
    if (entry.status !== 'posted') return refuse('ENTRY_NOT_FOUND', `Verifikationen ${id} är inte bokförd.`)
  }
  const label = (id: string) => formatVoucher(entries.get(id)!)

  const live = await fetchLiveLedgerSettlements(supabase, companyId, ledgerAccount)
  const taken = live.find((m) => ids.includes(m.journal_entry_id))
  if (taken) {
    return refuse(
      'ALREADY_SETTLED',
      `Verifikat ${label(taken.journal_entry_id)} är redan kopplat mot ett annat verifikat på konto ${ledgerAccount}. Koppla bort det först (${taken.settlement_id}).`,
    )
  }

  // The same list the page shows, over the dates the verifikat span: being in
  // it IS the definition of ledger-only, so there is no second definition here.
  const dates = ids.map((id) => entries.get(id)!.entry_date).sort()
  const open = openAmountByEntry(
    await fetchUnlinkedGLLines(supabase, companyId, ledgerAccount, dates[0], dates[dates.length - 1]),
    'SEK',
  )
  let sum = 0
  const settled: SettledEntry[] = []
  for (const id of ids) {
    const amount = open.get(id)
    if (amount === undefined || amount === null) {
      return refuse(
        'ENTRY_NOT_OPEN',
        `Verifikat ${label(id)} står inte bland verifikaten utan bankrad på konto ${ledgerAccount}: det är redan kopplat till en bankrad, saknar rad på kontot, eller är en ingående balans eller en makulering.`,
      )
    }
    sum += amount
    const entry = entries.get(id)!
    settled.push({
      journal_entry_id: id,
      voucher_series: entry.voucher_series,
      voucher_number: entry.voucher_number,
      entry_date: entry.entry_date,
      amount,
    })
  }
  const net = roundOre(sum)
  if (Math.abs(net) >= ORE_TOLERANCE) {
    return refuse(
      'PAIR_NOT_CLOSED',
      `Verifikaten tar inte ut varandra på konto ${ledgerAccount}: tillsammans lämnar de ${formatCurrency(net)}. Bara verifikat som summerar till exakt 0 kan kopplas mot varandra.`,
    )
  }

  if (options.dryRun) {
    return { ok: true, settlement: { settlement_id: null, account_number: ledgerAccount, entries: settled } }
  }

  const settlementId = randomUUID()
  const written = await insertLedgerSettlement(supabase, companyId, {
    settlement_id: settlementId,
    account_number: ledgerAccount,
    settled_by: userId,
    entries: settled.map((e) => ({ journal_entry_id: e.journal_entry_id, amount: e.amount })),
  })
  if (!written.ok) {
    if (written.duplicate) {
      return refuse('LINK_RACE', 'Ett av verifikaten kopplades precis av någon annan. Ladda om och försök igen.')
    }
    throw new Error(`Kunde inte koppla verifikaten: ${written.message}`)
  }
  log.info('ledger entries settled', { companyId, accountKey, settlementId, entries: settled.length })
  return { ok: true, settlement: { settlement_id: settlementId, account_number: ledgerAccount, entries: settled } }
}

/**
 * Undo a settlement: its verifikat return to the ledger-only list. Returns
 * null when the id is no live settlement on this account, so a caller can
 * fall through to whatever else the id might be.
 */
export async function undoLedgerSettlement(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  accountKey: string,
  settlementId: string,
): Promise<{ settlement_id: string; journal_entry_ids: string[] } | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind !== 'bank') return null
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('ledger_account')
    .eq('company_id', companyId)
    .eq('id', parsed.cashAccountId)
    .maybeSingle<{ ledger_account: string }>()
  if (error) throw dbError(error, 'Kunde inte läsa bankkontot')
  if (!data) return null
  const journalEntryIds = await stampLedgerSettlementUndone(supabase, companyId, data.ledger_account, settlementId, userId)
  if (journalEntryIds.length === 0) return null
  log.info('ledger settlement undone', { companyId, accountKey, settlementId, entries: journalEntryIds.length })
  return { settlement_id: settlementId, journal_entry_ids: journalEntryIds }
}
