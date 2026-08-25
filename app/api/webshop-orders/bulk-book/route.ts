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
} from '@/lib/webshop-orders/booking-lines'
import {
  assertOrderBookable,
  bookOrderThroughEngine,
  resolveOrderFx,
} from '@/lib/webshop-orders/book-order'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

ensureInitialized()

interface BulkBookFailure {
  code: string
  message: string
  message_en: string
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
function failureFromCode(code: string): BulkBookFailure {
  const entry = getErrorEntry(code)
  return {
    code,
    message: entry?.message_sv ?? code,
    message_en: entry?.message_en ?? code,
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
 * Partial failure is expected and reported per order: one refused row (period
 * locked, raced booking, unresolved FX) never aborts the rest of the batch.
 * The response is 200 with results[] as long as the request itself was valid
 * and at least one requested order exists for the company.
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
    // like the single-order dialog. A fetch failure falls back to the default
    // clearing account rather than aborting the sweep.
    let settingsRows: WebshopStoreSettings[] = []
    const { data: settingsData, error: settingsError } = await supabase
      .from('webshop_store_settings')
      .select('*')
      .eq('company_id', companyId)
    if (settingsError) {
      log.warn('bulk-book settings fetch failed; using default accounts', settingsError)
    } else {
      settingsRows = (settingsData ?? []) as WebshopStoreSettings[]
    }
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
          error: failureFromCode(guardFailure.code),
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
          settings: settingsFor(resolvedOrder),
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
