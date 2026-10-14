import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { isUuid } from '@/lib/invariants/uuid'
import { roundOre } from '@/lib/money'
import { resolveSkattekontoAccount } from '@/lib/skatteverket/skattekonto-account'
import { chunk } from '@/lib/utils'
import type { ReconciliationPair } from './actions'
import { parseAccountKey } from './schemas'

/**
 * What a staged reconciliation_match links, in the reviewer's terms (crm#1147).
 *
 * The staged pairs are ids only (outside rows and verifikat), which is what
 * the commit executor needs and nothing an approver can check: Granskning
 * showed "Antal par: 8" and a source. This reads, once at staging, the facts
 * behind every pair (each outside row's date, text and amount; the
 * verifikat's number, date, text and what it holds on the reconciled account)
 * so the stored preview states which rows go to which verifikat and whether
 * the amounts agree.
 *
 * Display facts only. Whether a pair may be linked is decided by matchPairs
 * (the dry run before staging, and again when the operation is approved);
 * nothing here is read back by the executor.
 */

/** Pairs described in one preview; the rest are counted, not listed. */
export const PAIR_PREVIEW_MAX_PAIRS = 50
/** Outside rows listed per pair; the pair's count and sum always cover all of them. */
export const PAIR_PREVIEW_MAX_ROWS = 20

const READ_CHUNK = 100

export interface PairPreviewRow {
  /** transaction_id (bank) or skattekonto_transaction_id. */
  external_id: string
  date: string
  text: string
  /** The outside party's sign: positive is money into the account (a debit on it). */
  amount: number
  /** Bank rows in another currency than SEK. */
  currency?: string
}

export interface PairPreviewEntry {
  journal_entry_id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string
  /** The verifikat's lines on the reconciled ledger account, summed per side. */
  account_debit: number
  account_credit: number
  /** Bank 1:N split: the slice of the row this verifikat settles. */
  allocated_amount?: number
}

export interface PairPreview {
  /** The pair's outside rows, oldest first, at most PAIR_PREVIEW_MAX_ROWS. */
  rows: PairPreviewRow[]
  /** How many outside rows the pair links, also those not listed. */
  row_count: number
  /** Sum of all the pair's rows; null when they are not in one currency. */
  rows_total: number | null
  /** The rows' currency when it is not SEK. */
  rows_currency?: string
  entries: PairPreviewEntry[]
  /** Skattekonto: rows linked to the verifikat before this pair, and their sum. */
  already_linked_count?: number
  already_linked_total?: number
  /**
   * Skattekonto: what the verifikat holds on the account beyond every row
   * linked to it once this pair is linked (ledger sign), from the dry run.
   * 0 says the rows explain the verifikat's whole movement on the account.
   */
  remainder_amount?: number
}

export interface MatchPairsPreview {
  /** The ledger account the pairs are linked on: the skattekonto account (1630, or 2012 for an enskild firma that runs it there), or the bank account's BAS account. */
  ledger_account: string
  pair_details: PairPreview[]
  /** Pairs with outside rows beyond PAIR_PREVIEW_MAX_PAIRS: staged, not described. */
  pair_details_omitted: number
}

type OutsideRow = { id: string; date: string; text: string; amount: number; currency: string }
type EntryRow = {
  id: string
  voucher_series: string | null
  voucher_number: number | null
  entry_date: string
  description: string | null
  lines: Array<{ account_number: string; debit_amount: number | string; credit_amount: number | string }> | null
}

/** Sum of amounts as stored (two decimals each), back on the öre. */
function sumOre(values: Array<number | string | null | undefined>): number {
  return roundOre(values.reduce<number>((sum, value) => sum + roundOre(Number(value || 0)), 0))
}

/**
 * Describe the staged pairs that carry outside rows. A pair of verifikat
 * settled against each other has no outside row and is described by the dry
 * run's own `settled` list, so it is left out here.
 *
 * Returns null when the pairs cannot be described in full (an unknown
 * account, or a row or verifikat that could not be read): a preview that
 * lists some of a pair's rows under a sum of all of them would mislead, and
 * the caller then stages without details. Throws on a failed read.
 */
export async function describeMatchPairs(
  supabase: SupabaseClient,
  companyId: string,
  accountKey: string,
  pairs: ReconciliationPair[],
  options: {
    /** Per verifikat, what the dry run says it keeps on the account after its pair (0 when nothing). */
    remainders?: ReadonlyMap<string, number>
  } = {},
): Promise<MatchPairsPreview | null> {
  const parsed = parseAccountKey(accountKey)
  if (!parsed || parsed.kind === 'manual') return null

  const withRows = pairs.filter((pair) => pair.external_ids.length > 0 && pair.journal_entry_ids.length > 0)
  const described = withRows.slice(0, PAIR_PREVIEW_MAX_PAIRS)
  if (described.length === 0) return null

  let ledgerAccount: string
  if (parsed.kind === 'skattekonto') {
    ledgerAccount = await resolveSkattekontoAccount(supabase, companyId)
  } else {
    const { data: account, error } = await supabase
      .from('cash_accounts')
      .select('ledger_account')
      .eq('company_id', companyId)
      .eq('id', parsed.cashAccountId)
      .maybeSingle<{ ledger_account: string | null }>()
    if (error) throw dbError(error, 'Kunde inte läsa bankkontot')
    if (!account?.ledger_account) return null
    ledgerAccount = account.ledger_account
  }

  const rowIds = [...new Set(described.flatMap((pair) => pair.external_ids))]
  const entryIds = [...new Set(described.flatMap((pair) => pair.journal_entry_ids))]
  // A malformed id would fail the whole read (22P02); the dry run has already
  // refused such a pair, so reaching here with one means nothing to describe.
  if (![...rowIds, ...entryIds].every(isUuid)) return null

  const rows = new Map<string, OutsideRow>()
  for (const part of chunk(rowIds, READ_CHUNK)) {
    if (parsed.kind === 'bank') {
      const { data, error } = await supabase
        .from('transactions')
        .select('id, date, description, merchant_name, amount, currency')
        .eq('company_id', companyId)
        .in('id', part)
      if (error) throw dbError(error, 'Kunde inte läsa raderna')
      for (const r of (data ?? []) as Array<{
        id: string
        date: string
        description: string | null
        merchant_name: string | null
        amount: number | string
        currency: string | null
      }>) {
        rows.set(r.id, {
          id: r.id,
          date: r.date,
          text: r.description || r.merchant_name || '',
          amount: roundOre(Number(r.amount)),
          currency: r.currency || 'SEK',
        })
      }
    } else {
      const { data, error } = await supabase
        .from('skattekonto_transactions')
        .select('id, transaktionsdatum, transaktionstext, belopp_skatteverket')
        .eq('company_id', companyId)
        .in('id', part)
      if (error) throw dbError(error, 'Kunde inte läsa raderna')
      for (const r of (data ?? []) as Array<{
        id: string
        transaktionsdatum: string
        transaktionstext: string | null
        belopp_skatteverket: number | string
      }>) {
        rows.set(r.id, {
          id: r.id,
          date: r.transaktionsdatum,
          text: r.transaktionstext ?? '',
          amount: roundOre(Number(r.belopp_skatteverket)),
          currency: 'SEK',
        })
      }
    }
  }

  const entries = new Map<string, EntryRow>()
  // Skattekonto: the amounts of the rows already linked to each verifikat.
  const alreadyLinked = new Map<string, number[]>()
  for (const part of chunk(entryIds, READ_CHUNK)) {
    const { data, error } = await supabase
      .from('journal_entries')
      .select(
        'id, voucher_series, voucher_number, entry_date, description, lines:journal_entry_lines ( account_number, debit_amount, credit_amount )',
      )
      .eq('company_id', companyId)
      .in('id', part)
    if (error) throw dbError(error, 'Kunde inte läsa verifikaten')
    for (const e of (data ?? []) as EntryRow[]) entries.set(e.id, e)

    if (parsed.kind !== 'skattekonto') continue
    const { data: linked, error: linkedError } = await supabase
      .from('skattekonto_transactions')
      .select('id, journal_entry_id, belopp_skatteverket')
      .eq('company_id', companyId)
      .in('journal_entry_id', part)
    if (linkedError) throw dbError(linkedError, 'Kunde inte läsa kopplade rader')
    for (const r of (linked ?? []) as Array<{
      id: string
      journal_entry_id: string | null
      belopp_skatteverket: number | string | null
    }>) {
      // A row of the staged pairs is not "already" linked, whatever it says.
      if (!r.journal_entry_id || rows.has(r.id)) continue
      alreadyLinked.set(r.journal_entry_id, [
        ...(alreadyLinked.get(r.journal_entry_id) ?? []),
        Number(r.belopp_skatteverket),
      ])
    }
  }

  const details: PairPreview[] = []
  for (const pair of described) {
    const pairRows = [...new Set(pair.external_ids)].map((id) => rows.get(id))
    const pairEntries = [...new Set(pair.journal_entry_ids)].map((id) => entries.get(id))
    if (pairRows.some((r) => !r) || pairEntries.some((e) => !e)) return null
    const outside = (pairRows as OutsideRow[]).sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    )
    const currencies = new Set(outside.map((r) => r.currency))
    const currency = currencies.size === 1 ? outside[0].currency : null

    const [onlyEntryId] = pair.journal_entry_ids
    const linked = pairEntries.length === 1 ? alreadyLinked.get(onlyEntryId) : undefined
    const remainder =
      parsed.kind === 'skattekonto' && pairEntries.length === 1 ? options.remainders?.get(onlyEntryId) : undefined

    details.push({
      rows: outside.slice(0, PAIR_PREVIEW_MAX_ROWS).map((r) => ({
        external_id: r.id,
        date: r.date,
        text: r.text,
        amount: r.amount,
        ...(r.currency !== 'SEK' ? { currency: r.currency } : {}),
      })),
      row_count: outside.length,
      rows_total: currency ? sumOre(outside.map((r) => r.amount)) : null,
      ...(currency && currency !== 'SEK' ? { rows_currency: currency } : {}),
      entries: (pairEntries as EntryRow[]).map((e) => {
        const onAccount = (e.lines ?? []).filter((l) => l.account_number === ledgerAccount)
        const allocated = pair.allocations?.find((a) => a.journal_entry_id === e.id)?.amount
        return {
          journal_entry_id: e.id,
          voucher_series: e.voucher_series,
          voucher_number: e.voucher_number,
          entry_date: e.entry_date,
          description: e.description ?? '',
          account_debit: sumOre(onAccount.map((l) => l.debit_amount)),
          account_credit: sumOre(onAccount.map((l) => l.credit_amount)),
          ...(typeof allocated === 'number' ? { allocated_amount: allocated } : {}),
        }
      }),
      ...(linked ? { already_linked_count: linked.length, already_linked_total: sumOre(linked) } : {}),
      ...(typeof remainder === 'number' && Number.isFinite(remainder) ? { remainder_amount: remainder } : {}),
    })
  }

  return {
    ledger_account: ledgerAccount,
    pair_details: details,
    pair_details_omitted: withRows.length - described.length,
  }
}
