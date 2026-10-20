/**
 * How much of a verifikat's bank leg is still free for one more bank row.
 *
 * A bank row linked to a verifikat says "this verifikat books me". Several
 * rows may share one verifikat (N:1: a salary run paid in several transfers,
 * a supplier invoice paid in instalments), but only as far as the verifikat
 * books money on the bank account: two separate payments of 2 800 kr cannot
 * both be the 2 800 kr one verifikat books. Before this module the doors that
 * name a pair (manualLink, linkTransactionToJournalEntry) linked a second row
 * to a verifikat a first row already settled in full, and showed it as
 * booked: the second sale and its moms were never booked, and the only trace
 * was an unexplained reconciliation difference (GitHub #3507).
 *
 * Who holds a verifikat: every other row whose pointer
 * (transactions.journal_entry_id) names it, at its whole amount, and every
 * bank_line slice (transaction_voucher_links: a 1:N split, a bulk-booked
 * samlingsverifikat) of another row, at its allocated amount. A row anchored
 * both ways counts once, at its whole amount. Residual and clearing anchors
 * (other roles) are not the booking of a bank line and do not count.
 *
 * The room is counted per direction: a deposit can only take what the
 * verifikat debits on the account, a payout only what it credits. On the
 * usual verifikat with one bank line that is the same as its net; a
 * verifikat that moves the account both ways (a day booked as one
 * verifikat) can then take its rows in any order, which a net figure would
 * refuse for whichever row came first. A verifikat that books nothing in
 * the row's direction is not this module's refusal: the bank-anchor guard
 * refuses that link at the write, with its own code.
 *
 * Every door that links a row to a posted verifikat measures here, so they
 * agree on what is free: the bank link core (prepareBankLink), the 1:N split
 * (linkTransactionToVouchers), the confirmed suggestion and the auto-link
 * after an invoice is linked to its voucher (lib/reconciliation), the
 * account-keyed dry run (matchPairs) and the bulk link to an existing
 * verifikat (bulkBookTransactions).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { ledgerLineAmountIn, type LedgerLineAmount } from '@/lib/bookkeeping/ledger-line-amount'
import { roundOre } from '@/lib/money'
import { ID_READ_CHUNK } from '@/lib/reconciliation/limits'
import { chunk } from '@/lib/utils'

/**
 * One öre, the widest slack a link is ever proposed under (the matcher's
 * auto_fuzzy band, and the confirm-suggestion check), plus float headroom.
 * A tighter figure would refuse a fuzzy match the matcher offers on purpose;
 * every real over-link is a whole bank row.
 */
export const BANK_LEG_ROOM_TOLERANCE = 0.011

/** Half an öre: below it an amount is zero. */
const ZERO = 0.005

/** A row that already holds part of a verifikat's bank leg. */
export interface BankLegHolder {
  transactionId: string
  /** Signed (+ money in, - money out), in `currency`: the whole row for a pointer, the slice for a bank_line row. */
  amount: number
  currency: string
  cashAccountId: string | null
}

export type BankLegHoldersRead = { ok: true; holders: Map<string, BankLegHolder[]> } | { ok: false }

type JunctionHolderRow = {
  transaction_id: string
  journal_entry_id: string
  allocated_amount: number | string | null
  transactions?:
    | { amount: number | string | null; currency: string | null; cash_account_id: string | null }
    | Array<{ amount: number | string | null; currency: string | null; cash_account_id: string | null }>
    | null
}

type PointerHolderRow = {
  id: string
  journal_entry_id: string | null
  amount: number | string | null
  currency: string | null
  cash_account_id: string | null
}

/**
 * The rows holding each verifikat, other than `excludeTransactionIds` (the
 * rows being linked now). Two reads per ID_READ_CHUNK verifikat: the
 * bank_line slices, then the pointers. `ok: false` on a read error: a caller
 * that cannot see who holds a verifikat must not link to it.
 */
export async function readBankLegHolders(
  supabase: SupabaseClient,
  companyId: string,
  journalEntryIds: string[],
  excludeTransactionIds: string[] = [],
): Promise<BankLegHoldersRead> {
  const excluded = new Set(excludeTransactionIds)
  const holders = new Map<string, BankLegHolder[]>()
  const ids = [...new Set(journalEntryIds)]
  for (const part of chunk(ids, ID_READ_CHUNK)) {
    const { data: slices, error: slicesError } = await supabase
      .from('transaction_voucher_links')
      .select('transaction_id, journal_entry_id, allocated_amount, transactions(amount, currency, cash_account_id)')
      .eq('company_id', companyId)
      .eq('role', 'bank_line')
      .in('journal_entry_id', part)
    if (slicesError) return { ok: false }
    const { data: pointers, error: pointersError } = await supabase
      .from('transactions')
      .select('id, journal_entry_id, amount, currency, cash_account_id')
      .eq('company_id', companyId)
      .in('journal_entry_id', part)
    if (pointersError) return { ok: false }

    // Pointers first: a row anchored both ways holds its whole amount once.
    const pointerKeys = new Set<string>()
    for (const row of (Array.isArray(pointers) ? pointers : []) as PointerHolderRow[]) {
      if (!row?.journal_entry_id || excluded.has(row.id)) continue
      const amount = Number(row.amount)
      if (!Number.isFinite(amount)) continue
      pointerKeys.add(`${row.id}:${row.journal_entry_id}`)
      push(holders, row.journal_entry_id, {
        transactionId: row.id,
        amount: roundOre(amount),
        currency: row.currency || 'SEK',
        cashAccountId: row.cash_account_id ?? null,
      })
    }
    for (const row of (Array.isArray(slices) ? slices : []) as JunctionHolderRow[]) {
      if (!row?.journal_entry_id || excluded.has(row.transaction_id)) continue
      if (pointerKeys.has(`${row.transaction_id}:${row.journal_entry_id}`)) continue
      const holder = Array.isArray(row.transactions) ? row.transactions[0] : row.transactions
      const amount = Number(row.allocated_amount)
      if (!holder || !Number.isFinite(amount)) continue
      push(holders, row.journal_entry_id, {
        transactionId: row.transaction_id,
        amount: roundOre(amount),
        currency: holder.currency || 'SEK',
        cashAccountId: holder.cash_account_id ?? null,
      })
    }
  }
  return { ok: true, holders }
}

function push(map: Map<string, BankLegHolder[]>, key: string, holder: BankLegHolder): void {
  const list = map.get(key)
  if (list) list.push(holder)
  else map.set(key, [holder])
}

/**
 * The holders that sit on the same bank account as the row being linked: the
 * same currency (a slice in another unit cannot be compared), and the same
 * cash account (UNIQUE (company_id, ledger_account): one cash account is one
 * ledger). The other leg of an own-account transfer sits on another cash
 * account and is left out. A holder with no cash account (legacy, before
 * cash accounts) counts against a bound row: the bank-anchor guard put it on
 * one of the verifikat's bank lines, and counting it can only refuse a link,
 * never let an over-link through. A row with no cash account counts only
 * holders without one too: which ledger a bound holder's cash account is on
 * is not read here.
 */
export function holdersOnAccount(
  holders: readonly BankLegHolder[],
  account: { cashAccountId: string | null; currency: string },
): BankLegHolder[] {
  return holders.filter(
    (h) =>
      h.currency === account.currency &&
      (h.cashAccountId === null || h.cashAccountId === account.cashAccountId),
  )
}

/** What a verifikat books on one bank account and what its holders already take, per direction. */
export interface BankLegRoom {
  /** What the verifikat debits on the account (money in), >= 0, in the row's currency. */
  bookedIn: number
  /** What it credits (money out), <= 0. */
  bookedOut: number
  heldIn: number
  heldOut: number
  /** false when a line carries no amount in the currency (a foreign account, a line without a rate). */
  measurable: boolean
}

/**
 * The room on the verifikat's `lines` on the account (only those lines),
 * against the `holders` already on that account, in `currency` (see
 * ledgerLineAmountIn: the ledger columns are always SEK).
 */
export function bankLegRoom(
  lines: readonly LedgerLineAmount[],
  holders: readonly BankLegHolder[],
  currency: string,
): BankLegRoom {
  let bookedIn = 0
  let bookedOut = 0
  let measurable = true
  for (const line of lines) {
    const amount = ledgerLineAmountIn(line, currency)
    if (amount === null) {
      measurable = false
      continue
    }
    if (amount > 0) bookedIn += amount
    else bookedOut += amount
  }
  let heldIn = 0
  let heldOut = 0
  for (const h of holders) {
    if (h.amount > 0) heldIn += h.amount
    else heldOut += h.amount
  }
  return {
    bookedIn: roundOre(bookedIn),
    bookedOut: roundOre(bookedOut),
    heldIn: roundOre(heldIn),
    heldOut: roundOre(heldOut),
    measurable,
  }
}

export type BankLegVerdict =
  | { fits: true }
  | {
      fits: false
      /** What the verifikat books on the account in the row's direction (null: not measurable). */
      booked: number | null
      /** What other rows already hold of it in that direction. */
      held: number
      /** What is left for this row (null: not measurable). */
      remaining: number | null
    }

/**
 * Does a row of `amount` fit in what the verifikat has left in its
 * direction? `overrun` widens the room by a signed amount explained in the
 * same act: the residual verifikat bookResidualAndLink books right after the
 * link (lib/reconciliation/residual.ts), whose rows exceed the main
 * verifikat by exactly that residual.
 *
 * Fits: a zero row; the first row in the row's direction, whatever its size
 * (as before: a lone row that differs from the verifikat, often by an
 * öresavrundning, links and the difference shows on the status card; prod
 * had five such links in the 30 days before this check, against eighteen
 * second rows on an already-held leg); a verifikat that books nothing in the
 * row's direction (the bank-anchor guard refuses that pair at the write, by
 * its own code); a row no larger than what other rows leave, within
 * BANK_LEG_ROOM_TOLERANCE. A verifikat whose amounts cannot be expressed in
 * the row's currency takes its first row and refuses the next one in the
 * same direction: its room cannot be verified, so a second row is never
 * assumed to fit.
 */
export function fitsBankLeg(room: BankLegRoom, amount: number, overrun = 0): BankLegVerdict {
  if (!Number.isFinite(amount)) return { fits: true }
  const x = roundOre(amount)
  if (Math.abs(x) < ZERO) return { fits: true }
  const incoming = x > 0
  const held = incoming ? room.heldIn : room.heldOut
  if (Math.abs(held) < ZERO) return { fits: true }
  if (!room.measurable) return { fits: false, booked: null, held, remaining: null }
  const booked = incoming ? room.bookedIn : room.bookedOut
  if (Math.abs(booked) < ZERO) return { fits: true }
  const allowance = Number.isFinite(overrun) && Math.sign(overrun) === Math.sign(x) ? overrun : 0
  const remaining = roundOre(booked - held + allowance)
  const fits = incoming ? x <= remaining + BANK_LEG_ROOM_TOLERANCE : x >= remaining - BANK_LEG_ROOM_TOLERANCE
  return fits ? { fits: true } : { fits: false, booked, held, remaining }
}

/**
 * The Swedish refusal for a row that does not fit, naming the verifikat, what
 * it books, what other rows hold and what to do instead.
 */
export function bankLegConsumedMessage(args: {
  voucherLabel: string
  accountNumber: string
  amount: number
  verdict: Extract<BankLegVerdict, { fits: false }>
}): string {
  const { voucherLabel, accountNumber, verdict } = args
  const amount = roundOre(args.amount)
  if (verdict.booked === null) {
    return `Verifikat ${voucherLabel} saknar belopp i transaktionens valuta på ${accountNumber}, och en annan transaktion är redan kopplad till det (${verdict.held}). Transaktionen på ${amount} kan inte kopplas dit också. Är den en egen affärshändelse, bokför den som ett eget verifikat. Är den andra kopplingen fel, koppla bort den transaktionen först.`
  }
  return `Verifikat ${voucherLabel} bokför ${verdict.booked} på ${accountNumber}, och ${verdict.held} av det är redan kopplat till andra transaktioner (kvar: ${verdict.remaining}). Transaktionen på ${amount} ryms inte i verifikatet. Är den en egen affärshändelse, bokför den som ett eget verifikat. Är den andra kopplingen fel, koppla bort den transaktionen först.`
}
