import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BulkBookWebshopOrdersSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  buildOrderBookingLines,
  orderBookingDescription,
  resolvePaymentAccount,
  ROUNDING_ACCOUNT,
} from '@/lib/webshop-orders/booking-lines'
import {
  assertOrderBookable,
  bookOrderThroughEngine,
  resolveOrderFx,
} from '@/lib/webshop-orders/book-order'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

ensureInitialized()

// Up to 50 sequential draft -> claim -> commit round trips against the
// engine; the default function window is not guaranteed to fit them, and a
// kill between claim and commit would leave an order pointing at an
// uncommitted draft (skeptic finding). Same budget as the other batch routes.
export const maxDuration = 300

/**
 * A residual on 3740 above this magnitude (SEK) is not öresavrundning: it
 * means the order's gross total does not match its VAT breakdown (gift
 * cards, plugin-mangled orders). Legitimate per-bucket öre rounding and FX
 * drift stay well below this; anything above needs the single-order dialog
 * where the user sees the line.
 */
const MAX_RESIDUAL_SEK = 1

interface BulkBookFailure {
  code: string
  message: string
  message_en: string
  details?: Record<string, unknown>
}

interface BulkBookOrderResult {
  order_id: string
  order_number: string | null
  success: boolean
  journal_entry_id?: string
  voucher_series?: string | null
  voucher_number?: number | null
  error?: BulkBookFailure
}

/** Failure envelope for a known structured-error code. */
function failureFromCode(
  code: string,
  details?: Record<string, unknown>,
): BulkBookFailure {
  const entry = getErrorEntry(code)
  return {
    code,
    message: entry?.message_sv ?? code,
    message_en: entry?.message_en ?? code,
    ...(details ? { details } : {}),
  }
}

/** Failure envelope for a thrown (usually typed bookkeeping) error. */
function failureFromError(err: unknown): BulkBookFailure {
  const code =
    (typeof err === 'object' &&
      err !== null &&
      typeof (err as { code?: unknown }).code === 'string' &&
      (err as { code: string }).code) ||
    'WEBSHOP_ORDER_BOOKING_FAILED'
  return {
    code,
    message: getErrorMessage(err, { context: 'transaction' }),
    message_en: getErrorMessage(err, { context: 'transaction', locale: 'en' }),
  }
}

/**
 * POST /api/webshop-orders/bulk-book
 *
 * Book N selected webshop order/refund rows in one sweep, each with the
 * standard order template: payment account (per-store payment-method mapping,
 * or the optional payment_account override) against revenue + output VAT per
 * rate from the row's own vat_breakdown.
 *
 * Deliberately NOT a samlingsverifikation: every order books as its OWN
 * verifikat through the exact same flow as POST /api/webshop-orders/[id]/book
 * (lib/webshop-orders/book-order.ts): state guards, booking-time FX retry,
 * chart repair, race-free draft -> claim -> commit through the engine. So
 * period locks, balance, voucher numbering and anything later added to the
 * single-order path (e.g. underlag anchoring) apply per order automatically.
 *
 * The sweep has no reviewing user, so it only books orders whose lines are
 * DERIVED, never guessed: rows with an empty vat_breakdown (ratio-inferred
 * fallback), invoice-mode payment methods, or a 3740 residual above öre
 * scale are refused per order and pointed at the single-order dialog.
 *
 * Partial failure is expected and reported per order: one refused row (period
 * locked, raced booking, unresolved FX, review-needed) never aborts the rest
 * of the batch. The response is 200 with results[] as long as the request
 * itself was valid and at least one requested order exists for the company.
 */
export const POST = withRouteContext(
  'webshop_order.bulk_book',
  async (request, { supabase, user, companyId, log, requestId }) => {
    const validation = await validateBody(request, BulkBookWebshopOrdersSchema)
    if (!validation.success) return validation.response
    const { order_ids, payment_account } = validation.data

    // Dedupe but keep the caller's order for the result list.
    const ids = [...new Set(order_ids)]

    const { data: orders, error: fetchError } = await supabase
      .from('webshop_orders')
      .select('*')
      .in('id', ids)
      .eq('company_id', companyId)
    if (fetchError) {
      log.error('bulk-book order fetch failed', fetchError)
      return NextResponse.json(
        { error: getErrorMessage(fetchError, { context: 'transaction' }) },
        { status: 500 },
      )
    }
    const orderById = new Map<string, WebshopOrder>(
      ((orders ?? []) as WebshopOrder[]).map((o) => [o.id, o]),
    )
    if (orderById.size === 0) {
      return errorResponseFromCode('WEBSHOP_ORDER_NOT_FOUND', log, { requestId })
    }

    // Per-store settings drive the payment-method -> account prefill exactly
    // like the single-order dialog. A fetch failure ABORTS the sweep: falling
    // back to the default clearing account here would silently book every
    // order against 1686 while the user just confirmed a dialog showing their
    // mapped accounts (skeptic finding). Failing loudly is recoverable;
    // fifty wrong immutable verifikat are not.
    const { data: settingsData, error: settingsError } = await supabase
      .from('webshop_store_settings')
      .select('*')
      .eq('company_id', companyId)
    if (settingsError) {
      log.error('bulk-book settings fetch failed; aborting sweep', settingsError)
      return NextResponse.json(
        { error: getErrorMessage(settingsError, { context: 'transaction' }) },
        { status: 500 },
      )
    }
    const settingsRows = (settingsData ?? []) as WebshopStoreSettings[]
    const settingsFor = (order: WebshopOrder): WebshopStoreSettings | null =>
      settingsRows.find(
        (s) => s.platform === order.platform && s.store_scope === order.store_scope,
      ) ?? null

    // Sequential on purpose: each order is its own draft -> claim -> commit
    // round trip through the engine, and voucher numbers are assigned
    // atomically per commit. Parallelizing would only contend on the same
    // voucher sequence; 50 orders (the schema cap) stay well inside the
    // route budget.
    const results: BulkBookOrderResult[] = []
    for (const id of ids) {
      const order = orderById.get(id)
      if (!order) {
        results.push({
          order_id: id,
          order_number: null,
          success: false,
          error: failureFromCode('WEBSHOP_ORDER_NOT_FOUND'),
        })
        continue
      }

      const guardFailure = await assertOrderBookable(supabase, companyId, order)
      if (guardFailure) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode(guardFailure.code, guardFailure.details),
        })
        continue
      }

      // No VAT breakdown from the store: buildOrderBookingLines would fall
      // back to a ratio-INFERRED single bucket, which the single-order dialog
      // shows as an editable guess for the user to correct. There is no
      // reviewing user in a sweep, so a guessed rate split must never become
      // an immutable verifikat here (skeptic finding: a 25%+6% mixed sale
      // classified as 12% books wrong revenue/VAT accounts and rutor, and an
      // amount-only refund would reverse zero moms via 3004).
      if (order.vat_breakdown.length === 0) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode('WEBSHOP_ORDER_VAT_BREAKDOWN_MISSING'),
        })
        continue
      }

      const settings = settingsFor(order)
      // The store's own mapping routes this payment method through the
      // invoice flow. Booking it directly would both post a wrong clearing
      // leg and permanently foreclose Skapa faktura for the order (the claim
      // sets journal_entry_id). The override does not bypass this: it
      // changes the account, not the flow the merchant configured.
      if (resolvePaymentAccount(order, settings).invoiceMode) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode('WEBSHOP_ORDER_INVOICE_MODE_METHOD'),
        })
        continue
      }

      const resolvedOrder = await resolveOrderFx(supabase, companyId, order, log)
      if (!resolvedOrder) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode('WEBSHOP_ORDER_FX_UNRESOLVED'),
        })
        continue
      }

      const entryDate = resolvedOrder.paid_date ?? resolvedOrder.order_date
      const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, entryDate)
      if (!fiscalPeriodId) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode('NO_OPEN_PERIOD_FOR_DATE'),
        })
        continue
      }

      let lines
      try {
        lines = buildOrderBookingLines({
          order: resolvedOrder,
          settings,
          paymentAccount: payment_account,
        })
      } catch (err) {
        // buildOrderBookingLines throws only on an unresolved SEK amount,
        // which resolveOrderFx already excluded; belt-and-braces per order.
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromError(err),
        })
        continue
      }

      // Residual bound: the 3740 line exists to absorb öre rounding and FX
      // drift, both bounded by a few öre per bucket. A residual above
      // MAX_RESIDUAL_SEK means the gross total and the VAT breakdown
      // disagree (gift-card redemptions, mangled orders); in the single
      // dialog the user sees the fat 3740 line and stops, so the sweep must
      // refuse instead of booking the gap as "öresavrundning".
      const residualLine = lines.find((l) => l.account_number === ROUNDING_ACCOUNT)
      const residualAbs = residualLine
        ? Math.max(residualLine.debit_amount || 0, residualLine.credit_amount || 0)
        : 0
      if (residualAbs > MAX_RESIDUAL_SEK) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error: failureFromCode('WEBSHOP_ORDER_RESIDUAL_TOO_LARGE', {
            residual: residualAbs,
          }),
        })
        continue
      }

      const outcome = await bookOrderThroughEngine(
        supabase,
        companyId,
        user.id,
        id,
        {
          fiscal_period_id: fiscalPeriodId,
          entry_date: entryDate,
          description: orderBookingDescription(resolvedOrder),
          lines,
        },
        log,
      )

      if (!outcome.ok) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error:
            outcome.kind === 'claimed_elsewhere'
              ? failureFromCode('WEBSHOP_ORDER_ALREADY_BOOKED')
              : failureFromError(outcome.error),
        })
        continue
      }

      results.push({
        order_id: id,
        order_number: order.order_number,
        success: true,
        journal_entry_id: outcome.journalEntryId,
        voucher_series: outcome.journalEntry?.voucher_series ?? null,
        voucher_number: outcome.journalEntry?.voucher_number ?? null,
      })
    }

    const bookedCount = results.filter((r) => r.success).length
    return NextResponse.json({
      data: {
        results,
        booked_count: bookedCount,
        failed_count: results.length - bookedCount,
      },
      success: true,
    })
  },
  { requireWrite: true },
)
