import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { BulkBookWebshopOrdersSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { findFiscalPeriod } from '@/lib/bookkeeping/engine'
import {
  orderBookingDescription,
  DEFAULT_REVENUE_ACCOUNT_BY_RATE,
  WEBSHOP_PREFILL_ACCOUNTS,
} from '@/lib/webshop-orders/booking-lines'
import { deriveUnattendedOrderLines } from '@/lib/webshop-orders/unattended-lines'
import {
  resolveEffectiveVatRate,
  resolveRevenueVatBox,
} from '@/lib/reports/vat-revenue-accounts'
import { getBoxForAccount, type MomsBox } from '@/lib/vat/moms-box-mapping'
import { isEuMemberCountry } from '@/lib/vat/eu-countries'
import { bookOrderThroughEngine } from '@/lib/webshop-orders/book-order'
import type { WebshopOrder, WebshopStoreSettings } from '@/types'

// Up to 50 sequential draft -> claim -> commit round trips against the
// engine; the default function window is not guaranteed to fit them, and a
// kill between claim and commit would leave an order pointing at an
// uncommitted draft (skeptic finding). Same budget as the other batch routes.
export const maxDuration = 300

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
  /** Orderunderlag PDF archived on the verifikat (#1881); never fatal. */
  underlag_archived?: boolean
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
 * rate from the row's own vat_breakdown. The optional revenue_accounts map
 * (the "bokföringsmall") routes the revenue side per rate to a chosen class 3
 * account instead of the standard 3001-series; VAT accounts stay derived.
 *
 * Not a samlingsverifikation: every order books as its OWN verifikat through
 * the exact same flow as POST /api/webshop-orders/[id]/book
 * (lib/webshop-orders/book-order.ts): state guards, booking-time FX retry,
 * chart repair, race-free draft -> claim -> commit through the engine. So
 * period locks, balance, voucher numbering and anything later added to the
 * single-order path (e.g. underlag anchoring) apply per order automatically.
 * One verifikat per day and payment method is the day booking
 * (lib/webshop-orders/book-day.ts).
 *
 * The sweep has no reviewing user, so it only books orders whose lines are
 * DERIVED, never guessed (lib/webshop-orders/unattended-lines.ts, shared
 * with the day booking): an empty vat_breakdown, an invoice-mode payment
 * method, a 3740 residual above öre scale, a destination the store's country
 * rules do not cover and the rest are refused per order and pointed at the
 * single-order dialog.
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
    const { order_ids, payment_account, revenue_accounts } = validation.data

    // Revenue template: rate-keyed map for buildOrderBookingLines. The JSON
    // keys are strings ('25'); the builder keys by numeric rate. Typed as a
    // full Record (only truthy strings are ever inserted) so Object.values
    // stays string[] under the build's type-check.
    const revenueAccountByRate: Record<number, string> = {}
    for (const [rate, account] of Object.entries(revenue_accounts ?? {})) {
      if (account) revenueAccountByRate[Number(rate)] = account
    }
    const revenueTemplatePairs = Object.entries(revenueAccountByRate).map(
      ([rate, account]) => ({ rate: Number(rate), account }),
    )
    const revenueTemplateAccounts = [
      ...new Set(revenueTemplatePairs.map((p) => p.account)),
    ]

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

    // Revenue-template accounts are user-chosen, so they are never
    // auto-created (ensureWebshopPrefillAccounts only repairs our own closed
    // prefill set; accounts in that set are exempt from the existence check
    // for the same reason). Verify up front that every chosen account exists
    // and is active in the company's chart, and abort the WHOLE sweep
    // otherwise: a typo would fail every order on the same
    // AccountsNotInChartError anyway, and one loud refusal naming the
    // accounts beats fifty per-order engine errors. A lookup failure aborts
    // too, same doctrine as the settings fetch above.
    const chartCheckedAccounts = revenueTemplateAccounts.filter(
      (account) => !WEBSHOP_PREFILL_ACCOUNTS.includes(account),
    )
    const chartRowByAccount = new Map<
      string,
      {
        account_name: string
        default_vat_rate: number | string | null
        default_vat_treatment: string | null
      }
    >()
    if (chartCheckedAccounts.length > 0) {
      const { data: chartRows, error: chartError } = await supabase
        .from('chart_of_accounts')
        .select(
          'account_number, account_name, is_active, default_vat_rate, default_vat_treatment',
        )
        .eq('company_id', companyId)
        .in('account_number', chartCheckedAccounts)
      if (chartError) {
        log.error('bulk-book chart lookup failed; aborting sweep', chartError)
        return NextResponse.json(
          { error: getErrorMessage(chartError, { context: 'transaction' }) },
          { status: 500 },
        )
      }
      for (const row of chartRows ?? []) {
        if (!row.is_active) continue
        chartRowByAccount.set(row.account_number as string, {
          account_name: (row.account_name as string) ?? '',
          default_vat_rate: row.default_vat_rate as number | string | null,
          default_vat_treatment: row.default_vat_treatment as string | null,
        })
      }
      const unknownAccounts = chartCheckedAccounts.filter(
        (account) => !chartRowByAccount.has(account),
      )
      if (unknownAccounts.length > 0) {
        return errorResponseFromCode('WEBSHOP_ORDER_REVENUE_ACCOUNT_UNKNOWN', log, {
          requestId,
          details: { accounts: unknownAccounts },
        })
      }
    }

    // Rate-classification guard (Swedish accounting review + skeptic
    // finding): output VAT books on 2611/2621/2631 per rate regardless of
    // the template, and the momsdeklaration counts a custom account toward
    // ruta 05 only when the account resolves to that rate. The effective
    // rate comes from resolveEffectiveVatRate, the SAME helper the ruta 05
    // report arithmetic uses (#1912), so the two cannot drift: an explicit
    // momssats always wins, then a rate-mapped treatment, and number+name
    // inference only when nothing is configured, so an account explicitly
    // set to 6% can never pass a 25% slot on its name alone (review
    // finding). A mismatched choice would silently drop the sale's base out
    // of ruta 05 while its VAT lands in ruta 10-12, so the sweep refuses it
    // and points at the fix. Rate 0 buckets carry no output VAT and span
    // legitimate momsfri/export/EU accounts (usually unconfigured), so they
    // only refuse an account whose resolved rate CONTRADICTS 0% (review
    // finding). Accounts from our own default set are checked statically:
    // each is valid only for the rate it is the default for.
    const mismatchedAccounts: { rate: number; account: string }[] = []
    for (const { rate, account } of revenueTemplatePairs) {
      if (WEBSHOP_PREFILL_ACCOUNTS.includes(account)) {
        if (DEFAULT_REVENUE_ACCOUNT_BY_RATE[rate] !== account) {
          mismatchedAccounts.push({ rate, account })
        }
        continue
      }
      const row = chartRowByAccount.get(account)
      if (!row) continue // unreachable: the existence guard above returned
      const expected = rate / 100
      const effective = resolveEffectiveVatRate({
        account_number: account,
        account_class: 3,
        ...row,
      })
      const mismatch =
        rate === 0
          ? effective !== null && effective !== 0
          : effective !== expected
      if (mismatch) mismatchedAccounts.push({ rate, account })
    }
    if (mismatchedAccounts.length > 0) {
      return errorResponseFromCode(
        'WEBSHOP_ORDER_REVENUE_ACCOUNT_RATE_MISMATCH',
        log,
        { requestId, details: { accounts: mismatchedAccounts } },
      )
    }

    // Rate-0 order-context guard (#1912): VAT amounts are unaffected by the
    // 0% slot, but the momsdeklaration is not. Ruta 36 (varuförsäljning
    // utanför EU) is wrong for a Swedish or EU billing country, ruta 40
    // (tjänster omsatta utom landet) is wrong for Sweden, and the EU boxes
    // 35/38/39 are wrong for Sweden or a non-EU country. The box comes from
    // the chosen account's configured treatment, else the static BAS map;
    // an account neither classifies (the common unconfigured momsfri case)
    // gets no context check. The opposite direction, a DOMESTIC 0% account
    // (3004, ruta 42) receiving a foreign order, stays advisory: the dialog
    // already warns (zero_rate_foreign) and refusing it would regress every
    // untemplated sweep. Checked per order below, because the billing
    // country is per order and the doctrine is partial failure per row.
    // Known limitation: for WooCommerce rows customer_country is the BILLING
    // country (that sync never stores the shipping address), while the goods
    // boxes 35/36/38 follow where the goods are transported. A Swedish-billed
    // order shipped to Norway is a legitimate ruta 36 export that this guard
    // refuses; the error copy therefore says the check is billing-based and
    // sends the user to the single dialog to confirm rather than to change
    // the account. Shopify rows store the SHIPPING (destination) country
    // instead (crm#1032), so for them the check already keys on where the
    // goods go. Storing WooCommerce's shipping country is a follow-up.
    const zeroRateAccount = revenueAccountByRate[0]
    const zeroRateChartRow = zeroRateAccount
      ? chartRowByAccount.get(zeroRateAccount)
      : undefined
    const zeroRateBox: MomsBox | null = !zeroRateAccount
      ? null
      : WEBSHOP_PREFILL_ACCOUNTS.includes(zeroRateAccount)
        ? (getBoxForAccount(zeroRateAccount) ?? null)
        : zeroRateChartRow
          ? resolveRevenueVatBox({
              account_number: zeroRateAccount,
              account_class: 3,
              ...zeroRateChartRow,
            })
          : null // unreachable: the existence guard above returned
    const zeroRateContextContradicted = (country: string): boolean => {
      if (zeroRateBox === '36') return isEuMemberCountry(country)
      if (zeroRateBox === '40') return country === 'SE'
      if (zeroRateBox === '35' || zeroRateBox === '38' || zeroRateBox === '39') {
        return country === 'SE' || !isEuMemberCountry(country)
      }
      return false
    }

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

      const derived = await deriveUnattendedOrderLines({
        supabase,
        companyId,
        order,
        settings: settingsFor(order),
        log,
        paymentAccount: payment_account,
        revenueAccounts: revenueAccountByRate,
        ...(zeroRateAccount
          ? {
              zeroRate: {
                account: zeroRateAccount,
                box: zeroRateBox,
                contradicted: zeroRateContextContradicted,
              },
            }
          : {}),
      })
      if (!derived.ok) {
        results.push({
          order_id: id,
          order_number: order.order_number,
          success: false,
          error:
            derived.code === null
              ? failureFromError(derived.error)
              : failureFromCode(derived.code, derived.details),
        })
        continue
      }
      const { order: resolvedOrder, lines } = derived

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

      const outcome = await bookOrderThroughEngine(
        supabase,
        companyId,
        user.id,
        resolvedOrder,
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
              : outcome.kind === 'not_bookable'
                ? failureFromCode(outcome.failure.code, outcome.failure.details)
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
        underlag_archived: outcome.underlagArchived,
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
