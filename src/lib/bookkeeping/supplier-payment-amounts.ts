/**
 * The SEK a manual supplier payment clears off leverantörsskulder (244x).
 *
 * A payment is entered in the invoice's currency (37.50 USD), but the payment
 * verifikat is in SEK, and under faktureringsmetoden the skuld sits on 2440 at
 * the SEK the registration booked. Handing the invoice-currency figure to the
 * SEK line builder booked "37.50 kr" and left the rest of the skuld on 2440
 * while the invoice read as paid (#2955). Every manual door (dashboard
 * mark-paid, its preview, v1 mark-paid) resolves the SEK here instead.
 *
 * Where the SEK comes from:
 *   - SEK invoice: the amount itself, exactly as before.
 *   - Foreign invoice with a registration verifikat: the ledger. What the
 *     invoice still carries on 244x is the registration's 244x credit (its
 *     live correction when it was stornoed) minus the 244x debits of the
 *     invoice's own payment vouchers. A full settlement clears exactly that,
 *     so no öre is stranded; a part payment clears its share of it. The rate
 *     is never used here: it cannot reproduce the registration's per-line
 *     rounding, a rättelse that changed the skuld, or the SEK an earlier bank
 *     match cleared.
 *   - Foreign invoice whose registration the settlement books first (a
 *     deferring company's unbooked invoice): the 244x SEK of that
 *     registration as the Bokför dry run builds it
 *     (pendingRegistrationPayableSek).
 *   - Foreign invoice with no registration verifikat (typically migrated from
 *     another system, whose skuld arrived with the imported journal): nothing
 *     links it to the ledger, so the invoice's own booked rate, the same
 *     conversion the bank-match door uses. No rate: SI_FX_RATE_MISSING.
 *
 * Links that contradict each other (a voucher shared with another invoice,
 * payment rows that do not add up to paid_amount, a registration or payment
 * voucher reversed with no single correction) are refused with
 * SI_PAID_SEK_UNRESOLVED rather than guessed: the user can still book the
 * payment with edited rows. So is a ledger figure more than 10% away from
 * what the invoice's own rate says it owes: that gap is a rättelse of the
 * skuld itself (e.g. moms taken off the registration), not a rate movement,
 * and booking it on 3960/7960 would call it a kursdifferens. An amount above
 * what the invoice still owes never gets here: planSupplierPayment refuses it
 * first on every door (lib/invoices/settle-supplier-payment.ts).
 *
 * The SEK that left the payment account is a separate input (`amountSek`).
 * When it differs from the SEK cleared, the difference is the realised
 * kursdifferens on a rörelseskuld: 3960 (vinst) or 7960 (förlust), booked by
 * buildSupplierInvoicePaymentLines.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { liveEntryOf, MAX_CHAIN_WALK, type LiveEntry } from '@/lib/core/bookkeeping/correction-chain'
import { fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { dbError } from '@/lib/errors/db-error'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import type { SupplierInvoice } from '@/types'

export const SI_PAID_SEK_UNRESOLVED = 'SI_PAID_SEK_UNRESOLVED' as const

/** Why the SEK carried on 244x could not be read off the linked vouchers. */
export type SupplierPaymentSekUnresolvedReason =
  /** Reversed with no single correction, or never posted. */
  | 'registration_voucher_not_live'
  /** Another supplier invoice names the same registration verifikat. */
  | 'registration_voucher_shared'
  /** Payment rows without a voucher, or not adding up to paid_amount. */
  | 'payment_history_mismatch'
  /** A payment voucher that is missing, or reversed with no single correction. */
  | 'payment_voucher_not_posted'
  /** A payment voucher that also settles another supplier invoice. */
  | 'payment_voucher_shared'
  /** 244x carries nothing for an invoice the reskontra says is open. */
  | 'no_liability_left'
  /** 244x is more than LEDGER_RATE_BAND away from remaining x exchange_rate. */
  | 'ledger_rate_mismatch'
  /**
   * More than MAX_PAYMENT_ROWS payment rows, or more storno hops than
   * CHAIN_HOP_BUDGET across the registration and payment vouchers: past what
   * one read (the preview runs on every keystroke) should resolve.
   */
  | 'ledger_history_too_long'

type InvoiceForSek = Pick<
  SupplierInvoice,
  'id' | 'currency' | 'exchange_rate' | 'paid_amount' | 'remaining_amount' | 'registration_journal_entry_id'
>

const AP_ACCOUNT_PREFIX = '244'
// Same 10% band as match_batch_allocate and link_supplier_invoice_to_voucher:
// outside it the SEK is not the invoice's skuld at another rate, it is a
// different skuld (the registration was corrected for something else).
// The migration voucher linker reads a rate difference by the same band.
export const LEDGER_RATE_BAND = 0.1
// Keeps an `in (...)` list well inside PostgREST's URL limit.
const ID_CHUNK = 100
// Fail-closed bounds on the work one resolution does, so a read-only preview
// cannot be made to walk an unbounded history. Far past any real invoice (a
// handful of part payments, a storno or two); beyond them the payment is
// refused with ledger_history_too_long and can still be booked with edited
// SEK rows or linked to an existing verifikat.
export const MAX_PAYMENT_ROWS = 50
export const CHAIN_HOP_BUDGET = 2 * MAX_CHAIN_WALK

function isSekInvoice(currency: string | null | undefined): boolean {
  return !currency || currency === 'SEK'
}

/**
 * Pure: the SEK a payment of `amount` (invoice currency) clears when the
 * invoice still owes `remaining` (invoice currency) and carries `remainingSek`
 * on 244x. A full settlement clears exactly `remainingSek`.
 */
export function prorateSupplierPaymentSek(opts: {
  amount: number
  remaining: number
  remainingSek: number
}): number {
  const { amount, remaining, remainingSek } = opts
  if (amount >= remaining - ORE_TOLERANCE) return roundOre(remainingSek)
  return roundOre((remainingSek * amount) / remaining)
}

/**
 * Pure: the cross-field rules of the SEK inputs, shared by every door so they
 * refuse the same requests. Returns the offending field and why, or null.
 */
export function supplierPaymentSekInputIssue(opts: {
  currency: string | null | undefined
  amountSek?: number
  exchangeRateDifference?: number
  hasLines?: boolean
}): { field: string; message: string } | null {
  if (opts.amountSek === undefined) return null
  if (isSekInvoice(opts.currency)) {
    return {
      field: 'amount_sek',
      message: 'amount_sek applies to foreign-currency invoices only: for a SEK invoice, amount is already in SEK.',
    }
  }
  if (opts.exchangeRateDifference !== undefined) {
    return {
      field: 'amount_sek',
      message:
        'Send amount_sek or exchange_rate_difference, not both: the kursdifferens is derived from amount_sek.',
    }
  }
  if (opts.hasLines) {
    return {
      field: 'amount_sek',
      message: 'amount_sek cannot be combined with lines: the edited rows already state every SEK amount.',
    }
  }
  return null
}

export type SupplierInvoiceRemainingSek =
  | { ok: true; remainingSek: number }
  | { ok: false; reason: SupplierPaymentSekUnresolvedReason }

/**
 * The SEK this invoice still carries on 244x, read off its linked vouchers:
 * the live registration's 244x credit minus the 244x debits of the invoice's
 * payment vouchers (each followed to its live correction when stornoed).
 * Company-scoped at every step, and bounded: at most MAX_PAYMENT_ROWS payment
 * rows and CHAIN_HOP_BUDGET storno hops, refused past either. Throws only on
 * a read error.
 */
export async function loadSupplierInvoiceRemainingSek(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Pick<SupplierInvoice, 'id' | 'paid_amount'> & { registration_journal_entry_id: string },
): Promise<SupplierInvoiceRemainingSek> {
  const registrationId = invoice.registration_journal_entry_id
  const budget = { hops: CHAIN_HOP_BUDGET }

  const liveRegistration = await liveEntryOf(supabase, companyId, registrationId, budget)
  if ('exhausted' in liveRegistration) return { ok: false, reason: 'ledger_history_too_long' }
  if ('none' in liveRegistration) return { ok: false, reason: 'registration_voucher_not_live' }
  const liveId = liveRegistration.id

  const { data: sharedRegistration, error: sharedRegistrationError } = await supabase
    .from('supplier_invoices')
    .select('id')
    .eq('company_id', companyId)
    .eq('registration_journal_entry_id', registrationId)
    .neq('id', invoice.id)
    .limit(1)
  if (sharedRegistrationError) throw dbError(sharedRegistrationError, 'supplier payment SEK: shared registration')
  if ((sharedRegistration ?? []).length > 0) return { ok: false, reason: 'registration_voucher_shared' }

  // One bounded read: one row past the cap says the history is too long.
  const { data: paymentRows, error: paymentsError } = await supabase
    .from('supplier_invoice_payments')
    .select('id, amount, journal_entry_id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', invoice.id)
    .order('id', { ascending: true })
    .limit(MAX_PAYMENT_ROWS + 1)
  if (paymentsError) throw dbError(paymentsError, 'supplier payment SEK: payment rows')
  const payments = (paymentRows ?? []) as Array<{ id: string; amount: number; journal_entry_id: string | null }>
  if (payments.length > MAX_PAYMENT_ROWS) return { ok: false, reason: 'ledger_history_too_long' }
  const paidPerRows = roundOre(payments.reduce((sum, p) => sum + Number(p.amount), 0))
  if (
    payments.some((p) => !p.journal_entry_id) ||
    Math.abs(paidPerRows - roundOre(Number(invoice.paid_amount ?? 0))) > ORE_TOLERANCE
  ) {
    return { ok: false, reason: 'payment_history_mismatch' }
  }
  // Two rows of this invoice on one voucher share its 244x debit: count it once.
  const paymentEntryIds = [...new Set(payments.map((p) => p.journal_entry_id as string))]
  if (paymentEntryIds.includes(registrationId) || paymentEntryIds.includes(liveId)) {
    return { ok: false, reason: 'payment_history_mismatch' }
  }

  // The vouchers whose 244x debits count: each payment voucher, or its live
  // correction when it was stornoed.
  const livePaymentEntryIds = new Set<string>()
  for (const ids of chunk(paymentEntryIds, ID_CHUNK)) {
    const entries = await fetchAllRows<{ id: string; status: string }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, status')
        .eq('company_id', companyId)
        .in('id', ids)
        .order('id', { ascending: true })
        .range(from, to),
    )
    const posted = new Set(entries.filter((e) => e.status === 'posted').map((e) => e.id))
    for (const id of ids) {
      const live: LiveEntry = posted.has(id) ? { id } : await liveEntryOf(supabase, companyId, id, budget)
      if ('exhausted' in live) return { ok: false, reason: 'ledger_history_too_long' }
      if ('none' in live) return { ok: false, reason: 'payment_voucher_not_posted' }
      if (live.id === liveId) return { ok: false, reason: 'payment_history_mismatch' }
      livePaymentEntryIds.add(live.id)
    }

    // A batch voucher settles several invoices with no line-level link to
    // each: its 244x debit cannot be attributed to this one.
    const { data: shared, error: sharedError } = await supabase
      .from('supplier_invoice_payments')
      .select('id')
      .eq('company_id', companyId)
      .in('journal_entry_id', ids)
      .neq('supplier_invoice_id', invoice.id)
      .limit(1)
    if (sharedError) throw dbError(sharedError, 'supplier payment SEK: shared payment voucher')
    if ((shared ?? []).length > 0) return { ok: false, reason: 'payment_voucher_shared' }
  }

  // Only ids verified in this company above reach the line read.
  const lines = await fetchLinesByEntryIds<{
    id: string
    journal_entry_id: string
    debit_amount: number
    credit_amount: number
  }>(
    supabase,
    [liveId, ...livePaymentEntryIds],
    'id, journal_entry_id, debit_amount, credit_amount',
    (q) => q.like('account_number', `${AP_ACCOUNT_PREFIX}%`),
  )
  let carried = 0
  for (const line of lines) {
    carried += Number(line.credit_amount) - Number(line.debit_amount)
  }
  const remainingSek = roundOre(carried)
  if (remainingSek <= 0) return { ok: false, reason: 'no_liability_left' }
  return { ok: true, remainingSek }
}

export interface SupplierPaymentSekInput {
  /** The payment in the invoice's currency. */
  amount: number
  /** SEK that left the payment account; defaults to the SEK cleared. */
  amountSek?: number
  /** Legacy v1 input: SEK cleared minus SEK paid. Never together with amountSek. */
  exchangeRateDifference?: number
  /**
   * The SEK on 244x of a registration the settlement books first
   * (lib/supplier-invoices/registration-first.ts), read off the Bokför dry
   * run: the skuld the ledger will carry once it posts. Used in place of the
   * invoice's rate while no registration is linked yet, so the clearing takes
   * exactly what the registration credits, per-line rounding included.
   */
  pendingRegistrationPayableSek?: number
}

export type SupplierPaymentSekResult =
  | {
      ok: true
      /** SEK cleared off 2440: buildSupplierInvoicePaymentLines' paymentAmount. */
      clearingSek: number
      /**
       * SEK cleared minus SEK paid: > 0 kursvinst (3960), < 0 kursförlust
       * (7960), undefined for none. The builder's exchangeRateDifference.
       */
      exchangeRateDifference?: number
    }
  | {
      ok: false
      code: typeof SI_PAID_SEK_UNRESOLVED | 'SI_FX_RATE_MISSING'
      details: Record<string, unknown>
    }

/**
 * The SEK inputs of the 2440 clearing verifikat for a manual payment: what
 * the dashboard route, its preview and the v1 route hand
 * createSupplierInvoicePaymentEntry / buildSupplierInvoicePaymentLines, so
 * the preview shows what gets booked. Validate the inputs with
 * supplierPaymentSekInputIssue first.
 */
export async function resolveSupplierPaymentSek(
  supabase: SupabaseClient,
  companyId: string,
  invoice: InvoiceForSek,
  input: SupplierPaymentSekInput,
): Promise<SupplierPaymentSekResult> {
  if (isSekInvoice(invoice.currency)) {
    // Unchanged: the amount is SEK already.
    return {
      ok: true,
      clearingSek: input.amount,
      exchangeRateDifference: input.exchangeRateDifference || undefined,
    }
  }

  const remaining = Number(invoice.remaining_amount)
  let clearingSek: number
  if (!invoice.registration_journal_entry_id && input.pendingRegistrationPayableSek !== undefined) {
    clearingSek = prorateSupplierPaymentSek({
      amount: input.amount,
      remaining,
      remainingSek: input.pendingRegistrationPayableSek,
    })
  } else if (!invoice.registration_journal_entry_id) {
    const rate = Number(invoice.exchange_rate)
    if (!(rate > 0)) {
      return { ok: false, code: 'SI_FX_RATE_MISSING', details: { invoice_currency: invoice.currency } }
    }
    clearingSek = roundOre(input.amount * rate)
  } else {
    const ledger = await loadSupplierInvoiceRemainingSek(supabase, companyId, {
      id: invoice.id,
      paid_amount: invoice.paid_amount,
      registration_journal_entry_id: invoice.registration_journal_entry_id,
    })
    if (!ledger.ok) {
      return {
        ok: false,
        code: SI_PAID_SEK_UNRESOLVED,
        details: { reason: ledger.reason, invoice_currency: invoice.currency },
      }
    }
    // The ledger is exact, but only for the skuld the invoice describes. A gap
    // to the invoice's own rate beyond the band is not a rate movement (a
    // bank-matched part payment clears booked SEK plus a kursdifferens, so it
    // keeps the two in step): refuse it rather than book it as one.
    const rate = Number(invoice.exchange_rate)
    if (rate > 0) {
      const expectedSek = roundOre(remaining * rate)
      if (Math.abs(ledger.remainingSek - expectedSek) > expectedSek * LEDGER_RATE_BAND) {
        return {
          ok: false,
          code: SI_PAID_SEK_UNRESOLVED,
          details: {
            reason: 'ledger_rate_mismatch' satisfies SupplierPaymentSekUnresolvedReason,
            invoice_currency: invoice.currency,
            expected_sek: expectedSek,
            ledger_sek: ledger.remainingSek,
          },
        }
      }
    }
    clearingSek = prorateSupplierPaymentSek({
      amount: input.amount,
      remaining,
      remainingSek: ledger.remainingSek,
    })
  }

  const difference =
    input.amountSek !== undefined
      ? roundOre(clearingSek - input.amountSek)
      : (input.exchangeRateDifference ?? 0)
  return {
    ok: true,
    clearingSek,
    exchangeRateDifference: difference !== 0 ? difference : undefined,
  }
}
