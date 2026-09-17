/**
 * Exchange-rate resolution for supplier-invoice WRITE paths.
 *
 * Every surface that creates a `supplier_invoices` row goes through here:
 *
 *   - POST /api/supplier-invoices                              (cookie session)
 *   - POST /api/v1/companies/{id}/supplier-invoices            (API key / agents)
 *   - POST /api/extensions/ext/invoice-inbox/items/{id}/convert (inbox)
 *
 * Sharing ONE resolver is what keeps them in agreement: the currency policy,
 * the SEK column arithmetic and the "no rate" refusal are defined once, so a
 * surface cannot drift into storing a NULL rate again.
 *
 * Why this exists
 * ---------------
 * All three sites used to take `body.exchange_rate ?? null` with no fetch and
 * no validation, so a foreign-currency invoice was persisted with
 * `exchange_rate = NULL` whenever the caller simply omitted the field (an
 * agent, an MCP call, or the web form when its client-side rate lookup
 * silently failed). Nothing repaired the row afterwards, and the booking path
 * (lib/bookkeeping/supplier-invoice-entries.ts) now REFUSES such an invoice
 * with SI_FX_RATE_MISSING rather than posting it at a fabricated 1:1 rate,
 * which under omvänd skattskyldighet would understate the fiktiv moms on
 * 2614/2645 and therefore rutorna 20-24 + 30-32 of the momsdeklaration.
 *
 * So the rate has to be resolved at CREATE time, where the user still has the
 * invoice in front of them.
 *
 * Legal basis for the rate itself
 * -------------------------------
 * ML 8 kap 21-23 § allows two sources for translating a foreign-currency
 * beskattningsunderlag to SEK: the Nasdaq OMX Stockholm mid-rate published by
 * Riksbanken, or the latest published ECB rate; one source, used
 * consistently. `fetchExchangeRate` reads Riksbanken's SWEA series, so we stay
 * on the first of the two for every invoice.
 *
 * Rate date: we use the invoice date, which is also the date the registration
 * verifikat is posted on and the date the period-lock check runs against, so
 * the money and the verifikat can never be anchored on two different days.
 * ML 8 kap 21 § points at the taxable event (leveransdatum) when that differs
 * from the invoice date; `supplier_invoices.delivery_date` would be the
 * stricter anchor in that case. Deliberately NOT used here: it would split the
 * anchor from the verifikat date for a minority of rows. Flagged as an open
 * refinement rather than changed silently.
 *
 * Failure semantics
 * -----------------
 * `fetchExchangeRate` already degrades gracefully (persistent `exchange_rates`
 * cache first, 7-day look-back for weekends/holidays, then the most recent
 * cached observation on or before the date) and returns null ONLY when there
 * is no observation to be had. It never invents a number. When it returns
 * null we report `ok: false` and the caller rejects the create: storing NULL
 * would only relocate the same failure to the booking step, where the user no
 * longer has the invoice in hand.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import { roundOre } from '@/lib/money'
import { CURRENCIES, type Currency } from '@/types'

/** Currencies Riksbanken's SWEA series cover (mirrors lib/currency/riksbanken.ts). */
const SUPPORTED_CURRENCIES: ReadonlySet<string> = new Set(CURRENCIES)

/**
 * Upper plausibility bound for a caller-supplied rate. Same value as the
 * module-local MAX_PLAUSIBLE_FX_RATE in lib/bookkeeping/invoice-payment-lines.ts
 * (which mirrors the match_batch_allocate RPC's 0 < rate < 100000 guard): a
 * rate that far out is as unusable as NULL, and accepting it here would store
 * total_sek at an absurd multiple that the booking path then posts verbatim.
 */
const MAX_PLAUSIBLE_FX_RATE = 100000

export interface ResolvedSupplierInvoiceRate {
  /** Normalised ISO code actually used ('SEK' when the caller omitted one). */
  currency: string
  /**
   * Multiplier from invoice currency to SEK. Always 1 for a SEK invoice, so
   * `*_sek` columns equal their invoice-currency counterparts instead of
   * staying NULL.
   */
  rate: number
  /**
   * Value for `supplier_invoices.exchange_rate`. NULL for a SEK invoice: the
   * column means "rate this foreign invoice was translated at", and 1 SEK =
   * 1 SEK is not a rate. Never NULL for a foreign invoice.
   */
  exchangeRate: number | null
  /**
   * Value for `supplier_invoices.exchange_rate_date`: the observation date of
   * the rate actually used, which is what makes the SEK amounts verifiable
   * under BFL 5 kap. Null for SEK, and null for a caller-supplied rate whose
   * source we cannot vouch for.
   */
  exchangeRateDate: string | null
  /** Where the rate came from. Diagnostics only; never affects the arithmetic. */
  source: 'sek' | 'supplied' | 'fetched'
}

export type SupplierInvoiceRateResult =
  | { ok: true; rate: ResolvedSupplierInvoiceRate }
  | { ok: false; currency: string; invoiceDate: string }

export interface SupplierInvoiceRateInput {
  /** `body.currency`; undefined/null means SEK (matches the column default). */
  currency?: string | null
  /** ISO `YYYY-MM-DD` invoice date; the rate is fetched for this day. */
  invoiceDate: string
  /** `body.exchange_rate` when the caller supplied one. */
  suppliedRate?: number | null
}

/**
 * Resolve the exchange rate for a supplier invoice about to be written.
 *
 * Order:
 *   1. SEK invoice        → rate 1, no stored exchange_rate.
 *   2. Caller supplied a positive rate below MAX_PLAUSIBLE_FX_RATE → trust it
 *      (the web form pre-fills it from /api/currency/rate, and a user who read
 *      the rate off the invoice must be able to override us). A rate at or
 *      above the bound is refused, not silently replaced by a fetch.
 *   3. Otherwise          → fetch from Riksbanken for the invoice date, WITH
 *      the supabase client so the shared `exchange_rates` cache is consulted
 *      and populated. Same call shape as lib/transactions/ingest.ts.
 *   4. Fetch produced nothing → `{ ok: false }`; the caller must refuse the
 *      create (SI_FX_RATE_MISSING).
 *
 * Never throws: a network failure inside `fetchExchangeRate` is already caught
 * there and surfaces as null, and anything unexpected is folded into the same
 * `ok: false` refusal rather than a 500.
 */
export async function resolveSupplierInvoiceExchangeRate(
  supabase: SupabaseClient,
  input: SupplierInvoiceRateInput,
): Promise<SupplierInvoiceRateResult> {
  const currency = input.currency || 'SEK'

  if (currency === 'SEK') {
    return {
      ok: true,
      rate: {
        currency,
        rate: 1,
        exchangeRate: null,
        exchangeRateDate: null,
        source: 'sek',
      },
    }
  }

  const supplied = input.suppliedRate
  if (supplied != null && Number.isFinite(supplied) && supplied > 0) {
    // Implausibly large rates are refused outright rather than silently
    // replaced by a fetched one: the caller explicitly stated a rate, so a
    // fat-fingered 100000+ must bounce back for correction, not be swapped
    // for a number the user never saw. Non-positive/absent values keep the
    // existing fall-through-to-fetch behaviour (the web form's empty field).
    if (supplied >= MAX_PLAUSIBLE_FX_RATE) {
      return { ok: false, currency, invoiceDate: input.invoiceDate }
    }
    return {
      ok: true,
      rate: {
        currency,
        rate: supplied,
        exchangeRate: supplied,
        exchangeRateDate: null,
        source: 'supplied',
      },
    }
  }

  // Unknown ISO code: no Riksbanken series exists, so there is nothing to
  // fetch. Refuse rather than let the row through unconverted.
  if (!SUPPORTED_CURRENCIES.has(currency)) {
    return { ok: false, currency, invoiceDate: input.invoiceDate }
  }

  const parsedDate = new Date(input.invoiceDate)
  if (Number.isNaN(parsedDate.getTime())) {
    return { ok: false, currency, invoiceDate: input.invoiceDate }
  }

  let fetched: Awaited<ReturnType<typeof fetchExchangeRate>> = null
  try {
    fetched = await fetchExchangeRate(currency as Currency, parsedDate, supabase)
  } catch {
    // fetchExchangeRate swallows its own network errors, but a caller-supplied
    // mock or a future refactor could throw: treat it as "no rate", never as
    // a reason to guess one.
    fetched = null
  }

  if (!fetched || !Number.isFinite(fetched.rate) || fetched.rate <= 0) {
    return { ok: false, currency, invoiceDate: input.invoiceDate }
  }

  return {
    ok: true,
    rate: {
      currency,
      rate: fetched.rate,
      exchangeRate: fetched.rate,
      exchangeRateDate: fetched.date ?? null,
      source: 'fetched',
    },
  }
}

/**
 * The three SEK columns on `supplier_invoices`, computed from one resolved
 * rate so every write path produces identical numbers.
 *
 * A SEK invoice resolves to rate 1, so `total_sek === total`. That is the
 * whole of the second fix: the old `exchangeRate ? … : null` guard left
 * `total_sek` NULL for every ordinary Swedish supplier invoice, because a SEK
 * invoice legitimately has no exchange rate. Readers that report in SEK (the
 * KPI "Största leverantörer" panel among them) then saw nothing at all.
 */
export function supplierInvoiceSekAmounts(
  rate: ResolvedSupplierInvoiceRate,
  amounts: { subtotal: number; vatAmount: number; total: number },
): { subtotal_sek: number; vat_amount_sek: number; total_sek: number } {
  return {
    subtotal_sek: roundOre(amounts.subtotal * rate.rate),
    vat_amount_sek: roundOre(amounts.vatAmount * rate.rate),
    total_sek: roundOre(amounts.total * rate.rate),
  }
}
