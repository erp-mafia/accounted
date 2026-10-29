/**
 * Webshop orders (Shopify, WooCommerce, Zettle): the synced order and refund
 * rows, one order with the booking the dialog would prefill, booking one
 * order with the caller's own lines, booking a day and payment method as one
 * verifikat with the server's lines, and the OSS underlag the booked orders
 * add up to. Rules live in lib/webshop-orders/; the dashboard's booking route
 * calls the same bookWebshopOrder(), so a booking from an agent gets the
 * order link and the orderunderlag exactly like one from the Orders page.
 */
import { z } from 'zod'
import { BookWebshopOrderSchema, OssUnderlagQuerySchema } from '@/lib/api/schemas'
import { isoDateSchema } from '@/lib/invariants/zod'
import { buildOrderBookingLines } from '@/lib/webshop-orders/booking-lines'
import { webshopOrderBookingStatus } from '@/lib/webshop-orders/booking-status'
import type { WebshopOrder } from '@/types'
import { defineOperation } from './types'

// Loaded on first use: the booking pulls in the engine and the PDF renderer,
// which the registry's importers do not otherwise need.
const service = () => import('@/lib/webshop-orders/service')
const ossUnderlag = () => import('@/lib/webshop-orders/oss-underlag')
const bookDay = () => import('@/lib/webshop-orders/book-day')

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const WEBSHOP_ORDER_ID = z
  .string()
  .uuid()
  .describe('The order row id, from gnubok_list_webshop_orders (GET /webshop-orders).')

const BOOKING_STATUSES = ['booked', 'marked_booked', 'invoiced', 'in_transactions', 'unpaid', 'to_book'] as const

const VatBucket = z.object({ rate: z.number(), net: z.number(), tax: z.number() })
const LineItem = z.object({
  name: z.string(),
  quantity: z.number(),
  total: z.number(),
  total_tax: z.number(),
  vat_rate: z.number().nullable(),
})
const Warning = z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() })
const SuggestedLine = z.object({
  account_number: z.string(),
  debit_amount: z.number(),
  credit_amount: z.number(),
  line_description: z.string().optional(),
  currency: z.string().optional(),
  amount_in_currency: z.number().optional(),
  exchange_rate: z.number().optional(),
})

const OrderSummary = z.object({
  webshop_order_id: z.string().uuid(),
  platform: z.enum(['woocommerce', 'shopify', 'zettle']),
  store_scope: z.string(),
  store_label: z.string().nullable(),
  row_type: z.enum(['order', 'refund']),
  parent_webshop_order_id: z.string().uuid().nullable(),
  order_number: z.string(),
  platform_status: z.string(),
  is_paid: z.boolean(),
  order_date: z.string(),
  paid_date: z.string().nullable(),
  currency: z.string(),
  total: z.number(),
  total_tax: z.number(),
  total_sek: z.number().nullable(),
  exchange_rate: z.number().nullable(),
  vat_breakdown: z.array(VatBucket),
  customer_country: z.string().nullable(),
  customer_name: z.string().nullable(),
  customer_company: z.string().nullable(),
  payment_method: z.string().nullable(),
  payment_method_title: z.string().nullable(),
  refunded_total: z.number(),
  booking_status: z.enum(BOOKING_STATUSES),
  journal_entry_id: z.string().uuid().nullable(),
  invoice_id: z.string().uuid().nullable(),
  manually_booked_journal_entry_id: z.string().uuid().nullable(),
  remote_changed_after_freeze: z.boolean(),
})

function orderOut(order: WebshopOrder): z.infer<typeof OrderSummary> {
  return {
    webshop_order_id: order.id,
    platform: order.platform,
    store_scope: order.store_scope,
    store_label: order.store_label,
    row_type: order.row_type,
    parent_webshop_order_id: order.parent_order_id,
    order_number: order.order_number,
    platform_status: order.status,
    is_paid: order.is_paid,
    order_date: order.order_date,
    paid_date: order.paid_date,
    currency: order.currency,
    total: order.total,
    total_tax: order.total_tax,
    total_sek: order.total_sek,
    exchange_rate: order.exchange_rate,
    vat_breakdown: order.vat_breakdown,
    customer_country: order.customer_country,
    customer_name: order.customer_name,
    customer_company: order.customer_company,
    payment_method: order.payment_method,
    payment_method_title: order.payment_method_title,
    refunded_total: order.refunded_total,
    booking_status: webshopOrderBookingStatus(order),
    journal_entry_id: order.journal_entry_id,
    invoice_id: order.invoice_id,
    manually_booked_journal_entry_id: order.manually_booked_journal_entry_id,
    remote_changed_after_freeze: order.remote_changed_after_freeze,
  }
}

const COUNTRY_PITFALL =
  'customer_country is ISO 3166-1 alpha-2. Shopify stores the shipping (destination) country, or the billing country when nothing on the order ships (digital products, services); WooCommerce the billing country. It is null for a Shopify local pickup or when the store withholds addresses.'

const EXAMPLE_ORDER = {
  webshop_order_id: '3f2a…',
  platform: 'shopify',
  store_scope: 'exempel.myshopify.com',
  store_label: 'Exempelbutiken',
  row_type: 'order' as const,
  parent_webshop_order_id: null,
  order_number: '#1042',
  platform_status: 'paid',
  is_paid: true,
  order_date: '2026-10-14',
  paid_date: '2026-10-14',
  currency: 'SEK',
  total: 1250,
  total_tax: 250,
  total_sek: 1250,
  exchange_rate: 1,
  vat_breakdown: [{ rate: 25, net: 1000, tax: 250 }],
  customer_country: 'DK',
  customer_name: null,
  customer_company: null,
  payment_method: 'shopify_payments',
  payment_method_title: 'shopify_payments',
  refunded_total: 0,
  booking_status: 'to_book',
  journal_entry_id: null,
  invoice_id: null,
  manually_booked_journal_entry_id: null,
  remote_changed_after_freeze: false,
}

// The example's suggestion, built by the dialog's own prefill so the docs
// cannot drift from what GET /webshop-orders/{orderId} answers.
const EXAMPLE_LINES = buildOrderBookingLines({ order: EXAMPLE_ORDER })

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export const webshopOrdersList = defineOperation({
  id: 'webshop-orders.list',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The order and refund rows synced from the company\'s webshops, newest first.',
    description:
      'Lists the rows the Shopify, WooCommerce and Zettle syncs store: one per paid order and one per refund (a negative row under its order), with amounts, the VAT split per rate, the country, the payment method and where each row stands (booking_status: to_book, booked, marked_booked, invoiced, in_transactions, unpaid). Filter by booked or unbooked, platform, row type, order date and country. Paginated with limit and offset; total is the full count. Read-only.',
    useWhen: 'To find the orders to book, or to see which orders a period holds per country.',
    doNotUseFor: 'One order with its line items and suggested booking (GET /webshop-orders/{orderId}).',
    pitfalls: [
      COUNTRY_PITFALL,
      'booked=unbooked also returns unpaid and invoiced rows: only booking_status to_book can be booked.',
    ],
    example: { request: { booked: 'unbooked', country: 'DK' }, response: { data: { orders: [EXAMPLE_ORDER], total: 1 }, meta: META } },
  },
  input: z.object({
    booked: z.enum(['booked', 'unbooked']).optional().describe('booked: booked here or marked as booked outside; unbooked: the rest.'),
    platform: z.enum(['woocommerce', 'shopify', 'zettle']).optional(),
    row_type: z.enum(['order', 'refund']).optional(),
    from: isoDateSchema.optional().describe('First order date, inclusive.'),
    to: isoDateSchema.optional().describe('Last order date, inclusive.'),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/, 'Landskoden ska vara två bokstäver (ISO 3166-1), t.ex. DK')
      .optional()
      .describe('ISO 3166-1 alpha-2 country, e.g. DK.'),
    limit: z.coerce.number().int().min(1).max(200).optional().describe('Rows per page, default 50.'),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  output: z.object({ orders: z.array(OrderSummary), total: z.number() }),
  errorCodes: ['WEBSHOP_ORDER_READ_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/webshop-orders' },
  mcp: {
    name: 'gnubok_list_webshop_orders',
    title: 'List Webshop Orders (Shopify, WooCommerce)',
    description:
      'Synced webshop order and refund rows (Shopify, WooCommerce, Zettle): amounts, VAT per rate, country (Shopify: destination), payment method and booking status. Filter by booked/unbooked, platform, date and country.',
    keywords: ['webshop', 'webbutik', 'e-handel', 'order', 'ordrar', 'shopify', 'woocommerce', 'oss', 'leveransland'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).listWebshopOrders(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { orders: outcome.data.orders.map(orderOut), total: outcome.data.total },
    }
  },
})

// ---------------------------------------------------------------------------
// Get
// ---------------------------------------------------------------------------

export const webshopOrdersGet = defineOperation({
  id: 'webshop-orders.get',
  kind: 'read',
  scope: 'transactions:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'One webshop order row with its line items and the booking the Orders page would prefill.',
    description:
      'Everything GET /webshop-orders returns for the row plus its line items and suggestion: the entry date (paid date, else order date), the open fiscal period covering it, the description, the payment account from the store\'s payment-method mapping (1686 when unmapped), and balanced lines with revenue and VAT per rate: on the store\'s accounts for the order\'s destination country when the store has set them, otherwise on the Swedish accounts. warnings lists what the suggestion cannot know, e.g. a country outside Sweden that no store rule covers. Read-only.',
    useWhen: 'Before booking an order, to start from the dialog\'s lines and change the accounts that the country or VAT rate calls for.',
    doNotUseFor: 'Listing orders (GET /webshop-orders) or booking (POST /webshop-orders/{orderId}/book).',
    pitfalls: [
      COUNTRY_PITFALL,
      'For a Shopify order shipped outside Sweden the suggested lines use the store\'s accounts for that country and VAT rate when the store has set them (Settings > Connections > Shopify), e.g. 3106/2670 for OSS; an order shipped to Sweden uses the store\'s own sales account for Sweden when it has set one. Otherwise they use Swedish accounts (3001-3004, 2611-2631): for an OSS, export or VOEC sale choose the accounts yourself. The account choice is the caller\'s.',
      'suggestion.lines is null while a non-SEK order has no exchange rate; booking resolves the rate once more and refuses with WEBSHOP_ORDER_FX_UNRESOLVED if it still cannot.',
    ],
    example: {
      response: {
        data: {
          ...EXAMPLE_ORDER,
          line_items: [{ name: 'Skidglasögon', quantity: 1, total: 1000, total_tax: 250, vat_rate: 25 }],
          suggestion: {
            entry_date: '2026-10-14',
            fiscal_period_id: 'a8f1…',
            description: 'Order #1042 (shopify_payments)',
            payment_account: EXAMPLE_LINES[0].account_number,
            payment_account_mapped: false,
            lines: EXAMPLE_LINES,
          },
          warnings: [{ code: 'country_outside_sweden', message_sv: 'Ordern har ett land utanför Sverige…', message_en: 'The order has a country outside Sweden…' }],
        },
        meta: META,
      },
    },
  },
  input: z.object({ webshop_order_id: WEBSHOP_ORDER_ID }),
  output: OrderSummary.extend({
    line_items: z.array(LineItem),
    suggestion: z.object({
      entry_date: z.string(),
      fiscal_period_id: z.string().uuid().nullable(),
      description: z.string(),
      payment_account: z.string(),
      payment_account_mapped: z.boolean(),
      lines: z.array(SuggestedLine).nullable(),
    }),
    warnings: z.array(Warning),
  }),
  errorCodes: ['WEBSHOP_ORDER_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/webshop-orders/:orderId',
    pathParams: { orderId: 'webshop_order_id' },
  },
  mcp: {
    name: 'gnubok_get_webshop_order',
    title: 'Get Webshop Order',
    description:
      'One webshop order: line items, VAT per rate, country (Shopify: destination), and the booking the Orders page would prefill (date, period, balanced lines on Swedish accounts) with warnings, e.g. a country outside Sweden.',
    keywords: ['webshop', 'order', 'orderrader', 'shopify', 'woocommerce', 'kontering order', 'oss', 'voec', 'leveransland'],
  },
  run: async (ctx, input) => {
    const outcome = await (await service()).getWebshopOrder(ctx, input)
    if (!outcome.ok || outcome.dryRun) return outcome
    const { order, suggestion, warnings } = outcome.data
    return {
      ok: true,
      data: {
        ...orderOut(order),
        line_items: order.line_items,
        suggestion: {
          ...suggestion,
          lines: suggestion.lines?.map((l) => ({
            account_number: l.account_number,
            debit_amount: l.debit_amount,
            credit_amount: l.credit_amount,
            ...(l.line_description ? { line_description: l.line_description } : {}),
            ...(l.currency ? { currency: l.currency } : {}),
            ...(l.amount_in_currency !== undefined ? { amount_in_currency: l.amount_in_currency } : {}),
            ...(l.exchange_rate !== undefined ? { exchange_rate: l.exchange_rate } : {}),
          })) ?? null,
        },
        warnings,
      },
    }
  },
})

// ---------------------------------------------------------------------------
// Book
// ---------------------------------------------------------------------------

const { lines, voucher_series, notes, description, entry_date, fiscal_period_id } = BookWebshopOrderSchema.shape

export const webshopOrdersBook = defineOperation({
  id: 'webshop-orders.book',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book one webshop order or refund with your own lines, linked to the order with its orderunderlag.',
    description:
      'Posts one verifikat for the order row through the bookkeeping engine (source_type webshop_order, linked to the order) with the lines you send, exactly as the Orders page books it: the order stops showing as unbooked, and the orderunderlag (line items, VAT, country, payment method) is archived on the verifikat. entry_date defaults to the paid date (else the order date), fiscal_period_id to the open period covering it, description to the Orders page\'s. Refused when the order is booked, invoiced, marked as booked, unpaid or already in the transactions feed. Dry-runnable.',
    useWhen: 'An order has booking_status to_book and you know its accounts, e.g. OSS or VOEC accounts picked from its country and VAT rate.',
    doNotUseFor: 'Orders that should become a customer invoice, booking a payout from the payment provider (book that against the clearing account from the bank row), or correcting a booked order (storno).',
    pitfalls: [
      'Send the complete line set; sum debit = sum credit > 0. Start from suggestion.lines of GET /webshop-orders/{orderId} and change the accounts.',
      'The account choice is yours: Accounted only checks balance, period, lock and that the accounts exist. Shopify\'s amounts and VAT are the source; the lines should add up to them.',
      COUNTRY_PITFALL,
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.',
    ],
    example: {
      request: {
        lines: EXAMPLE_LINES.map(({ account_number, debit_amount, credit_amount }) => ({
          account_number,
          debit_amount,
          credit_amount,
        })),
      },
      response: {
        data: {
          webshop_order_id: '3f2a…',
          journal_entry_id: '9a0b…',
          voucher_series: 'A',
          voucher_number: 214,
          entry_date: '2026-10-14',
          underlag_archived: true,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    webshop_order_id: WEBSHOP_ORDER_ID,
    lines: lines.describe('The verifikat lines, balanced. Start from suggestion.lines of gnubok_get_webshop_order.'),
    entry_date: entry_date.optional().describe('Defaults to the paid date, else the order date.'),
    fiscal_period_id: fiscal_period_id.optional().describe('Defaults to the open fiscal period covering entry_date.'),
    description: description.optional().describe('Defaults to "Order <number> (<payment method>)".'),
    voucher_series,
    notes,
  }),
  output: z.object({
    webshop_order_id: z.string().uuid(),
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    entry_date: z.string(),
    underlag_archived: z.boolean(),
  }),
  errorCodes: [
    'WEBSHOP_ORDER_NOT_FOUND',
    'WEBSHOP_ORDER_ALREADY_BOOKED',
    'WEBSHOP_ORDER_ALREADY_INVOICED',
    'WEBSHOP_ORDER_MANUALLY_BOOKED',
    'WEBSHOP_ORDER_REFUND_PARENT_INVOICED',
    'WEBSHOP_ORDER_NOT_PAID',
    'WEBSHOP_ORDER_LEGACY_TRANSACTION_OPEN',
    'WEBSHOP_ORDER_LEGACY_TRANSACTION_BOOKED',
    'WEBSHOP_ORDER_FX_UNRESOLVED',
    'JOURNAL_ENTRY_NOT_BALANCED',
    'FISCAL_PERIOD_NOT_FOUND',
    'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD',
    'PERIOD_LOCKED',
    'ACCOUNTS_NOT_IN_CHART',
    'WEBSHOP_ORDER_BOOKING_FAILED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/webshop-orders/:orderId/book',
    pathParams: { orderId: 'webshop_order_id' },
  },
  mcp: {
    name: 'gnubok_book_webshop_order',
    title: 'Book Webshop Order',
    description:
      'Stage booking one webshop order or refund with your lines (e.g. OSS/VOEC accounts by country): linked to the order, orderunderlag archived, as on the Orders page. Get suggested lines from gnubok_get_webshop_order. Approval books it.',
    keywords: ['bokför order', 'bokför webshop', 'shopify', 'woocommerce', 'orderunderlag', 'oss', 'voec', 'e-handel'],
    stage: {
      pendingType: 'book_webshop_order',
      title: (_input, preview) =>
        typeof preview?.order_number === 'string' ? `Bokför order ${preview.order_number}` : 'Bokför webshoporder',
      // The approver saw this date, period and text: the commit books them.
      pinParams: (input, preview) => {
        const entry = preview.journal_entry as { entry_date?: string; fiscal_period_id?: string; description?: string } | undefined
        if (!entry) return input
        return {
          ...input,
          ...(entry.entry_date ? { entry_date: entry.entry_date } : {}),
          ...(entry.fiscal_period_id ? { fiscal_period_id: entry.fiscal_period_id } : {}),
          ...(entry.description ? { description: entry.description } : {}),
        }
      },
      extras: (_input, preview) => {
        const entry = preview.journal_entry as { entry_date?: string } | undefined
        return entry?.entry_date ? { periodDate: entry.entry_date } : {}
      },
    },
  },
  run: async (ctx, input, { dryRun }) => (await service()).bookWebshopOrderWithLines(ctx, input, { dryRun }),
})

// ---------------------------------------------------------------------------
// Book a day
// ---------------------------------------------------------------------------

const DayOrder = z.object({
  webshop_order_id: z.string().uuid(),
  order_number: z.string(),
  row_type: z.enum(['order', 'refund']),
  total_sek: z.number(),
})

const SkippedOrder = DayOrder.omit({ total_sek: true }).extend({
  code: z.string(),
  message_sv: z.string(),
  message_en: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const webshopOrdersBookDay = defineOperation({
  id: 'webshop-orders.book-day',
  kind: 'write',
  scope: 'bookkeeping:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Book a store\'s orders and refunds of one day and one payment method as one verifikat, with a day summary as underlag.',
    description:
      'Posts one verifikat (source_type webshop_order, dated the day) for every unbooked, paid order and refund of the store whose paid date (else order date) is the day and whose payment method is the one given. The lines are the server\'s, never the caller\'s: each order\'s lines are derived exactly as the Orders page\'s bulk booking derives them (the store\'s payment-method mapping and country rules), then summed per account and side, so sales and refunds are separate lines. Every order is linked to the verifikat and stops showing as unbooked, and a dagssammanställning listing each order (number, date, country, amount, VAT) is archived on it. An order that cannot be booked without review (no VAT split, a country no store rule covers, an unknown destination, a non-Swedish rate on the Swedish accounts, an invoice-flow payment method, a rounding gap over 1 kr) is left out, listed in skipped with the reason, and stays unbooked. Dry-runnable.',
    useWhen: 'The company books its webshop sales per day and payment method (e.g. one verifikat for Shopify Payments and one for PayPal), not per order.',
    doNotUseFor: 'Payouts and fees from the payment provider (book those against the clearing account from the bank row), one order (POST /webshop-orders/{orderId}/book), or correcting a booked day (storno, then book the orders again).',
    pitfalls: [
      'Pass order_ids and lines_sha256 from the dry run as expected_order_ids and expected_lines_sha256: an order booked or changed since answers 409 WEBSHOP_DAY_CHANGED instead of booking figures you did not review.',
      'payment_method is the order\'s payment_method from GET /webshop-orders, e.g. shopify_payments or paypal. Orders without one cannot be booked per day.',
      'Orders that sync after the day is booked stay unbooked: booking the day again posts a second verifikat for them.',
      'skipped orders stay in Att bokföra: book them one by one with POST /webshop-orders/{orderId}/book.',
      'A posted verifikat is permanent: undo it with storno (POST /journal-entries/{id}/reverse), never by editing.',
    ],
    example: {
      request: { platform: 'shopify', store_scope: 'exempel.myshopify.com', date: '2026-10-14', payment_method: 'shopify_payments' },
      response: {
        data: {
          journal_entry_id: '9a0b…',
          voucher_series: 'L',
          voucher_number: 41,
          entry_date: '2026-10-14',
          booked: [
            { webshop_order_id: '3f2a…', order_number: '#1042', row_type: 'order', total_sek: 1250 },
            { webshop_order_id: '7c1d…', order_number: '#1043', row_type: 'order', total_sek: 499 },
          ],
          skipped: [],
          underlag_document_id: '5d2c…',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    platform: z.enum(['woocommerce', 'shopify', 'zettle']),
    store_scope: z.string().min(1).describe('The store, store_scope from GET /webshop-orders, e.g. exempel.myshopify.com.'),
    date: isoDateSchema.describe('The day: the orders\' paid date, else their order date.'),
    payment_method: z.string().min(1).describe('The orders\' payment_method from GET /webshop-orders, e.g. shopify_payments or paypal.'),
    expected_order_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(500)
      .optional()
      .describe('The order rows you reviewed (order_ids from the dry run). Refused if any of them was booked or no longer books.'),
    expected_lines_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional()
      .describe('lines_sha256 from the dry run. Refused if the verifikat lines differ, e.g. an order changed in the store since.'),
  }),
  output: z.object({
    journal_entry_id: z.string().uuid(),
    voucher_series: z.string().nullable(),
    voucher_number: z.number().nullable(),
    entry_date: z.string(),
    booked: z.array(DayOrder),
    skipped: z.array(SkippedOrder),
    underlag_document_id: z.string().uuid().nullable(),
  }),
  errorCodes: [
    'WEBSHOP_DAY_EMPTY',
    'WEBSHOP_DAY_NOTHING_BOOKABLE',
    'WEBSHOP_DAY_CHANGED',
    'WEBSHOP_DAY_TOO_MANY_ROWS',
    'WEBSHOP_ORDER_READ_FAILED',
    'FISCAL_PERIOD_NOT_FOUND',
    'PERIOD_LOCKED',
    'ACCOUNTS_NOT_IN_CHART',
    'WEBSHOP_DAY_BOOKING_FAILED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/webshop-orders/book-day' },
  mcp: {
    name: 'gnubok_book_webshop_day',
    title: 'Book Webshop Day (one verifikat per day and payment method)',
    description:
      'Stage booking a store\'s unbooked orders and refunds of one day and payment method (shopify_payments, paypal) as ONE verifikat: server-derived lines summed per account, every order linked, day summary as underlag. Orders needing review are skipped. Approval books it.',
    keywords: ['bokför dag', 'dagsverifikat', 'samlingsverifikat', 'sammandrag', 'dagsförsäljning', 'shopify', 'woocommerce', 'webshop', 'e-handel', 'paypal'],
    stage: {
      pendingType: 'book_webshop_day',
      title: (input) => `Bokför webshopdag ${String(input.date ?? '')} (${String(input.payment_method ?? '')})`,
      // The approver saw these orders and these lines: the commit books exactly them.
      pinParams: (input, preview) => ({
        ...input,
        ...(Array.isArray(preview.order_ids) && preview.order_ids.length > 0 ? { expected_order_ids: preview.order_ids } : {}),
        ...(typeof preview.lines_sha256 === 'string' ? { expected_lines_sha256: preview.lines_sha256 } : {}),
      }),
      extras: (input) => (typeof input.date === 'string' ? { periodDate: input.date } : {}),
    },
  },
  run: async (ctx, input, { dryRun }) => (await bookDay()).bookWebshopDay(ctx, input, { dryRun }),
})

// ---------------------------------------------------------------------------
// OSS underlag
// ---------------------------------------------------------------------------

const QuarterRef = z.object({ year: z.number(), quarter: z.number(), label: z.string() })

const OssWarning = Warning.extend({ order_numbers: z.array(z.string()) })

export const webshopOrdersOssUnderlag = defineOperation({
  id: 'webshop-orders.oss-underlag',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Underlag for the OSS declaration (unionsordningen): a quarter\'s webshop sales to consumers in other EU countries, per country and VAT rate, in euro.',
    description:
      'Adds up the webshop orders booked on the OSS accounts (VAT code oss, the OSS output VAT account, or accounts a Shopify country rule names for OSS) in a calendar quarter: per destination country and VAT rate the sales without VAT and the VAT, in euro at the ECB rate for the last day of the quarter (the next publication day when the ECB published none) and in kronor as booked. Refunds of an earlier quarter\'s sales are corrections of that quarter (country, quarter, VAT). unaccounted lists the OSS-account verifikat that book no order (manual vouchers, stornos), and warnings the orders missing from the underlag. Read-only; nothing is filed.',
    useWhen: 'Before filing the quarterly OSS declaration in Skatteverket\'s e-tjänst, or to check what the OSS accounts hold per country.',
    doNotUseFor: 'The Swedish momsdeklaration (OSS sales are outside it), EU sales taxed in Sweden below the distance-selling threshold, or invoices (they carry Swedish VAT only).',
    pitfalls: [
      'Only booked orders count, in the quarter of the verifikat that books them: book the quarter\'s orders first (warnings unbooked_orders).',
      'Euro amounts are null until the ECB has published the rate for the last day of the quarter (warnings rate_unavailable); the kronor amounts are final.',
      'The VAT is declared with two decimals, never rounded. A nil_return quarter still needs a declaration.',
      'A correction uses the ECB rate of the quarter it corrects, so a full refund takes back exactly what was declared.',
    ],
    example: {
      request: { year: 2026, quarter: 3 },
      response: {
        data: {
          period: { year: 2026, quarter: 3, start: '2026-07-01', end: '2026-09-30', label: 'Q3 2026', deadline: '2026-10-31' },
          rows: [{ country: 'DE', vat_rate: 19, net_eur: 88.26, vat_eur: 16.77, net_sek: 1000, vat_sek: 190, order_count: 1 }],
          corrections: [],
          totals: { net_eur: 88.26, vat_eur: 16.77, corrections_vat_eur: 0, net_sek: 1000, vat_sek: 190, corrections_vat_sek: 0 },
          rates: [{ currency: 'SEK', for_date: '2026-09-30', rate: 11.331, rate_date: '2026-09-30', unavailable: false }],
          ledger_vat_sek: 190,
          unaccounted: [],
          warnings: [],
          nil_return: false,
        },
        meta: META,
      },
    },
  },
  input: OssUnderlagQuerySchema,
  output: z.object({
    period: QuarterRef.extend({ start: z.string(), end: z.string(), deadline: z.string() }),
    rows: z.array(
      z.object({
        country: z.string(),
        vat_rate: z.number(),
        net_eur: z.number().nullable(),
        vat_eur: z.number().nullable(),
        net_sek: z.number(),
        vat_sek: z.number(),
        order_count: z.number(),
      }),
    ),
    corrections: z.array(
      z.object({
        country: z.string(),
        period: QuarterRef,
        vat_eur: z.number().nullable(),
        vat_sek: z.number(),
        refund_count: z.number(),
      }),
    ),
    totals: z.object({
      net_eur: z.number().nullable(),
      vat_eur: z.number().nullable(),
      corrections_vat_eur: z.number().nullable(),
      net_sek: z.number(),
      vat_sek: z.number(),
      corrections_vat_sek: z.number(),
    }),
    rates: z.array(
      z.object({
        currency: z.string(),
        for_date: z.string(),
        rate: z.number().nullable(),
        rate_date: z.string().nullable(),
        unavailable: z.boolean(),
      }),
    ),
    ledger_vat_sek: z.number(),
    unaccounted: z.array(
      z.object({
        journal_entry_id: z.string().uuid(),
        voucher_series: z.string().nullable(),
        voucher_number: z.number(),
        entry_date: z.string(),
        description: z.string(),
        net_sek: z.number(),
        vat_sek: z.number(),
      }),
    ),
    warnings: z.array(OssWarning),
    nil_return: z.boolean(),
  }),
  errorCodes: ['OSS_UNDERLAG_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/webshop-orders/oss-underlag' },
  mcp: {
    name: 'gnubok_get_oss_underlag',
    title: 'OSS Underlag (One Stop Shop, Unionsordningen)',
    description:
      "Underlag for the quarterly OSS declaration: webshop sales to consumers in other EU countries per country and VAT rate, in euro at the ECB rate, corrections of earlier quarters, and the OSS vouchers it does not cover. Read-only; to type into Skatteverket's e-tjänst.",
    keywords: ['oss', 'one stop shop', 'unionsordningen', 'oss-deklaration', 'distansförsäljning', 'eu-moms', 'utländsk moms', 'shopify', 'e-handel'],
  },
  run: async (ctx, input) => (await ossUnderlag()).getOssUnderlag(ctx, input),
})
