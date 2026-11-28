import type { SupabaseClient } from '@supabase/supabase-js'
import { isCashLedger } from '@/lib/bookkeeping/bank-leg'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { accountProposal, clearingReasonSv, type BookingProposal, type WebshopPayoutEvidence } from '@/lib/bookkeeping/proposal'
import { addDaysIso, daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { createLogger } from '@/lib/logger'
import { equalOre } from '@/lib/money'
import { createServiceClient } from '@/lib/supabase/server'
import type {
  ClearingBankRow,
  ClearingBooking,
  ClearingBookingRow,
  ClearingLinesOutcome,
  ClearingProposer,
  ClearingUnderlag,
} from '@/lib/transactions/clearing-proposals'
import type { WebshopPayout, WebshopStoreSettings } from '@/types'
import { resolvePaymentAccount } from './booking-lines'
import { payoutDescription, payoutProviderLabel, planPayoutVoucher, type PayoutVoucherPlan } from './payouts'

/**
 * A payment provider's payout as a bank-row proposal: for an open incoming
 * row that is a stored payout to the öre (webshop_payouts, read from Kustom's
 * settlement report or Shopify Payments), the proposal to book it as the
 * payout's verifikat: the bank net, the provider's fees and the clearing
 * account gross (planPayoutVoucher). Plugged into the bank rows' proposals
 * through lib/composition/clearing-proposals.ts, and booked through the bank
 * row's own booking, which asks `booking` below for the lines, claims the
 * payout for the row and settles it on the verifikat.
 *
 * A clearing proposal is never booked without a review
 * (lib/transactions/direct-booking.ts): the person sees the lines.
 */

const log = createLogger('webshop-orders/payout-proposals')

export const WEBSHOP_PAYOUT_PROPOSER_ID = 'webshop-payouts'

/**
 * How far the bank row may be dated from the payout day: a day before (the
 * provider's day can be the UTC one) to five days after (bank days, a weekend
 * and a holiday).
 */
const DAYS_BEFORE = 1
const DAYS_AFTER = 5

/** The payment method each provider's orders carry, which the store maps to its clearing account. */
const PAYMENT_METHOD: Record<WebshopPayout['platform'], string> = {
  kustom: 'kustom',
  shopify: 'shopify_payments',
}

const PAYOUT_COLUMNS =
  'id, company_id, platform, store_scope, external_id, reference, payout_date, currency, amount, lines, transaction_id, journal_entry_id'

type PayoutRow = Pick<
  WebshopPayout,
  | 'id'
  | 'company_id'
  | 'platform'
  | 'store_scope'
  | 'external_id'
  | 'reference'
  | 'payout_date'
  | 'currency'
  | 'amount'
  | 'lines'
  | 'transaction_id'
  | 'journal_entry_id'
>

function normalize(row: PayoutRow): PayoutRow {
  return { ...row, amount: Number(row.amount), lines: Array.isArray(row.lines) ? row.lines.map((l) => ({ ...l, amount: Number(l.amount) })) : [] }
}

/** Whether the bank row can be this payout: the ledger currency, the same amount to the öre, dated around the payout day. */
export function rowFitsPayout(row: Pick<ClearingBankRow, 'amount' | 'currency' | 'date'>, payout: Pick<PayoutRow, 'amount' | 'currency' | 'payout_date'>): boolean {
  if (!isLedgerCurrency(row.currency?.toUpperCase()) || !isLedgerCurrency(payout.currency.toUpperCase())) return false
  if (!equalOre(row.amount, payout.amount)) return false
  const lag = daysBetweenIso(payout.payout_date, row.date)
  return lag >= -DAYS_BEFORE && lag <= DAYS_AFTER
}

/**
 * Pairs rows and payouts one to one: each row its nearest payout by date,
 * and a payout to the nearest row only. A row two payouts fit equally well is
 * left alone, as is a payout two rows fit equally well: never a guess.
 */
export function pairRowsWithPayouts<R extends Pick<ClearingBankRow, 'id' | 'amount' | 'currency' | 'date'>, P extends Pick<PayoutRow, 'id' | 'amount' | 'currency' | 'payout_date'>>(
  rows: readonly R[],
  payouts: readonly P[],
): Map<string, P> {
  const distance = (row: R, payout: P) => Math.abs(daysBetweenIso(payout.payout_date, row.date))
  const nearestPayout = new Map<string, P>()
  for (const row of rows) {
    const fits = payouts.filter((p) => rowFitsPayout(row, p))
    if (fits.length === 0) continue
    const best = Math.min(...fits.map((p) => distance(row, p)))
    const nearest = fits.filter((p) => distance(row, p) === best)
    if (nearest.length === 1) nearestPayout.set(row.id, nearest[0]!)
  }
  const out = new Map<string, P>()
  for (const row of rows) {
    const payout = nearestPayout.get(row.id)
    if (!payout) continue
    const mine = distance(row, payout)
    // Every other row that fits the payout is a rival, whichever payout it
    // leans to: a farther row never takes a payout a nearer one could be.
    const rivals = rows.filter((r) => r.id !== row.id && rowFitsPayout(r, payout))
    if (rivals.some((r) => distance(r, payout) <= mine)) continue
    out.set(row.id, payout)
  }
  return out
}

/**
 * The payouts still to book: none booked, or booked on a verifikat that is no
 * longer posted (reversed with storno, or the bank row's booking undone), which
 * reopens the payout for the row's next booking.
 */
async function openPayouts(supabase: SupabaseClient, companyId: string, payouts: readonly PayoutRow[]): Promise<PayoutRow[]> {
  const booked = [...new Set(payouts.map((p) => p.journal_entry_id).filter((id): id is string => !!id))]
  if (booked.length === 0) return [...payouts]
  const { data, error } = await supabase.from('journal_entries').select('id, status').eq('company_id', companyId).in('id', booked)
  if (error) throw new Error(`payout verifikat read failed: ${error.message}`)
  const posted = new Set(((data ?? []) as Array<{ id: string; status: string }>).filter((e) => e.status === 'posted').map((e) => e.id))
  return payouts.filter((p) => !p.journal_entry_id || !posted.has(p.journal_entry_id))
}

/** A payout reopened by a reversed verifikat, as the booking sees it: no verifikat, no claim. */
function reopened(payout: PayoutRow): PayoutRow {
  return payout.journal_entry_id ? { ...payout, journal_entry_id: null, transaction_id: null } : payout
}

/**
 * Whether the row's text names the payout: the provider, or the payout's own
 * reference. A row that names neither (a bare "INSÄTTNING") can still be the
 * payout, at a lower confidence; it is never booked without a review either way.
 */
function textNamesPayout(row: Pick<ClearingBankRow, 'text' | 'merchant_name'>, payout: Pick<PayoutRow, 'platform' | 'reference'>): boolean {
  const text = `${row.text} ${row.merchant_name ?? ''}`.toLowerCase()
  return text.includes(payout.platform) || (!!payout.reference && text.includes(payout.reference.toLowerCase()))
}

/** The store settings of each store the payouts belong to, keyed platform:store_scope. */
async function loadSettings(
  supabase: SupabaseClient,
  companyId: string,
  payouts: readonly PayoutRow[],
): Promise<Map<string, WebshopStoreSettings>> {
  const scopes = [...new Set(payouts.map((p) => p.store_scope))]
  const { data, error } = await supabase
    .from('webshop_store_settings')
    .select('*')
    .eq('company_id', companyId)
    .in('store_scope', scopes)
  if (error) throw new Error(`webshop store settings read failed: ${error.message}`)
  return new Map(((data ?? []) as WebshopStoreSettings[]).map((s) => [`${s.platform}:${s.store_scope}`, s]))
}

/** The clearing account the payout's orders were booked against; null when it is a cash ledger (the row's own side). */
function clearingAccountOf(payout: PayoutRow, settings: Map<string, WebshopStoreSettings>): string | null {
  const store = settings.get(`${payout.platform}:${payout.store_scope}`) ?? null
  const { account, invoiceMode } = resolvePaymentAccount({ payment_method: PAYMENT_METHOD[payout.platform] }, store)
  // Orders the store invoices book on the customer's receivable, never on a
  // clearing account: the payout has nothing there to clear.
  if (invoiceMode) return null
  return isCashLedger(account) ? null : account
}

async function vatRegisteredOf(supabase: SupabaseClient, companyId: string): Promise<boolean> {
  const { data } = await supabase.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle()
  // A missing value counts as registered, as for the collections settlement.
  return (data as { vat_registered?: boolean | null } | null)?.vat_registered !== false
}

function evidenceOf(payout: PayoutRow, account: string, plan: PayoutVoucherPlan): WebshopPayoutEvidence {
  return {
    channel: 'webshop',
    kind: 'payout',
    fit: 'payout',
    provider: payoutProviderLabel(payout.platform),
    reference: payout.reference,
    account,
    business_dates: [payout.payout_date],
    expected_amount: payout.amount,
    fees: plan.fees,
    fee_vat: plan.feeVat,
    clearing_amount: plan.clearing,
  }
}

function proposalFor(row: ClearingBankRow, payout: PayoutRow, account: string, plan: PayoutVoucherPlan): BookingProposal {
  const confidence = textNamesPayout(row, payout) ? 0.95 : 0.7
  const evidence = evidenceOf(payout, account, plan)
  const label = `Utbetalning ${evidence.provider}`
  const base = accountProposal({
    id: `clearing:webshop-payout:${payout.id}`,
    source: 'clearing',
    account,
    label,
    // An income row against a balance-sheet account: the sales are the orders'.
    category: 'income_other',
    vat_treatment: 'exempt',
    amount: row.amount,
    confidence,
    description: clearingReasonSv(evidence),
  })
  return {
    ...base,
    booking: { ...(base.booking as Extract<BookingProposal['booking'], { kind: 'account' }>), clearing_ref: { proposer: WEBSHOP_PAYOUT_PROPOSER_ID, ref: payout.id } },
    name_en: `Payout ${evidence.provider}`,
    requires_review: true,
    clearing: evidence,
  }
}

async function propose(
  supabase: SupabaseClient,
  companyId: string,
  asked: readonly ClearingBankRow[],
): Promise<Map<string, BookingProposal>> {
  const out = new Map<string, BookingProposal>()
  if (asked.length === 0) return out
  const dates = asked.map((r) => r.date).sort()
  const { data, error } = await supabase
    .from('webshop_payouts')
    .select(PAYOUT_COLUMNS)
    .eq('company_id', companyId)
    .gte('payout_date', addDaysIso(dates[0]!, -DAYS_AFTER))
    .lte('payout_date', addDaysIso(dates[dates.length - 1]!, DAYS_BEFORE))
  if (error) throw new Error(`webshop payouts read failed: ${error.message}`)
  const read = ((data ?? []) as PayoutRow[]).map(normalize)
  if (read.length === 0) return out
  const payouts = (await openPayouts(supabase, companyId, read)).map(reopened)
  if (payouts.length === 0) return out

  // A payout a row has claimed is that row's, and no other row's to pair
  // with; the rest pair among themselves.
  const askedRowById = new Map(asked.map((r) => [r.id, r]))
  const free: Array<[string, PayoutRow]> = []
  for (const payout of payouts) {
    const claimer = payout.transaction_id ? askedRowById.get(payout.transaction_id) : undefined
    if (claimer && rowFitsPayout(claimer, payout)) free.push([claimer.id, payout])
  }
  const claimers = new Set(free.map(([rowId]) => rowId))
  const unclaimed = payouts.filter((p) => !p.transaction_id)
  free.push(...pairRowsWithPayouts(asked.filter((r) => !claimers.has(r.id)), unclaimed).entries())
  if (free.length === 0) return out

  const [settings, vatRegistered] = await Promise.all([
    loadSettings(supabase, companyId, free.map(([, p]) => p)),
    vatRegisteredOf(supabase, companyId),
  ])
  const askedById = new Map(asked.map((r) => [r.id, r]))
  for (const [rowId, payout] of free) {
    const row = askedById.get(rowId)!
    const account = clearingAccountOf(payout, settings)
    if (!account) continue
    const planned = planPayoutVoucher({ payout, clearingAccount: account, vatRegistered })
    if (!planned.ok) continue
    out.set(rowId, proposalFor(row, payout, account, planned.plan))
  }
  return out
}

async function loadPayout(supabase: SupabaseClient, companyId: string, id: string): Promise<PayoutRow | null> {
  const { data, error } = await supabase.from('webshop_payouts').select(PAYOUT_COLUMNS).eq('company_id', companyId).eq('id', id).maybeSingle()
  if (error) throw new Error(`webshop payout read failed: ${error.message}`)
  return data ? normalize(data as PayoutRow) : null
}

async function lines(
  supabase: SupabaseClient,
  companyId: string,
  row: ClearingBookingRow,
  ref: string,
  context: { vatRegistered: boolean },
): Promise<ClearingLinesOutcome> {
  const stored = await loadPayout(supabase, companyId, ref)
  if (!stored) return { ok: false, code: 'WEBSHOP_PAYOUT_NOT_FOUND' }
  const payout = (await openPayouts(supabase, companyId, [stored])).length > 0 ? reopened(stored) : stored
  if (payout.journal_entry_id || (payout.transaction_id && payout.transaction_id !== row.id)) {
    return { ok: false, code: 'CLEARING_RECORD_TAKEN', details: { journal_entry_id: payout.journal_entry_id } }
  }
  if (!rowFitsPayout({ amount: row.amount, currency: row.currency, date: row.date }, payout)) {
    return {
      ok: false,
      code: 'WEBSHOP_PAYOUT_ROW_MISMATCH',
      details: { payout_amount: payout.amount, payout_date: payout.payout_date, row_amount: row.amount, row_date: row.date },
    }
  }
  const settings = await loadSettings(supabase, companyId, [payout])
  const account = clearingAccountOf(payout, settings)
  if (!account) return { ok: false, code: 'WEBSHOP_PAYOUT_NOT_BOOKABLE', details: { reason: 'clearing_account' } }
  const planned = planPayoutVoucher({ payout, clearingAccount: account, vatRegistered: context.vatRegistered })
  if (!planned.ok) return { ok: false, code: 'WEBSHOP_PAYOUT_NOT_BOOKABLE', details: { reason: planned.reason } }
  return { ok: true, lines: planned.plan.lines, description: payoutDescription(payout) }
}

async function claim(supabase: SupabaseClient, companyId: string, ref: string, transactionId: string): Promise<boolean> {
  // Payout rows have no member write policy: the claim is the service role's,
  // scoped to the company the booking runs in.
  const service = createServiceClient()
  // A payout booked on a verifikat that no longer stands is open again: its
  // old pointers are cleared first, conditionally on that very verifikat.
  const stored = await loadPayout(supabase, companyId, ref)
  if (stored?.journal_entry_id && (await openPayouts(supabase, companyId, [stored])).length > 0) {
    const { error: resetError } = await service
      .from('webshop_payouts')
      .update({ journal_entry_id: null, transaction_id: null })
      .eq('company_id', companyId)
      .eq('id', ref)
      .eq('journal_entry_id', stored.journal_entry_id)
    if (resetError) {
      log.error('failed to reopen the payout', resetError, { payoutId: ref })
      return false
    }
  }
  const { data, error } = await service
    .from('webshop_payouts')
    .update({ transaction_id: transactionId })
    .eq('company_id', companyId)
    .eq('id', ref)
    .is('journal_entry_id', null)
    .or(`transaction_id.is.null,transaction_id.eq.${transactionId}`)
    .select('id')
  if (error) {
    log.error('failed to claim the payout', error, { payoutId: ref, transactionId })
    return false
  }
  return (data ?? []).length > 0
}

async function release(_supabase: SupabaseClient, companyId: string, ref: string, transactionId: string): Promise<void> {
  const { error } = await createServiceClient()
    .from('webshop_payouts')
    .update({ transaction_id: null })
    .eq('company_id', companyId)
    .eq('id', ref)
    .eq('transaction_id', transactionId)
    .is('journal_entry_id', null)
  if (error) throw new Error(`payout release failed: ${error.message}`)
}

/** The verifikat's lines as booked, for the underlag (the bank leg included). */
async function bookedLines(supabase: SupabaseClient, journalEntryId: string) {
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount, sort_order')
    .eq('journal_entry_id', journalEntryId)
    .order('sort_order', { ascending: true })
  // A specification without the verifikat's lines would say the wrong thing.
  if (error) throw new Error(`payout verifikat lines read failed: ${error.message}`)
  return ((data ?? []) as Array<{ account_number: string; debit_amount: number; credit_amount: number }>).map((l) => ({
    account_number: l.account_number,
    debit_amount: Number(l.debit_amount),
    credit_amount: Number(l.credit_amount),
  }))
}

async function settle(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  ref: string,
  transactionId: string,
  journalEntryId: string,
): Promise<ClearingUnderlag | null> {
  try {
    // The claim may have been let go meanwhile by a second booking of the same
    // row that lost: the winner settles all the same, as long as no other
    // row holds the payout and no verifikat books it.
    const { data, error } = await createServiceClient()
      .from('webshop_payouts')
      .update({ transaction_id: transactionId, journal_entry_id: journalEntryId })
      .eq('company_id', companyId)
      .eq('id', ref)
      .is('journal_entry_id', null)
      .or(`transaction_id.is.null,transaction_id.eq.${transactionId}`)
      .select(PAYOUT_COLUMNS)
    if (error || !data || data.length === 0) {
      log.error('failed to settle the payout on its verifikat', error ?? new Error('no claimed payout matched'), { payoutId: ref, journalEntryId })
      return null
    }
    const payout = normalize(data[0] as PayoutRow)
    const { buildPayoutUnderlagModel, renderWebshopPayoutUnderlagPdf } = await import('./payout-underlag')
    const { data: company } = await supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', companyId)
      .maybeSingle()
    const model = buildPayoutUnderlagModel({ payout, lines: await bookedLines(supabase, journalEntryId) })
    const { bytes, filename } = await renderWebshopPayoutUnderlagPdf({
      model,
      company: (company ?? {}) as { company_name?: string | null; org_number?: string | null },
      generatedAt: todayIsoStockholm(),
    })
    // The payout's own specification, for the payout's own verifikat.
    return { name: filename, bytes, type: 'application/pdf', idempotencyKey: `webshop-payout:${payout.id}` }
  } catch (err) {
    // The verifikat stands; a missing specification shows as missing underlag.
    log.error('failed to build the payout specification', err as Error, { payoutId: ref, journalEntryId })
    return null
  }
}

const booking: ClearingBooking = Object.freeze<ClearingBooking>({ lines, claim, release, settle })

export const webshopPayoutProposer: ClearingProposer = Object.freeze<ClearingProposer>({
  id: WEBSHOP_PAYOUT_PROPOSER_ID,
  module: 'webshop',
  propose: (supabase, companyId, asked) => propose(supabase, companyId, asked),
  booking,
})
