import type { SupabaseClient } from '@supabase/supabase-js'
import type { PosReceipt, PosTender } from '@accounted/connect-contract'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { stripBankNoise } from '@/lib/bookkeeping/booking-templates'
import { accountProposal, clearingReasonSv, type BookingProposal, type ClearingEvidence } from '@/lib/bookkeeping/proposal'
import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { ClearingBankRow, ClearingBankRows, ClearingProposer } from '@/lib/transactions/clearing-proposals'
import type { TransactionMethod } from '@/types'
import {
  CARD_MAX_RUN_SPAN_DAYS,
  SWISH_MAX_LAG_DAYS,
  matchPosPayouts,
  type PayoutBankRow,
  type PayoutCardDay,
  type PayoutMatch,
  type PayoutSwishReceipt,
} from './payout-match'
import { resolvePosSalesSettings } from './settings'
import { toNumber } from './types'

/**
 * The till's card and Swish money as bank-row proposals: for an open
 * incoming row in a company with an active POS connection, the proposal to
 * book it against the connection's tender account (1686 by default) when
 * lib/pos-sales/payout-match.ts finds it is that money. Plugged into the
 * bank rows' proposals through lib/composition/clearing-proposals.ts; reads
 * pos_connections and pos_sales_days only, and the bank rows through the
 * bank side's ClearingBankRows.
 */

/** Days of bank rows and POS days read before the earliest asked row: enough for a week of tails to be paid off. */
const LOOKBACK_DAYS = 21
/** Asked rows further apart than this are matched in separate windows. */
const SEGMENT_SPAN_DAYS = 31

/** Confidence: an exact Swish receipt on a row the bank calls Swish, one on another rail, a card fit by days, by balance. */
const CONFIDENCE = { swish: 0.9, swishUnmarked: 0.75, days: 0.7, balance: 0.6 } as const

/** Rails a Swish payment arrives on: the bank's Swish rail, a plain incoming transfer or deposit, or unclassified. */
const SWISH_RAILS = new Set<TransactionMethod | null>(['swish', 'transfer', 'deposit', null])
/** Rails a card payout never arrives on. */
const NOT_PAYOUT_RAILS = new Set<TransactionMethod>(['swish', 'salary', 'interest', 'fee', 'withdrawal', 'autogiro', 'e_invoice'])
/**
 * Banking words that name no counterparty, beyond the bank-noise phrases
 * (stripBankNoise): an incoming row's own wording.
 */
const RAIL_WORDS = new Set([
  'inbetalning',
  'betalning',
  'insättning',
  'överföring',
  'kredit',
  'referens',
  'ref',
  'från',
  'till',
  'via',
  'inb',
  'bet',
  'payment',
  'transfer',
  'deposit',
  'credit',
  'swish',
  'kort',
])

/** Whether the row names who paid: a merchant, or a word of three letters or more that is not banking wording. */
export function namesCounterparty(row: Pick<ClearingBankRow, 'text' | 'merchant_name'>): boolean {
  if (row.merchant_name?.trim()) return true
  const words = stripBankNoise(row.text.toLowerCase()).split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  return words.some((w) => /^\p{L}{3,}$/u.test(w) && !RAIL_WORDS.has(w))
}

/** The row says Swish itself: the bank's rail, or the word. */
export function saysSwish(row: Pick<ClearingBankRow, 'text' | 'transaction_method'>): boolean {
  return row.transaction_method === 'swish' || /\bswish\b/i.test(row.text)
}

/**
 * The Swedish calendar date a receipt was paid: from paidAt when it carries
 * an offset, its own date when it is local time, the business date when it
 * is missing or lies more than a day off it (a restaurant's day runs past
 * midnight, so the day after is normal).
 */
export function receiptPaidOn(paidAt: string | null | undefined, businessDate: string): string {
  if (!paidAt) return businessDate
  let date: string | null = null
  if (/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(paidAt.trim())) {
    const at = new Date(paidAt)
    if (!Number.isNaN(at.getTime())) date = todayIsoStockholm(at)
  } else if (/^\d{4}-\d{2}-\d{2}/.test(paidAt)) {
    date = paidAt.slice(0, 10)
  }
  if (!date) return businessDate
  const offset = daysBetweenIso(businessDate, date)
  return offset >= 0 && offset <= 1 ? date : businessDate
}

interface ConnectionAccounts {
  id: string
  /** The tender account per kind, or null when the kind is unmapped or books straight to a cash ledger. */
  card: string | null
  swish: string | null
}

/** A tender account a bank row can clear: mapped, and not a cash ledger (the row's own side). */
function clearingAccount(account: string | null | undefined): string | null {
  return account && !isCashLedger(account) ? account : null
}

interface DaySummary {
  id: string
  connection_id: string
  business_date: string
  currency: string
  tenders: PosTender[]
}

function tenderSum(tenders: readonly PosTender[], kind: 'card' | 'swish'): number {
  return tenders.filter((t) => t.kind === kind).reduce((sum, t) => sum + toNumber(t.amount), 0)
}

/** The asked rows in windows of at most SEGMENT_SPAN_DAYS. */
function segments(asked: readonly ClearingBankRow[]): ClearingBankRow[][] {
  const sorted = [...asked].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const out: ClearingBankRow[][] = []
  for (const row of sorted) {
    const current = out[out.length - 1]
    if (current && daysBetweenIso(current[0].date, row.date) <= SEGMENT_SPAN_DAYS) current.push(row)
    else out.push([row])
  }
  return out
}

async function loadConnections(supabase: SupabaseClient, companyId: string): Promise<ConnectionAccounts[]> {
  const { data, error } = await supabase
    .from('pos_connections')
    .select('id, settings')
    .eq('company_id', companyId)
    .eq('status', 'active')
  if (error) throw new Error(`pos connections read failed: ${error.message}`)
  return ((data ?? []) as Array<{ id: string; settings: unknown }>)
    .map((c) => {
      const settings = resolvePosSalesSettings(c.settings)
      return {
        id: c.id,
        card: clearingAccount(settings.tender_accounts.card),
        swish: clearingAccount(settings.tender_accounts.swish),
      }
    })
    .filter((c) => c.card || c.swish)
}

async function loadDays(
  supabase: SupabaseClient,
  companyId: string,
  connectionIds: string[],
  from: string,
  to: string,
): Promise<DaySummary[]> {
  const rows = await fetchAllRows<{ id: string; connection_id: string; business_date: string; currency: string | null; tenders: unknown }>(
    ({ from: start, to: end }) =>
      supabase
        .from('pos_sales_days')
        .select('id, connection_id, business_date, currency, tenders')
        .eq('company_id', companyId)
        .in('connection_id', connectionIds)
        .neq('status', 'empty')
        .gte('business_date', from)
        .lte('business_date', to)
        .order('id', { ascending: true })
        .range(start, end),
  )
  return rows.map((r) => ({
    id: r.id,
    connection_id: r.connection_id,
    business_date: r.business_date,
    currency: (r.currency ?? '').toUpperCase(),
    tenders: Array.isArray(r.tenders) ? (r.tenders as PosTender[]) : [],
  }))
}

/** The Swish receipts of these days: a sale paid with one of the day's Swish methods, gross + tips. */
async function loadSwishReceipts(supabase: SupabaseClient, companyId: string, days: DaySummary[]): Promise<PayoutSwishReceipt[]> {
  const out: PayoutSwishReceipt[] = []
  const byId = new Map(days.map((d) => [d.id, d]))
  const ids = days.map((d) => d.id)
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50)
    // Only the receipts, never the whole model: categories and the archived answer stay in the table.
    const { data, error } = await supabase
      .from('pos_sales_days')
      .select('id, receipts:day->receipts')
      .eq('company_id', companyId)
      .in('id', chunk)
    if (error) throw new Error(`pos receipts read failed: ${error.message}`)
    for (const row of (data ?? []) as Array<{ id: string; receipts: unknown }>) {
      const day = byId.get(row.id)
      if (!day || !Array.isArray(row.receipts)) continue
      const methods = new Set(day.tenders.filter((t) => t.kind === 'swish').map((t) => t.method.trim().toLowerCase()))
      for (const receipt of row.receipts as PosReceipt[]) {
        if (receipt?.kind !== 'sale' || typeof receipt.method !== 'string') continue
        if (!methods.has(receipt.method.trim().toLowerCase())) continue
        const amount = toNumber(receipt.gross) + toNumber(receipt.tips)
        if (!(amount > 0)) continue
        out.push({
          day_id: day.id,
          connection_id: day.connection_id,
          business_date: day.business_date,
          number: String(receipt.number ?? ''),
          paid_on: receiptPaidOn(receipt.paidAt, day.business_date),
          amount,
        })
      }
    }
  }
  return out
}

function payoutRow(row: ClearingBankRow, booked: boolean, currencies: ReadonlySet<string>): PayoutBankRow {
  const sameCurrency = currencies.has((row.currency ?? '').toUpperCase())
  if (booked) return { id: row.id, date: row.date, amount: row.amount, booked, swish: sameCurrency, card: sameCurrency }
  const swish = saysSwish(row)
  return {
    id: row.id,
    date: row.date,
    amount: row.amount,
    booked,
    swish: sameCurrency && SWISH_RAILS.has(row.transaction_method),
    card:
      sameCurrency &&
      !swish &&
      !(row.transaction_method && NOT_PAYOUT_RAILS.has(row.transaction_method)) &&
      !namesCounterparty(row),
  }
}

const NAMES = {
  swish: { sv: 'Swish från kassan', en: 'Swish from the till' },
  card: { sv: 'Kortutbetalning från kassan', en: 'Card payout from the till' },
} as const

/** The proposal for one matched row. */
export function payoutProposal(match: PayoutMatch, account: string, row: Pick<ClearingBankRow, 'id' | 'amount' | 'text' | 'transaction_method'>): BookingProposal {
  const evidence: ClearingEvidence =
    match.kind === 'swish'
      ? {
          channel: 'pos',
          kind: 'swish',
          fit: 'receipt',
          account,
          business_dates: [match.business_date],
          receipt_number: match.receipt_number,
          expected_amount: match.expected,
        }
      : {
          channel: 'pos',
          kind: 'card',
          fit: match.fit,
          account,
          business_dates: match.business_dates,
          expected_amount: match.expected,
        }
  const confidence =
    match.kind === 'swish'
      ? saysSwish(row)
        ? CONFIDENCE.swish
        : CONFIDENCE.swishUnmarked
      : match.fit === 'days'
        ? CONFIDENCE.days
        : CONFIDENCE.balance
  const base = accountProposal({
    id: `clearing:pos:${match.kind}`,
    source: 'clearing',
    account,
    label: NAMES[match.kind].sv,
    // An income row against a balance-sheet account: no moms, no revenue account.
    category: 'income_other',
    vat_treatment: 'exempt',
    amount: row.amount,
    confidence,
    description: clearingReasonSv(evidence),
  })
  return { ...base, name_en: NAMES[match.kind].en, requires_review: true, clearing: evidence }
}

async function proposeSegment(
  supabase: SupabaseClient,
  companyId: string,
  asked: ClearingBankRow[],
  bank: ClearingBankRows,
  connections: ConnectionAccounts[],
): Promise<Map<string, BookingProposal>> {
  const out = new Map<string, BookingProposal>()
  const first = asked[0].date
  const last = asked[asked.length - 1].date
  const rowsFrom = addDaysIso(first, -LOOKBACK_DAYS)
  // Rows a few days after the last asked one may already be booked against
  // the account, and claim what they cleared first.
  const rowsTo = addDaysIso(last, SWISH_MAX_LAG_DAYS)
  const days = await loadDays(supabase, companyId, connections.map((c) => c.id), addDaysIso(rowsFrom, -CARD_MAX_RUN_SPAN_DAYS), rowsTo)
  if (days.length === 0) return out

  const byConnection = new Map(connections.map((c) => [c.id, c]))
  const cardDays: PayoutCardDay[] = days
    .filter((d) => byConnection.get(d.connection_id)?.card)
    .map((d) => ({ day_id: d.id, connection_id: d.connection_id, business_date: d.business_date, card: tenderSum(d.tenders, 'card') }))
    .filter((d) => d.card > 0)
  // Receipts an asked row could claim, the ones the rows competing with it
  // could (two lag windows back), and the ones the booked rows after it hold,
  // so a booked row never takes an asked row's receipt for want of its own.
  const receiptsFrom = addDaysIso(first, -(3 * SWISH_MAX_LAG_DAYS + 2))
  const swishDays = days.filter(
    (d) =>
      byConnection.get(d.connection_id)?.swish &&
      d.business_date >= receiptsFrom &&
      d.business_date <= rowsTo &&
      tenderSum(d.tenders, 'swish') > 0,
  )
  const receipts = swishDays.length > 0 ? await loadSwishReceipts(supabase, companyId, swishDays) : []
  if (cardDays.length === 0 && receipts.length === 0) return out

  const accounts = [...new Set(connections.flatMap((c) => [c.card, c.swish]).filter((a): a is string => !!a))]
  const [open, cleared] = await Promise.all([bank.open(rowsFrom, rowsTo), bank.cleared(accounts, rowsFrom, rowsTo)])
  const currencies = new Set(days.map((d) => d.currency).filter(Boolean))
  const openById = new Map<string, ClearingBankRow>()
  for (const row of [...open, ...asked]) openById.set(row.id, row)
  const rows: PayoutBankRow[] = [
    ...[...openById.values()].map((r) => payoutRow(r, false, currencies)),
    ...cleared.filter((r) => !openById.has(r.id)).map((r) => payoutRow(r, true, currencies)),
  ]

  const matches = matchPosPayouts({ cardDays, receipts, rows })
  for (const row of asked) {
    const match = matches.get(row.id)
    if (!match) continue
    const connection = byConnection.get(match.connection_id)
    const account = match.kind === 'swish' ? connection?.swish : connection?.card
    if (account) out.set(row.id, payoutProposal(match, account, row))
  }
  return out
}

export const posPayoutProposer: ClearingProposer = Object.freeze<ClearingProposer>({
  id: 'pos-payouts',
  module: 'pos',
  async propose(supabase, companyId, asked, bank) {
    const out = new Map<string, BookingProposal>()
    if (asked.length === 0) return out
    // The one read a company without a till pays.
    const connections = await loadConnections(supabase, companyId)
    if (connections.length === 0) return out
    for (const segment of segments(asked)) {
      for (const [id, proposal] of await proposeSegment(supabase, companyId, segment, bank, connections)) out.set(id, proposal)
    }
    return out
  },
})
