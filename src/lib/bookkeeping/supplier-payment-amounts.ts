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
 *   - Foreign invoice with a registration verifikat: the ledger, as
 *     lib/bookkeeping/ledger-carried-sek.ts reads it. A full settlement clears
 *     exactly what the invoice carries, so no öre is stranded; a part payment
 *     clears its share of it. The rate is never used here: it cannot reproduce
 *     the registration's per-line rounding, a rättelse that changed the skuld,
 *     or the SEK an earlier bank match cleared.
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
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { carriedSek, clearedSek } from '@/lib/bookkeeping/ledger-carried-sek'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'
import type { SupplierInvoice } from '@/types'

export const SI_PAID_SEK_UNRESOLVED = 'SI_PAID_SEK_UNRESOLVED' as const

type InvoiceForSek = Pick<
  SupplierInvoice,
  'id' | 'currency' | 'exchange_rate' | 'paid_amount' | 'remaining_amount' | 'registration_journal_entry_id'
>

function isSekInvoice(currency: string | null | undefined): boolean {
  return !currency || currency === 'SEK'
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
    clearingSek = clearedSek({
      amount: input.amount,
      remaining,
      carried: input.pendingRegistrationPayableSek,
      rate: Number(invoice.exchange_rate),
    })
  } else if (!invoice.registration_journal_entry_id) {
    const rate = Number(invoice.exchange_rate)
    if (!(rate > 0)) {
      return { ok: false, code: 'SI_FX_RATE_MISSING', details: { invoice_currency: invoice.currency } }
    }
    clearingSek = sekOfForeign(input.amount, rate)
  } else {
    const ledger = await carriedSek(supabase, companyId, 'supplier', invoice.id)
    if (!ledger.ok) {
      const { ok: _ok, ...unresolved } = ledger
      return {
        ok: false,
        code: SI_PAID_SEK_UNRESOLVED,
        details: { ...unresolved, invoice_currency: invoice.currency },
      }
    }
    clearingSek = clearedSek({
      amount: input.amount,
      remaining,
      carried: ledger.sek,
      rate: Number(invoice.exchange_rate),
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
