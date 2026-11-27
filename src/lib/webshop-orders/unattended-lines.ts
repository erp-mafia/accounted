import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import type { MomsBox } from '@/lib/vat/moms-box-mapping'
import type {
  CreateJournalEntryLineInput,
  WebshopOrder,
  WebshopStoreSettings,
} from '@/types'
import { assertOrderBookable, resolveOrderFx } from './book-order'
import { isCancelledWithoutRefund } from './booking-status'
import {
  buildOrderBooking,
  resolvePaymentAccount,
  routeOrder,
  unsupportedSwedishRates,
  type OrderBooking,
} from './booking-lines'
import { usesRevenueTemplate } from './country-routing'

/**
 * The lines an order books with when no person reviews them: the bulk sweep
 * (one verifikat per order) and the day booking (one verifikat per day and
 * payment method) both derive each order's lines here, so the two can never
 * disagree on which orders a machine may book.
 *
 * An order the store cancelled without a refund is refused too
 * (WEBSHOP_ORDER_CANCELLED_IN_STORE): it is voided or booked by a person.
 *
 * Only DERIVED lines pass, never guessed ones: an empty vat_breakdown (the
 * ratio-inferred fallback), a destination outside Sweden the store's country
 * rules do not cover, a missing destination in a store with rules, a
 * non-Swedish rate on the Swedish accounts, an invoice-mode payment method,
 * an unresolved exchange rate, or a gap between the gross total and the VAT
 * breakdown above MAX_RESIDUAL_SEK is refused per order and pointed at the
 * single-order dialog, where a person sees the lines.
 */

export type UnattendedLinesOutcome =
  /** order is the row with its exchange rate resolved. */
  | { ok: true; order: WebshopOrder; lines: CreateJournalEntryLineInput[] }
  /** A refusal with a structured-error code. */
  | { ok: false; code: string; details?: Record<string, unknown> }
  /** buildOrderBooking threw; the caller maps the error. */
  | { ok: false; code: null; error: unknown }

export interface UnattendedLinesInput {
  supabase: SupabaseClient
  companyId: string
  order: WebshopOrder
  settings: WebshopStoreSettings | null
  log: Logger
  /** Override of the payment counter-account (the bulk dialog's choice). */
  paymentAccount?: string
  /** The bulk dialog's revenue template, per Swedish VAT rate. */
  revenueAccounts?: Partial<Record<number, string>>
  /**
   * The bulk template's 0 % account and whether the order's country
   * contradicts its momsdeklaration box (#1912). Only the bulk template
   * chooses a 0 % account; without it nothing is checked.
   */
  zeroRate?: {
    account: string
    box: MomsBox | null
    contradicted: (country: string) => boolean
  }
  /** false (a dry run) resolves a missing exchange rate without storing it. */
  persistFx?: boolean
}

export async function deriveUnattendedOrderLines(
  input: UnattendedLinesInput,
): Promise<UnattendedLinesOutcome> {
  const { supabase, companyId, order, settings, log } = input

  const guardFailure = await assertOrderBookable(supabase, companyId, order)
  if (guardFailure) {
    return {
      ok: false,
      code: guardFailure.code,
      ...(guardFailure.details ? { details: guardFailure.details } : {}),
    }
  }

  // The store cancelled the order and refunded nothing on it: a machine
  // cannot tell a payment that was never taken from money the shop kept, so
  // the order never books as a sale here. A person voids it on the Orders
  // page or books it in the single-order dialog.
  if (isCancelledWithoutRefund(order)) {
    return { ok: false, code: 'WEBSHOP_ORDER_CANCELLED_IN_STORE' }
  }

  // No VAT breakdown from the store: buildOrderBookingLines would fall
  // back to a ratio-INFERRED single bucket, which the single-order dialog
  // shows as an editable guess for the user to correct. There is no
  // reviewing user here, so a guessed rate split must never become an
  // immutable verifikat (skeptic finding: a 25%+6% mixed sale classified as
  // 12% books wrong revenue/VAT accounts and rutor, and an amount-only
  // refund would reverse zero moms via 3004).
  if (order.vat_breakdown.length === 0) {
    return { ok: false, code: 'WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING' }
  }

  // Destination outside Sweden (crm#1032): the store's country rules must
  // cover every VAT bucket. A Danish or Norwegian order at 25 % used to pass
  // the rate guard below and book as Swedish sales on 3001 and Swedish output
  // VAT on 2611 (rutor 05 and 10); now it waits for a rule or the single
  // dialog, where the user sees the lines.
  const routing = routeOrder(order, settings)
  if (routing.unroutedRates.length > 0) {
    return {
      ok: false,
      code: 'WEBSHOP_ORDER_COUNTRY_NOT_ROUTED',
      details: { customer_country: routing.country, rates: routing.unroutedRates },
    }
  }

  // No destination country on a Shopify order whose store has country rules
  // (withheld addresses, local pickup, rows synced before the country was
  // stored). The store sells abroad, so the missing country is unknown, not
  // Sweden: booking it on 3001/2611 would be a guess.
  if (routing.destinationUnknown) {
    return { ok: false, code: 'WEBSHOP_ORDER_COUNTRY_UNKNOWN' }
  }

  // A bucket on the Swedish accounts with a non-Swedish rate (e.g. a German
  // 19% OSS bucket no country rule books) would silently fall back to the
  // 25% accounts and book foreign VAT as Swedish utgaende moms. Only the
  // single dialog may show that as an editable prefill (skeptic finding). A
  // bucket a country rule books may carry any rate.
  const badRates = unsupportedSwedishRates(routing)
  if (badRates.length > 0) {
    return { ok: false, code: 'WEBSHOP_ORDER_UNSUPPORTED_VAT_RATE', details: { rates: badRates } }
  }

  if (input.zeroRate && order.customer_country) {
    const country = order.customer_country.toUpperCase()
    // Only the buckets the template books: a 0 % bucket a country rule
    // routes (export on 3105) never reaches the 0 % template account.
    const hasZeroRateAmount = routing.buckets
      .filter(usesRevenueTemplate)
      .some(({ bucket }) => bucket.rate === 0 && bucket.net !== 0)
    if (hasZeroRateAmount && input.zeroRate.contradicted(country)) {
      return {
        ok: false,
        code: 'WEBSHOP_ORDER_ZERO_RATE_CONTEXT_MISMATCH',
        details: { account: input.zeroRate.account, box: input.zeroRate.box, customer_country: country },
      }
    }
  }

  // The store's own mapping routes this payment method through the invoice
  // flow. Booking it directly would both post a wrong clearing leg and
  // permanently foreclose Skapa faktura for the order (the claim sets
  // journal_entry_id). An account override does not bypass this: it changes
  // the account, not the flow the merchant configured.
  if (resolvePaymentAccount(order, settings).invoiceMode) {
    return { ok: false, code: 'WEBSHOP_ORDER_INVOICE_MODE_METHOD' }
  }

  const resolvedOrder = await resolveOrderFx(supabase, companyId, order, log, {
    persist: input.persistFx ?? true,
  })
  if (!resolvedOrder) {
    return { ok: false, code: 'WEBSHOP_ORDER_FX_UNRESOLVED' }
  }

  let booking: OrderBooking
  try {
    booking = buildOrderBooking({
      order: resolvedOrder,
      settings,
      paymentAccount: input.paymentAccount,
      revenueAccounts: input.revenueAccounts,
    })
  } catch (err) {
    // buildOrderBooking throws only on an unresolved SEK amount, which
    // resolveOrderFx already excluded; belt-and-braces per order.
    return { ok: false, code: null, error: err }
  }

  // A gap above MAX_RESIDUAL_SEK means the gross total and the VAT breakdown
  // disagree (missing shipping tax, gift cards, mangled orders). The builder
  // either splits it at the order's one rate or leaves it out; both need a
  // person, so an unattended booking refuses instead.
  if (booking.gap) {
    return { ok: false, code: 'WEBSHOP_ORDER_RESIDUAL_TOO_LARGE', details: { residual: Math.abs(booking.gap.amount) } }
  }
  const { lines } = booking

  return { ok: true, order: resolvedOrder, lines }
}
