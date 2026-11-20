/**
 * Actuals replace forecasts (accounted#136): when bank rows arrive, an open
 * forecast row one of them pays is marked realised and points at it.
 *
 * Why it matters: the projection starts from the bank balance. A payment
 * that lands before its row's date is in that balance already, and the open
 * row would count it a second time until its date passed. Rows dated before
 * today leave the projection anyway; realising them also tells the API and
 * the page that the money came.
 *
 * Modelled on Arkiv's observe (lib/arkiv/agreements/observe.ts) and decided
 * by its rule, findMatch, so "is this bank row that expected payment" has one
 * answer in the product: the same amount to the öre, in SEK, within
 * DATE_TOLERANCE_DAYS of the expected date, the sign the row's direction asks
 * for. A name in the bank text that the row's note or outside system carries
 * proves it; one amount hit with no name is taken when it is the only one;
 * two hits are nobody's. Rows are tried earliest first, and a bank row that
 * realised one row is never used for another.
 *
 * Only observes: nothing is booked, linked or attached, and no journal table
 * is read or written. A row linked to an invoice is left alone: the invoice
 * counts in its place and its own match settles it. Idempotent: the update is
 * compare-and-set on open, so running the same arrival twice changes nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { counterpartyKeys, DATE_TOLERANCE_DAYS, findMatch } from '@/lib/arkiv/agreements/observe'
import { addDaysIso } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/** A bank row as the transaction.synced event carries it. */
export interface ArrivedBankRow {
  id: string
  date: string
  amount: number | string
  currency: string | null
  description: string | null
  original_description?: string | null
  merchant_name?: string | null
  is_ignored?: boolean | null
}

/** An open forecast row the arrival could realise. */
export interface RealisableForecastRow {
  id: string
  expected_date: string
  amount: number | string
  direction: 'in' | 'out'
  currency: string
  note: string | null
  external_source: string | null
}

export interface Realisation {
  cashForecastRowId: string
  transactionId: string
  /** proven: a name in the bank text; guessed: the only amount hit. */
  basis: 'proven' | 'guessed'
}

export interface RealiseSummary {
  checked: number
  realised: number
}

/** Ids per `.in()` filter: the list travels in the URL. */
const IN_CHUNK = 100

/**
 * Which bank row realises which forecast row. Pure: the rows and bank rows
 * in, the pairs out. `used` holds bank rows that already realised a row.
 */
export function pickRealisations(
  rows: readonly RealisableForecastRow[],
  bankRows: readonly ArrivedBankRow[],
  used: ReadonlySet<string> = new Set(),
): Realisation[] {
  const taken = new Set(used)
  const live = bankRows.filter((t) => !t.is_ignored)
  const ordered = [...rows].sort((a, b) => a.expected_date.localeCompare(b.expected_date) || a.id.localeCompare(b.id))
  const out: Realisation[] = []
  for (const row of ordered) {
    const candidates = live
      .filter((t) => !taken.has(t.id) && (row.direction === 'in' ? Number(t.amount) > 0 : Number(t.amount) < 0))
      .map((t) => ({
        id: t.id,
        date: t.date,
        amount: Number(t.amount),
        currency: t.currency,
        description: t.description,
        original_description: t.original_description ?? null,
        merchant_name: t.merchant_name ?? null,
      }))
    const keys = new Set([...counterpartyKeys(undefined, row.note), ...counterpartyKeys(undefined, row.external_source)])
    const match = findMatch({ due_on: row.expected_date, amount: Number(row.amount), currency: row.currency }, candidates, keys)
    if (!match) continue
    taken.add(match.transaction.id)
    out.push({ cashForecastRowId: row.id, transactionId: match.transaction.id, basis: match.basis })
  }
  return out
}

/**
 * Realise the company's open forecast rows that the arrived bank rows pay.
 * Reads the open, unlinked rows dated within the tolerance of the arrivals and
 * the arrivals that already realised a row; writes status and the bank row.
 * Throws on a failed read or write, so an outbox delivery is retried.
 */
export async function realiseForecastRows(
  supabase: SupabaseClient,
  companyId: string,
  arrived: readonly ArrivedBankRow[],
): Promise<RealiseSummary> {
  const bankRows = arrived.filter((t) => !t.is_ignored && typeof t.date === 'string' && Number(t.amount) !== 0)
  if (bankRows.length === 0) return { checked: 0, realised: 0 }
  const dates = bankRows.map((t) => t.date).sort()
  const from = addDaysIso(dates[0]!, -DATE_TOLERANCE_DAYS)
  const to = addDaysIso(dates[dates.length - 1]!, DATE_TOLERANCE_DAYS)

  const rows = await fetchAllRows<RealisableForecastRow>(({ from: start, to: end }) =>
    supabase
      .from('cash_forecast_rows')
      .select('id, expected_date, amount, direction, currency, note, external_source')
      .eq('company_id', companyId)
      .eq('status', 'open')
      .is('invoice_id', null)
      .is('supplier_invoice_id', null)
      .gte('expected_date', from)
      .lte('expected_date', to)
      .order('expected_date', { ascending: true })
      .order('id', { ascending: true })
      .range(start, end),
  )
  if (rows.length === 0) return { checked: 0, realised: 0 }

  // A bank row arriving again (a re-sync, a retried delivery) is not used twice.
  const used = new Set<string>()
  const ids = bankRows.map((t) => t.id)
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await supabase
      .from('cash_forecast_rows')
      .select('matched_transaction_id')
      .eq('company_id', companyId)
      .in('matched_transaction_id', ids.slice(i, i + IN_CHUNK))
    if (error) throw new Error(`forecast rows read failed: ${error.message}`)
    for (const r of (data ?? []) as Array<{ matched_transaction_id: string | null }>) {
      if (r.matched_transaction_id) used.add(r.matched_transaction_id)
    }
  }

  let realised = 0
  for (const pick of pickRealisations(rows, bankRows, used)) {
    const { data, error } = await supabase
      .from('cash_forecast_rows')
      .update({ status: 'realised', matched_transaction_id: pick.transactionId })
      .eq('company_id', companyId)
      .eq('id', pick.cashForecastRowId)
      .eq('status', 'open')
      .select('id')
    if (error) throw new Error(`forecast row update failed: ${error.message}`)
    if ((data ?? []).length > 0) realised += 1
  }
  return { checked: rows.length, realised }
}
