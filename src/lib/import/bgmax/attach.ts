/**
 * Attaching Bankgirot's deposit specification (a BG Max file) to the bank
 * rows that are the deposits, crm#1170.
 *
 * A bank feed shows a bankgiro deposit as one row with no payer and no OCR
 * ("Bankgiro inbetalning", "BG 123-4567 00012"). Each deposit in the BG Max
 * file (lib/import/bgmax/parser.ts) is exactly one such row: the same
 * receiving bankgiro, the same total, booked on Bankgirot's payment date.
 * Its payments become the row's split (bank_transaction_parts) through the
 * one split write path (applyTransactionSplit), so every payment gets the
 * open customer invoice its OCR, invoice number or payer names, and a row
 * whose payments all resolved is offered to the batch allocation
 * (match_batch_allocate) in one go, exactly as an Open Payments split is.
 *
 * The file never creates a bank row and never changes one's amount, date or
 * text: a deposit with no stored row stays out and is reported, and the same
 * file uploaded again after the next bank sync attaches it. A re-import is
 * idempotent: a split always replaces the row's previous one.
 *
 * Which row is the deposit, in order of evidence:
 *   - the amount is the deposit's to the öre, the currency the deposit's;
 *   - the row is a Bankgirot deposit: readGiroCounterparty reads it as a
 *     deposit through the file's own bankgiro, or its text says bankgiro
 *     ("Bankgiro inbetalning", "BANKGIRO INBET", "Insättning Bankgirot")
 *     without naming another giro; a row read as another bankgiro is never it;
 *   - the booking date is the payment date, or within DATE_WINDOW_DAYS of it;
 *   - the deposit serial number, when the bank prints it on the row, equals
 *     the file's.
 * The closest row wins. When two rows are equally close and nothing tells
 * them apart, the deposit is ambiguous and left for the person: a wrong
 * split would suggest the wrong customer's invoices.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { loadInvoiceMatchPool } from '@/lib/invoices/invoice-matching'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { amountToOre } from '@/lib/transactions/external-id'
import { giroKey, readGiroCounterparty, type GiroRegister, type GiroRow } from '@/lib/transactions/giro-counterparty'
import { loadGiroRegister } from '@/lib/transactions/giro-register'
import { applyTransactionSplit } from '@/lib/transactions/parts-apply'
import type { BankTransactionPartInput, Transaction } from '@/types'
import type { BgMaxDeposit, BgMaxPayment } from './parser'

/** How far a bank's booking date may sit from Bankgirot's payment date (a weekend, a late booking). */
export const DATE_WINDOW_DAYS = 3

/** The stored row fields the attachment reads. */
export type DepositRow = GiroRow &
  Pick<
    Transaction,
    | 'id'
    | 'date'
    | 'currency'
    | 'journal_entry_id'
    | 'invoice_id'
    | 'supplier_invoice_id'
    | 'is_ignored'
    | 'potential_invoice_id'
    | 'potential_journal_entry_id'
    | 'potential_match_method'
  >

export type DepositMatch =
  | { status: 'matched'; row: DepositRow }
  | { status: 'no_row' }
  | { status: 'ambiguous'; candidates: number }

/** One payment of the file as a part of the row's split. */
export function paymentToPart(payment: BgMaxPayment, currency: string): BankTransactionPartInput {
  return {
    amount: payment.amount,
    currency,
    counterparty_name: payment.payer_name,
    counterparty_org_number: payment.payer_org_number,
    counterparty_account: payment.payer_bankgiro,
    reference: payment.reference,
    // Further OCR references Bankgirot found for the payment: the payer named these invoices too.
    invoice_numbers: payment.extra_references.filter((r) => r !== payment.reference),
    message: payment.message,
    provider_part_id: payment.bgc_serial,
  }
}

// ── Which row is the deposit (pure) ─────────────────────────────────────

/** The bank's own words for a bankgiro deposit, where it prints no number or names the payer. */
const BANKGIRO_WORDING = /bank\s*giro|\bbg\b|bggirering|^bi\s+\d/i

function bankText(row: GiroRow): string {
  return (row.original_description || row.description || '').trim()
}

/** 'giro': read as a deposit through the file's bankgiro; 'worded': says bankgiro, names no other giro. */
function depositEvidence(row: DepositRow, deposit: BgMaxDeposit, register: GiroRegister): 'giro' | 'worded' | null {
  const reading = readGiroCounterparty(row, register)
  if (reading) {
    if (reading.kind !== 'own_deposit') return null
    return giroKey(reading.giro) === giroKey(deposit.bankgiro) ? 'giro' : null
  }
  return BANKGIRO_WORDING.test(bankText(row)) ? 'worded' : null
}

/** Whole days from a to b (YYYY-MM-DD). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** The deposit serial number printed on the row ("BG 123-4567 00012"), when one equals the file's. */
function serialOnRow(row: GiroRow, serial: string | null): boolean {
  if (!serial) return false
  const wanted = Number(serial)
  return [...bankText(row).matchAll(/(?<![\d-])(\d{5})(?![\d-])/g)].some((m) => Number(m[1]) === wanted)
}

/** Lower is better: the serial on the row, then the date distance, then the giro read off the row. */
type Rank = readonly [number, number, number]

function compareRank(a: Rank, b: Rank): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

interface Candidate {
  row: DepositRow
  rank: Rank
}

function candidatesFor(deposit: BgMaxDeposit, rows: readonly DepositRow[], register: GiroRegister): Candidate[] {
  const ore = amountToOre(deposit.amount)
  const out: Candidate[] = []
  for (const row of rows) {
    if (amountToOre(row.amount) !== ore) continue
    if (row.currency && row.currency.toUpperCase() !== deposit.currency) continue
    const distance = Math.abs(dayDiff(deposit.date, row.date))
    if (!Number.isFinite(distance) || distance > DATE_WINDOW_DAYS) continue
    const evidence = depositEvidence(row, deposit, register)
    if (!evidence) continue
    out.push({ row, rank: [serialOnRow(row, deposit.serial) ? 0 : 1, distance, evidence === 'giro' ? 0 : 1] })
  }
  return out.sort((a, b) => compareRank(a.rank, b.rank) || a.row.date.localeCompare(b.row.date) || a.row.id.localeCompare(b.row.id))
}

/**
 * The bank row of each deposit, in the deposits' order. Deposits that look
 * the same (date, amount, bankgiro and serial) are interchangeable: when
 * exactly as many equally close rows exist, they are paired in order. The
 * deposit whose closest row is closest claims first, so a deposit whose own
 * row has not synced never takes a neighbour's row the neighbour fits better.
 */
export function matchDepositsToRows(
  deposits: readonly BgMaxDeposit[],
  rows: readonly DepositRow[],
  register: GiroRegister,
): DepositMatch[] {
  const results: DepositMatch[] = deposits.map(() => ({ status: 'no_row' }))
  const candidates = deposits.map((deposit) => candidatesFor(deposit, rows, register))
  const groups = new Map<string, number[]>()
  deposits.forEach((d, index) => {
    const key = `${d.date}|${amountToOre(d.amount)}|${d.currency}|${giroKey(d.bankgiro)}|${d.serial ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), index])
  })
  const pending = [...groups.values()]
  const taken = new Set<string>()
  const free = (index: number) => candidates[index]!.filter((c) => !taken.has(c.row.id))

  while (pending.length > 0) {
    let best = -1
    let bestRank: Rank | null = null
    for (let g = 0; g < pending.length; g++) {
      const top = free(pending[g]![0]!)[0]
      if (top && (bestRank === null || compareRank(top.rank, bestRank) < 0)) {
        best = g
        bestRank = top.rank
      }
    }
    if (best === -1) break // every remaining deposit: no free row

    const group = pending[best]!
    const open = free(group[0]!)
    const tier = open.filter((c) => compareRank(c.rank, open[0]!.rank) === 0)
    if (tier.length > group.length) {
      for (const index of group) results[index] = { status: 'ambiguous', candidates: tier.length }
      pending.splice(best, 1)
      continue
    }
    tier.forEach((c, j) => {
      results[group[j]!] = { status: 'matched', row: c.row }
      taken.add(c.row.id)
    })
    group.splice(0, tier.length)
    if (group.length === 0) pending.splice(best, 1)
  }
  return results
}

// ── Attaching (I/O) ─────────────────────────────────────────────────────

export interface DepositOutcome {
  date: string
  amount: number
  bankgiro: string
  payments: number
  status: DepositMatch['status']
  /** The bank row the deposit attached to (status 'matched'). */
  transaction_id: string | null
  /** Payments that got an open customer invoice suggested. */
  suggested: number
}

export interface AttachSummary {
  /** True when the split was written; false for a preview. */
  applied: boolean
  deposits: number
  payments: number
  matched_deposits: number
  matched_payments: number
  /** Payments that got an open customer invoice suggested (applied only). */
  suggested_payments: number
  /** Rows whose payments all resolved: ready for one batch allocation, or one single match (applied only). */
  ready_rows: number
  no_row: number
  ambiguous: number
  outcomes: DepositOutcome[]
}

export interface AttachInput {
  companyId: string
  userId: string
  deposits: readonly BgMaxDeposit[]
  /** False: read and match only (the preview). True: write each matched row's split. */
  apply: boolean
}

function shiftDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The company's incoming rows that could be one of the deposits: amounts in the file, dates in its window. */
async function loadDepositRows(supabase: SupabaseClient, companyId: string, deposits: readonly BgMaxDeposit[]): Promise<DepositRow[]> {
  if (deposits.length === 0) return []
  const dates = deposits.map((d) => d.date).sort()
  const from = shiftDays(dates[0]!, -DATE_WINDOW_DAYS)
  const to = shiftDays(dates[dates.length - 1]!, DATE_WINDOW_DAYS)
  const amounts = [...new Set(deposits.map((d) => d.amount))]
  const rows: DepositRow[] = []
  // A year's file can carry hundreds of amounts: keep each request's filter short.
  for (let i = 0; i < amounts.length; i += 100) {
    const chunk = amounts.slice(i, i + 100)
    rows.push(
      ...(await fetchAllRows<DepositRow>(({ from: start, to: end }) =>
        supabase
          .from('transactions')
          // One literal, so the schema guard (tests/schema/no-phantom-columns) can read it.
          .select(
            'id, date, amount, currency, description, original_description, merchant_name, counterparty_account, reference, journal_entry_id, invoice_id, supplier_invoice_id, is_ignored, potential_invoice_id, potential_journal_entry_id, potential_match_method',
          )
          .eq('company_id', companyId)
          .gt('amount', 0)
          .gte('date', from)
          .lte('date', to)
          .in('amount', chunk)
          .order('id', { ascending: true })
          .range(start, end),
      )),
    )
  }
  return rows
}

/**
 * Match each deposit to its bank row and, when `apply`, write the row's
 * split with the invoice suggestions. A refused write fails the call: the
 * person sees it and can upload again, and every split written before it is
 * already whole (a split replaces the row's previous one).
 */
export async function attachBgMaxDeposits(supabase: SupabaseClient, input: AttachInput): Promise<AttachSummary> {
  const { companyId, userId, deposits, apply } = input
  const [rows, register] = await Promise.all([
    loadDepositRows(supabase, companyId, deposits),
    loadGiroRegister(supabase, companyId),
  ])
  const matches = matchDepositsToRows(deposits, rows, register)

  const pool = apply && matches.some((m) => m.status === 'matched') ? await loadInvoiceMatchPool(supabase, companyId) : null
  // An invoice is offered to one payment of the file, never two.
  const claimed = new Set<string>()
  const outcomes: DepositOutcome[] = []
  let readyRows = 0

  for (let index = 0; index < deposits.length; index++) {
    const deposit = deposits[index]!
    const match = matches[index]!
    const outcome: DepositOutcome = {
      date: deposit.date,
      amount: deposit.amount,
      bankgiro: deposit.bankgiro,
      payments: deposit.payments.length,
      status: match.status,
      transaction_id: match.status === 'matched' ? match.row.id : null,
      suggested: 0,
    }
    outcomes.push(outcome)
    if (match.status !== 'matched' || !apply) continue

    const row = match.row
    const parts = deposit.payments.map((p) => paymentToPart(p, deposit.currency))
    const open = !row.journal_entry_id && !row.invoice_id && !row.supplier_invoice_id && !row.is_ignored
    const { suggestions, complete } = await applyTransactionSplit(supabase, {
      companyId,
      userId,
      tx: row,
      parts,
      pools: open && pool ? { customerInvoices: pool.invoices, supplierInvoices: [], excludeInvoiceIds: claimed } : null,
    })
    for (const s of suggestions ?? []) {
      if (s.suggested_invoice_id) {
        claimed.add(s.suggested_invoice_id)
        outcome.suggested++
      }
    }
    if (complete) {
      readyRows++
      continue
    }

    // One payment that settles one invoice: the row's own one-click match,
    // the hint ingest gives a row whose reference names the invoice. A hint
    // or voucher suggestion the row already carries stands.
    const only = suggestions?.length === 1 ? suggestions[0] : null
    if (!only?.suggested_invoice_id || amountToOre(parts[0]!.amount) !== amountToOre(row.amount)) continue
    if (row.potential_invoice_id === only.suggested_invoice_id) {
      readyRows++ // the same file again: the hint is already there
      continue
    }
    if (!row.potential_invoice_id && !row.potential_journal_entry_id) {
      const { error } = await supabase
        .from('transactions')
        .update({ potential_invoice_id: only.suggested_invoice_id })
        .eq('id', row.id)
        .eq('company_id', companyId)
      if (error) throw error
      await logMatchEvent(supabase, userId, row.id, 'auto_suggested', {
        invoiceId: only.suggested_invoice_id,
        matchMethod: `bgmax_${only.suggestion_reason ?? 'reference'}`,
      })
      readyRows++
    }
  }

  const matched = outcomes.filter((o) => o.status === 'matched')
  return {
    applied: apply,
    deposits: deposits.length,
    payments: deposits.reduce((n, d) => n + d.payments.length, 0),
    matched_deposits: matched.length,
    matched_payments: matched.reduce((n, o) => n + o.payments, 0),
    suggested_payments: outcomes.reduce((n, o) => n + o.suggested, 0),
    ready_rows: readyRows,
    no_row: outcomes.filter((o) => o.status === 'no_row').length,
    ambiguous: outcomes.filter((o) => o.status === 'ambiguous').length,
    outcomes,
  }
}
