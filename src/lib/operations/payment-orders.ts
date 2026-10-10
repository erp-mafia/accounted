/**
 * Bank payments (payment initiation, lib/payments/orders) through the machine
 * doors: list and read payment orders, prepare drafts for supplier invoices,
 * approve and un-approve them, cancel one, read whether the company can pay
 * through its bank and whether the provider has verified it, and hand out the
 * link to the Betalningar page where a person signs with BankID.
 *
 * No door here starts or polls a BankID signing, and the MCP tools never
 * approve: the account holder attests and signs money out in person
 * (session-route-parity PAYMENT_SIGNING). An agent prepares and follows up;
 * a person approves and signs in Accounted. The rules live in
 * lib/payments/orders (prepare.ts, lifecycle.ts, availability.ts); the
 * dashboard routes under /api/payments call the same functions.
 */
import { z } from 'zod'
import { DEFAULT_LIMIT, MAX_LIMIT, decodeDefaultCursor, nextCursorFromPage } from '@/lib/api/v1/pagination'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'
import { isoDateSchema } from '@/lib/invariants/zod'
import {
  getCompanyPaymentVerification,
  getPaymentsAvailability,
  startCompanyPaymentVerification,
} from '@/lib/payments/orders/availability'
import { approvePaymentOrders, cancelPaymentOrder, unapprovePaymentOrders } from '@/lib/payments/orders/lifecycle'
import { preparePaymentOrders } from '@/lib/payments/orders/prepare'
import { PAYMENT_ORDER_STATUSES } from '@/lib/payments/orders/status'
import type { PaymentOrderRow } from '@/lib/payments/orders/types'
import { formatPayeeLabel } from '@/lib/payments/supplier-payee'
import { maskIban } from './supplier-payment-batches'
import { defineOperation, type OperationContext } from './types'

/** The Betalningar page: where a person approves and signs with BankID. */
export const PAYMENTS_PAGE_PATH = '/payments'

const ORDER_ID = z
  .string()
  .uuid()
  .describe('The payment order id (payment_order_id from the list, prepare or get answer).')

const ORDER_IDS = z
  .array(z.string().uuid())
  .min(1)
  .max(100)
  .describe('Payment order ids (payment_order_id), 1-100.')

const STATUS = z
  .enum(PAYMENT_ORDER_STATUSES)
  .describe(
    'draft: prepared, not attested. approved: attested, waiting for a BankID signing. submitted, awaiting_signature, ' +
      'awaiting_second_signer, accepted: at the bank. executed: paid by the bank; the order closes when its debit is matched ' +
      'to the invoice. rejected, cancelled, failed: closed without a payment.',
  )

const Payee = z.object({
  type: z.enum(['bankgiro', 'plusgiro', 'bank_account', 'iban']),
  label: z.string().describe('Display form, e.g. "BG 5050-1055", "3300 1234567" or the IBAN.'),
  name: z.string().describe('The payee name as the order carries it (the supplier name).'),
  source: z
    .enum(['invoice', 'supplier'])
    .describe('Where the account came from: the invoice (as the document states it) or the supplier card.'),
  check: z
    .enum(['unchecked', 'known', 'new', 'changed'])
    .describe(
      'known: paid before. new: never confirmed for this supplier. changed: differs from the supplier card. ' +
        'new and changed need a person\'s confirmation at approval (confirmed_payee_invoice_ids).',
    ),
})

const Reference = z.object({
  type: z.enum(['ocr', 'message']).describe('ocr: a valid OCR number; message: the invoice number sent as a message to the payee.'),
  value: z.string(),
})

const OrderOut = z.object({
  payment_order_id: z.string().uuid(),
  supplier_invoice_id: z.string().uuid().nullable(),
  payment_order_batch_id: z
    .string()
    .uuid()
    .nullable()
    .describe('The signing batch (one BankID signing) the order went to the bank in, once it did.'),
  status: STATUS,
  amount: z.number(),
  currency: z.string(),
  requested_execution_date: z.string().describe('YYYY-MM-DD: the day the bank is asked to pay.'),
  cash_account_id: z.string().uuid().describe('The company account the payment leaves from.'),
  payee: Payee,
  reference: Reference,
  end_to_end_id: z.string().describe('Accounted\'s id for the payment at the bank; the debit on the bank statement carries it.'),
  provider_status: z.string().nullable().describe('The bank\'s own status code, verbatim, once the bank has the payment.'),
  provider_error_code: z.string().nullable().describe('The bank\'s refusal code when it refused or failed the payment.'),
  outcome_unknown: z
    .boolean()
    .describe('true while the bank may hold the payment but its answer was lost: a person resolves it in Accounted.'),
  approved_at: z.string().nullable(),
  submitted_at: z.string().nullable(),
  signed_at: z.string().nullable(),
  executed_at: z.string().nullable(),
  cancelled_at: z.string().nullable(),
  matched_at: z.string().nullable().describe('When the bank debit was matched to the invoice, which settles the order.'),
  created_at: z.string(),
  updated_at: z.string(),
  supplier_invoice: z
    .object({
      supplier_invoice_number: z.string().nullable(),
      due_date: z.string().nullable(),
      supplier_name: z.string().nullable(),
    })
    .nullable()
    .describe('The invoice the order pays, when the answer carries it (lists and reads do; prepare does not).'),
})

type OrderOutT = z.infer<typeof OrderOut>

/**
 * The two reads below name their columns literally (the schema guard,
 * tests/schema/no-phantom-columns.test.ts, resolves literal select strings):
 * what a caller needs to follow a payment, never internals such as the
 * idempotency key or the signer. A column the table gains is a decision
 * here, not a leak.
 */

type OrderSelectRow = Pick<
  PaymentOrderRow,
  | 'id'
  | 'supplier_invoice_id'
  | 'batch_id'
  | 'status'
  | 'amount'
  | 'currency'
  | 'requested_execution_date'
  | 'cash_account_id'
  | 'payee_type'
  | 'payee_bankgiro'
  | 'payee_plusgiro'
  | 'payee_clearing'
  | 'payee_account'
  | 'payee_iban'
  | 'payee_name'
  | 'payee_source'
  | 'payee_check'
  | 'reference_type'
  | 'reference'
  | 'end_to_end_id'
  | 'provider_status'
  | 'provider_error_code'
  | 'outcome_unknown_at'
  | 'approved_at'
  | 'submitted_at'
  | 'signed_at'
  | 'executed_at'
  | 'cancelled_at'
  | 'matched_at'
  | 'created_at'
  | 'updated_at'
> & {
  supplier_invoice?: {
    supplier_invoice_number: string | null
    due_date: string | null
    supplier: { name: string | null } | { name: string | null }[] | null
  } | null
}

function payeeLabel(row: OrderSelectRow): string {
  switch (row.payee_type) {
    case 'bankgiro':
      return row.payee_bankgiro ? formatPayeeLabel({ type: 'bankgiro', bankgiro: row.payee_bankgiro }) : ''
    case 'plusgiro':
      return row.payee_plusgiro ? formatPayeeLabel({ type: 'plusgiro', plusgiro: row.payee_plusgiro }) : ''
    case 'bank_account':
      return formatPayeeLabel({ type: 'bank_account', clearing: row.payee_clearing ?? '', account: row.payee_account ?? '' })
    case 'iban':
      return row.payee_iban ?? ''
  }
}

/** An order row (with or without its invoice join) in the door's shape. */
export function toOrderOut(row: OrderSelectRow): OrderOutT {
  const invoice = row.supplier_invoice ?? null
  const supplier = invoice ? (Array.isArray(invoice.supplier) ? invoice.supplier[0] ?? null : invoice.supplier) : null
  return {
    payment_order_id: row.id,
    supplier_invoice_id: row.supplier_invoice_id,
    payment_order_batch_id: row.batch_id,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    requested_execution_date: row.requested_execution_date,
    cash_account_id: row.cash_account_id,
    payee: {
      type: row.payee_type,
      label: payeeLabel(row),
      name: row.payee_name,
      source: row.payee_source,
      check: row.payee_check,
    },
    reference: { type: row.reference_type, value: row.reference },
    end_to_end_id: row.end_to_end_id,
    provider_status: row.provider_status ?? null,
    provider_error_code: row.provider_error_code ?? null,
    outcome_unknown: row.outcome_unknown_at !== null && row.outcome_unknown_at !== undefined,
    approved_at: row.approved_at ?? null,
    submitted_at: row.submitted_at ?? null,
    signed_at: row.signed_at ?? null,
    executed_at: row.executed_at ?? null,
    cancelled_at: row.cancelled_at ?? null,
    matched_at: row.matched_at ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    supplier_invoice: invoice
      ? {
          supplier_invoice_number: invoice.supplier_invoice_number ?? null,
          due_date: invoice.due_date ?? null,
          supplier_name: supplier?.name ?? null,
        }
      : null,
  }
}

/** The Betalningar page on the canonical app origin, optionally with orders preselected. */
export function paymentsPageUrl(orderIds: readonly string[] = []): string {
  const url = new URL(PAYMENTS_PAGE_PATH, getCanonicalAppOrigin())
  if (orderIds.length > 0) url.searchParams.set('orders', orderIds.join(','))
  return url.toString()
}

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const EXAMPLE_ORDER_ID = '7c2e…'
const EXAMPLE_INVOICE_ID = '9e2f…'
const EXAMPLE_ACCOUNT_ID = '41b0…'
const EXAMPLE_ORDER = {
  payment_order_id: EXAMPLE_ORDER_ID,
  supplier_invoice_id: EXAMPLE_INVOICE_ID,
  payment_order_batch_id: null,
  status: 'draft',
  amount: 737.5,
  currency: 'SEK',
  requested_execution_date: '2026-10-20',
  cash_account_id: EXAMPLE_ACCOUNT_ID,
  payee: { type: 'bankgiro', label: 'BG 5050-1055', name: 'Derome Bygg AB', source: 'supplier', check: 'known' },
  reference: { type: 'ocr', value: '4400112233' },
  end_to_end_id: 'ACC7C2E1A2F3B4C5',
  provider_status: null,
  provider_error_code: null,
  outcome_unknown: false,
  approved_at: null,
  submitted_at: null,
  signed_at: null,
  executed_at: null,
  cancelled_at: null,
  matched_at: null,
  created_at: '2026-10-10T09:00:00Z',
  updated_at: '2026-10-10T09:00:00Z',
  supplier_invoice: { supplier_invoice_number: 'CD3014794407', due_date: '2026-10-20', supplier_name: 'Derome Bygg AB' },
}
const SIGNING_NOTE =
  'Approval and BankID signing happen in Accounted, by a person: open the url. No API or MCP door signs a payment.'

// ─────────────────────────────────────────────────────────────────
// list / get
// ─────────────────────────────────────────────────────────────────

const LIST_STATUS = z
  .enum([...PAYMENT_ORDER_STATUSES, 'open', 'all'])
  .default('all')
  .describe(
    'One status; open (every order not closed: drafts, approved, at the bank, and executed ones whose debit is not matched yet); ' +
      'or all (default).',
  )

const CLOSED_STATUSES = '(rejected,cancelled,failed)'

export const paymentOrdersList = defineOperation({
  id: 'payment-orders.list',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List bank payment orders (betalningar via banken), newest first.',
    description:
      'Returns the company\'s bank payment orders, newest first, cursor-paginated: status, amount, execution date, the payee as ' +
      'the order carries it (with its check), the reference, the bank\'s own status, and the supplier invoice each order pays. ' +
      'Filter by one status, by open (everything not yet closed) or by supplier_invoice_id. Pass next_cursor from the answer ' +
      'as cursor to get the next page; it is null on the last page.',
    useWhen: 'Following up bank payments: what is waiting for approval or signing, what the bank holds, what is paid.',
    doNotUseFor: 'Payment files (betalfiler): GET /supplier-payment-batches. Preparing a payment: POST /payment-orders.',
    pitfalls: [
      'next_cursor rides in data (not meta): pass it back as ?cursor= until it is null.',
      'An executed order stays open until its bank debit is matched to the invoice (matched_at); the invoice shows as unpaid until then.',
      'outcome_unknown true means the bank may hold the payment while its answer was lost: nobody should pay the invoice again; a person resolves it in Accounted.',
    ],
    example: {
      response: { data: { payment_orders: [EXAMPLE_ORDER], next_cursor: null }, meta: META },
    },
  },
  input: z.object({
    status: LIST_STATUS,
    supplier_invoice_id: z.string().uuid().optional().describe('Only the orders that pay this supplier invoice.'),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_LIMIT)
      .default(DEFAULT_LIMIT)
      .describe(`Page size, 1-${MAX_LIMIT} (default ${DEFAULT_LIMIT}).`),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
  }),
  output: z.object({
    payment_orders: z.array(OrderOut),
    next_cursor: z.string().nullable(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payment-orders' },
  mcp: {
    name: 'gnubok_list_payment_orders',
    title: 'List Payment Orders',
    description:
      'List bank payments (betalningar via banken), newest first: status, amount, payee, reference, the bank\'s status and the ' +
      'supplier invoice paid. Filter by status, open, or supplier_invoice_id. Paginate with cursor = next_cursor.',
    keywords: [
      'bankbetalningar',
      'betalningar via banken',
      'lista betalningar',
      'betalstatus',
      'leverantörsbetalning bank',
      'bankid betalning',
      'betalningsuppdrag',
      'att signera',
    ],
  },
  run: async (ctx, input) => {
    const decoded = decodeDefaultCursor(input.cursor)
    let query = ctx.supabase
      .from('payment_orders')
      .select(
        'id, supplier_invoice_id, batch_id, status, amount, currency, requested_execution_date, cash_account_id, payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, payee_name, payee_source, payee_check, reference_type, reference, end_to_end_id, provider_status, provider_error_code, outcome_unknown_at, approved_at, submitted_at, signed_at, executed_at, cancelled_at, matched_at, created_at, updated_at, supplier_invoice:supplier_invoices(supplier_invoice_number, due_date, supplier:suppliers(name))',
      )
      .eq('company_id', ctx.companyId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(input.limit + 1)
    if (input.status === 'open') {
      // Open: not closed, and not an executed order whose debit is matched
      // (supplier_invoice_payment_id is set only by that settlement).
      query = query.not('status', 'in', CLOSED_STATUSES).is('supplier_invoice_payment_id', null)
    } else if (input.status !== 'all') {
      query = query.eq('status', input.status)
    }
    if (input.supplier_invoice_id) query = query.eq('supplier_invoice_id', input.supplier_invoice_id)
    if (decoded) {
      query = query.or(`created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.lt.${decoded.id})`)
    }
    const { data, error } = await query
    if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
    const rows = (data ?? []) as unknown as Array<OrderSelectRow & { created_at: string; id: string }>
    const nextCursor = nextCursorFromPage(rows, input.limit)
    return {
      ok: true,
      data: { payment_orders: rows.slice(0, input.limit).map(toOrderOut), next_cursor: nextCursor },
    }
  },
})

export const paymentOrdersGet = defineOperation({
  id: 'payment-orders.get',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one bank payment order.',
    description:
      'Returns the order with its payee (as the order carries it, with its check), reference, status, the bank\'s own status and ' +
      'error code, its timestamps and the supplier invoice it pays.',
    useWhen: 'Checking where one payment stands.',
    doNotUseFor: 'Several orders at once (GET /payment-orders).',
    pitfalls: ['An order of another company answers 404, like one that does not exist.'],
    example: { response: { data: EXAMPLE_ORDER, meta: META } },
  },
  input: z.object({ payment_order_id: ORDER_ID }),
  output: OrderOut,
  errorCodes: ['PAYMENT_ORDER_NOT_FOUND'],
  http: {
    method: 'GET',
    path: '/api/v1/companies/:companyId/payment-orders/:id',
    pathParams: { id: 'payment_order_id' },
  },
  run: async (ctx, { payment_order_id }) => {
    const { data, error } = await ctx.supabase
      .from('payment_orders')
      .select(
        'id, supplier_invoice_id, batch_id, status, amount, currency, requested_execution_date, cash_account_id, payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban, payee_name, payee_source, payee_check, reference_type, reference, end_to_end_id, provider_status, provider_error_code, outcome_unknown_at, approved_at, submitted_at, signed_at, executed_at, cancelled_at, matched_at, created_at, updated_at, supplier_invoice:supplier_invoices(supplier_invoice_number, due_date, supplier:suppliers(name))',
      )
      .eq('company_id', ctx.companyId)
      .eq('id', payment_order_id)
      .maybeSingle()
    if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
    if (!data) return { ok: false, code: 'PAYMENT_ORDER_NOT_FOUND' }
    return { ok: true, data: toOrderOut(data as unknown as OrderSelectRow) }
  },
})

// ─────────────────────────────────────────────────────────────────
// prepare
// ─────────────────────────────────────────────────────────────────

const SKIP_REASON = z
  .enum([
    'not_payable',
    'nothing_remaining',
    'credit_note',
    'foreign_currency',
    'payee_missing',
    'payee_invalid',
    'reference_missing',
    'not_found',
    'in_bank_payment',
    'in_payment_file',
    'already_in_payment',
  ])
  .describe(
    'not_payable: not approved (or paid, credited...); nothing_remaining; credit_note; foreign_currency (only SEK); payee_missing / payee_invalid ' +
      '(the supplier card has no valid bankgiro, plusgiro or clearing + account); reference_missing; not_found; in_payment_file (sits in an ' +
      'active betalfil: cancel it first); already_in_payment (an open bank payment covers the invoice).',
  )

const PrepareWarning = z.object({
  supplier_invoice_id: z.string().uuid(),
  code: z
    .enum(['unattested', 'ocr_invalid', 'payee_changed', 'payee_new'])
    .describe(
      'unattested: the invoice is not attested; ocr_invalid: the OCR fails its check digit, so the invoice number goes as a message; ' +
        'payee_changed: the account differs from the supplier card; payee_new: never confirmed for this supplier. The payee warnings ' +
        'need a person\'s confirmation at approval.',
    ),
  alternative_payee: z.string().nullable().optional().describe('For payee_changed: the other account, as a label, so the person can compare.'),
})

export const paymentOrdersPrepare = defineOperation({
  id: 'payment-orders.prepare',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: true,
  docs: {
    summary: 'Prepare draft bank payments (betalningar via banken) for supplier invoices.',
    description:
      'Creates one draft payment order per payable supplier invoice, from one of the company\'s own bank accounts: the remaining ' +
      'amount, the due date (or today when it has passed) unless execution_date is given, the supplier\'s bankgiro, plusgiro or bank ' +
      'account, and the OCR or invoice number as reference. Nothing reaches the bank: a draft is approved by a person ' +
      '(POST /payment-orders/approve) and then signed with BankID on the Betalningar page in Accounted. The database decides each ' +
      'order\'s payee check (known, new, changed) from the supplier card, the invoice and payments a person already approved; new and ' +
      'changed accounts need that person\'s confirmation at approval. Invoices that cannot be paid are skipped with a reason; the ' +
      'request fails only when nothing is payable. Dry-runnable: ?dry_run=true answers the lines without creating anything.',
    useWhen:
      'The user wants to pay approved supplier invoices from their bank account in Accounted instead of a payment file. Call with the ' +
      'invoices and the account; then hand the person the Betalningar link (GET /payment-orders/signing-link).',
    doNotUseFor:
      'A payment file (POST /supplier-payment-batches), marking an invoice paid (mark-paid), or signing: no API or MCP door signs.',
    pitfalls: [
      'PAYMENTS_UNAVAILABLE: bank payments are not switched on for the company (no provider, or a sandbox company). Check GET /payment-orders/availability first.',
      'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE: the account needs a Swedish IBAN in SEK, enabled, at a bank the provider reaches; details.reason says which.',
      'PAYMENT_ORDERS_INELIGIBLE: no invoice in the selection is payable; details.skipped names each reason.',
      'An invoice already in an open bank payment or an active betalfil is skipped (already_in_payment, in_payment_file), never paid twice.',
      'use_stated_payee_for pays the account the invoice states instead of the supplier card for the listed invoices; the database then marks the order\'s payee changed and a person confirms it at approval.',
      'Only SEK; at most 100 invoices per call; execution_date may not be in the past.',
    ],
    example: {
      request: { supplier_invoice_ids: [EXAMPLE_INVOICE_ID], cash_account_id: EXAMPLE_ACCOUNT_ID },
      response: {
        data: {
          payment_orders: [{ ...EXAMPLE_ORDER, supplier_invoice: null }],
          skipped: [],
          warnings: [],
          next: { approve: '/api/v1/companies/{companyId}/payment-orders/approve', sign_in_app: 'https://app.accounted.se/payments' },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    supplier_invoice_ids: z
      .array(z.string().uuid())
      .min(1)
      .max(100)
      .describe('The supplier invoices to pay (supplier_invoice_id), 1-100. Only SEK.'),
    cash_account_id: z
      .string()
      .uuid()
      .describe('The company bank account to pay from (cash_account_id from GET /payment-orders/availability, payable true).'),
    execution_date: isoDateSchema
      .optional()
      .describe('YYYY-MM-DD for every order; defaults per invoice to the due date, or today when that has passed. Never in the past.'),
    use_stated_payee_for: z
      .array(z.string().uuid())
      .max(100)
      .optional()
      .describe('Invoice ids where the account the invoice states is paid instead of the supplier card.'),
  }),
  output: z.object({
    payment_orders: z.array(OrderOut),
    skipped: z.array(z.object({ supplier_invoice_id: z.string().uuid(), reason: SKIP_REASON })),
    warnings: z.array(PrepareWarning),
    next: z.object({
      approve: z.string().describe('The v1 path that attests the drafts (a person\'s API key).'),
      sign_in_app: z.string().describe('The Betalningar page where a person approves and signs with BankID.'),
    }),
  }),
  errorCodes: [
    'PAYMENTS_UNAVAILABLE',
    'PAYMENT_ORDERS_EMPTY_SELECTION',
    'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
    'PAYMENT_ORDERS_INELIGIBLE',
    'PAYMENT_ORDERS_ALREADY_IN_PAYMENT',
    'PAYMENT_ORDERS_IN_PAYMENT_FILE',
    'PAYMENT_ORDERS_AMOUNT_EXCEEDS_REMAINING',
    'PAYMENT_ORDERS_CURRENCY_MISMATCH',
    'PAYMENT_ORDERS_PAYEE_MISMATCH',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/payment-orders' },
  mcp: {
    name: 'gnubok_prepare_payments',
    title: 'Prepare Bank Payments',
    description:
      'Stage draft bank payments for supplier invoices from a company account. Nothing reaches the bank: a person approves and signs ' +
      'with BankID on the Betalningar page (gnubok_get_payments_signing_link). Agents prepare, never sign.',
    keywords: [
      'betala via banken',
      'bankbetalning',
      'förbered betalning',
      'betala leverantörsfaktura',
      'leverantörsbetalning',
      'betalningsuppdrag',
      'bankid betalning',
      'open payments',
    ],
    stage: {
      pendingType: 'prepare_payment_orders',
      title: (input) => {
        const count = Array.isArray(input.supplier_invoice_ids) ? input.supplier_invoice_ids.length : 0
        return `Förbered bankbetalning: ${count} ${count === 1 ? 'leverantörsfaktura' : 'leverantörsfakturor'}`
      },
    },
  },
  run: async (ctx, input, { dryRun }) => {
    const outcome = await preparePaymentOrders(ctx, {
      supplierInvoiceIds: input.supplier_invoice_ids,
      cashAccountId: input.cash_account_id,
      executionDate: input.execution_date ?? null,
      useStatedPayeeFor: input.use_stated_payee_for,
      today: todayIsoStockholm(),
      dryRun,
    })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      created: true,
      data: {
        payment_orders: outcome.data.orders.map((order) => toOrderOut(order)),
        skipped: outcome.data.skipped,
        warnings: outcome.data.warnings,
        next: {
          approve: '/api/v1/companies/{companyId}/payment-orders/approve',
          sign_in_app: paymentsPageUrl(outcome.data.orders.map((order) => order.id)),
        },
      },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// approve / unapprove
// ─────────────────────────────────────────────────────────────────

/** What approve and un-approve show on a dry run: the orders as they stand. */
async function orderStatusPreview(ctx: OperationContext, orderIds: string[]): Promise<Record<string, unknown>> {
  const { data, error } = await ctx.supabase
    .from('payment_orders')
    .select('id, supplier_invoice_id, status, payee_check, amount, currency')
    .eq('company_id', ctx.companyId)
    .in('id', orderIds)
  if (error) throw error
  const rows = (data ?? []) as Array<{
    id: string
    supplier_invoice_id: string | null
    status: string
    payee_check: string
    amount: number
    currency: string
  }>
  return {
    payment_orders: rows.map((row) => ({
      payment_order_id: row.id,
      supplier_invoice_id: row.supplier_invoice_id,
      status: row.status,
      payee_check: row.payee_check,
      amount: Number(row.amount),
      currency: row.currency,
    })),
    missing: orderIds.filter((id) => !rows.some((row) => row.id === id)),
    needs_payee_confirmation: rows
      .filter((row) => row.payee_check === 'new' || row.payee_check === 'changed')
      .map((row) => row.supplier_invoice_id),
  }
}

export const paymentOrdersApprove = defineOperation({
  id: 'payment-orders.approve',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'high',
  reversible: true,
  docs: {
    summary: 'Approve (attest) draft bank payments so they can be signed.',
    description:
      'Moves draft orders to approved: the attestation that these invoices are to be paid, from this account, to these payees. ' +
      'An order to an account that is new for the supplier or differs from the supplier card (payee.check new or changed) needs ' +
      'its invoice named in confirmed_payee_invoice_ids: one confirmation per invoice, never one flag for a whole selection. ' +
      'Nothing reaches the bank: signing with BankID happens on the Betalningar page, by a person. All or nothing: a draft that ' +
      'changed meanwhile fails the request. Undo with POST /payment-orders/unapprove.',
    useWhen: 'The person behind the API key has checked the drafts and attests them before signing in Accounted.',
    doNotUseFor: 'Signing (only a person signs, in Accounted) or preparing (POST /payment-orders).',
    pitfalls: [
      'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED: details.invoices lists the invoices whose account must be confirmed; resend with them in confirmed_payee_invoice_ids after checking the account.',
      'PAYMENT_ORDERS_WRONG_STATUS: an order is no longer a draft (details.orders); reload and select again.',
      'Not offered over MCP: attestation is a person\'s act. An agent prepares and hands out the Betalningar link.',
    ],
    example: {
      request: { payment_order_ids: [EXAMPLE_ORDER_ID] },
      response: { data: { approved_payment_order_ids: [EXAMPLE_ORDER_ID], sign_in_app: 'https://app.accounted.se/payments' }, meta: META },
    },
  },
  input: z.object({
    payment_order_ids: ORDER_IDS,
    confirmed_payee_invoice_ids: z
      .array(z.string().uuid())
      .max(100)
      .optional()
      .describe('Supplier invoice ids whose payee account the person checked; required for every order with payee.check new or changed.'),
  }),
  output: z.object({
    approved_payment_order_ids: z.array(z.string().uuid()),
    sign_in_app: z.string().describe('The Betalningar page where a person signs the approved orders with BankID.'),
  }),
  errorCodes: [
    'PAYMENT_ORDERS_EMPTY_SELECTION',
    'PAYMENT_ORDER_NOT_FOUND',
    'PAYMENT_ORDERS_WRONG_STATUS',
    'PAYMENT_ORDERS_PAYEE_CONFIRMATION_REQUIRED',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/payment-orders/approve' },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) return { ok: true, dryRun: true, preview: await orderStatusPreview(ctx, input.payment_order_ids) }
    const outcome = await approvePaymentOrders(ctx, {
      orderIds: input.payment_order_ids,
      confirmedPayeeInvoiceIds: input.confirmed_payee_invoice_ids,
    })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { approved_payment_order_ids: outcome.data.approved, sign_in_app: paymentsPageUrl(outcome.data.approved) },
    }
  },
})

export const paymentOrdersUnapprove = defineOperation({
  id: 'payment-orders.unapprove',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Take approved bank payments back to draft.',
    description:
      'Moves approved orders back to draft so they can be edited or cancelled before signing. Only orders the bank does not have ' +
      'yet (status approved) can go back; anything submitted is cancelled instead (POST /payment-orders/{id}/cancel). All or nothing.',
    useWhen: 'An attested payment should not be signed as it stands.',
    doNotUseFor: 'Stopping a payment the bank has (cancel) or removing a draft (cancel).',
    pitfalls: ['PAYMENT_ORDERS_WRONG_STATUS: an order is not approved any more (details.unapproved lists what did move).'],
    example: {
      request: { payment_order_ids: [EXAMPLE_ORDER_ID] },
      response: { data: { unapproved_payment_order_ids: [EXAMPLE_ORDER_ID] }, meta: META },
    },
  },
  input: z.object({ payment_order_ids: ORDER_IDS }),
  output: z.object({ unapproved_payment_order_ids: z.array(z.string().uuid()) }),
  errorCodes: ['PAYMENT_ORDERS_EMPTY_SELECTION', 'PAYMENT_ORDERS_WRONG_STATUS'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/payment-orders/unapprove' },
  run: async (ctx, input, { dryRun }) => {
    if (dryRun) return { ok: true, dryRun: true, preview: await orderStatusPreview(ctx, input.payment_order_ids) }
    const outcome = await unapprovePaymentOrders(ctx, { orderIds: input.payment_order_ids })
    if (!outcome.ok || outcome.dryRun) return outcome
    return { ok: true, data: { unapproved_payment_order_ids: outcome.data.unapproved } }
  },
})

// ─────────────────────────────────────────────────────────────────
// cancel
// ─────────────────────────────────────────────────────────────────

export const paymentOrdersCancel = defineOperation({
  id: 'payment-orders.cancel',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Cancel a bank payment order.',
    description:
      'Before the bank has the payment (draft, approved) the order is cancelled in Accounted. After that the bank is asked, and the ' +
      'order is cancelled only when the bank confirms the cancel; any other bank answer leaves the payment where it is and is ' +
      'reported as an error code. An executed payment cannot be cancelled. An order whose bank outcome is unknown is not cancelled ' +
      'here: a person resolves it in Accounted after checking the online bank. Dry-runnable.',
    useWhen: 'A prepared or approved payment should not be made, or a payment the bank holds must be stopped before execution.',
    doNotUseFor: 'Un-paying an invoice, or an executed payment (ask the bank to recall it).',
    pitfalls: [
      'PAYMENT_CANCEL_NEEDS_SIGNING: the bank wants the cancel signed; cancel it in the online bank.',
      'PAYMENT_CANCEL_TOO_LATE: executed, or past the bank\'s cut-off.',
      'PAYMENT_CANCEL_NOT_CONFIRMED: the bank did not confirm; check the payment in the online bank. The order is unchanged.',
      'PAYMENT_CANCEL_CONFIRMATION_REQUIRED: the bank may hold the payment but its answer was lost; a person resolves the order in Accounted.',
      'PAYMENT_ORDER_CREATE_IN_PROGRESS: the payment is on its way to the bank right now; wait a few minutes.',
    ],
    example: {
      response: { data: { payment_order_id: EXAMPLE_ORDER_ID, cancelled: true, status: 'cancelled' }, meta: META },
    },
  },
  input: z.object({ payment_order_id: ORDER_ID }),
  output: z.object({
    payment_order_id: z.string().uuid(),
    cancelled: z.boolean(),
    status: z.string().describe('The order\'s status after the answer.'),
  }),
  errorCodes: [
    'PAYMENT_ORDER_NOT_FOUND',
    'PAYMENT_ORDERS_WRONG_STATUS',
    'PAYMENT_ORDER_CREATE_IN_PROGRESS',
    'PAYMENT_CANCEL_CONFIRMATION_REQUIRED',
    'PAYMENT_CANCEL_NEEDS_SIGNING',
    'PAYMENT_CANCEL_TOO_LATE',
    'PAYMENT_CANCEL_NOT_CONFIRMED',
    'PAYMENTS_UNAVAILABLE',
    'PAYMENT_PROVIDER_UNAVAILABLE',
    'PAYMENT_PROVIDER_REFUSED',
  ],
  http: {
    method: 'POST',
    path: '/api/v1/companies/:companyId/payment-orders/:id/cancel',
    pathParams: { id: 'payment_order_id' },
  },
  mcp: {
    name: 'gnubok_cancel_payment_order',
    title: 'Cancel Payment Order',
    description:
      'Stage cancelling a bank payment. Before the bank has it the draft is cancelled in Accounted; after that the bank is asked and ' +
      'the order is cancelled only when the bank confirms. An executed payment cannot be cancelled.',
    keywords: ['makulera betalning', 'avbryt bankbetalning', 'stoppa betalning', 'ta bort betalningsuppdrag', 'återkalla betalning'],
    stage: { pendingType: 'cancel_payment_order', title: () => 'Makulera bankbetalning' },
  },
  run: async (ctx, { payment_order_id }, { dryRun }) => {
    const outcome = await cancelPaymentOrder(ctx, { orderId: payment_order_id, dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    return {
      ok: true,
      data: { payment_order_id, cancelled: outcome.data.cancelled, status: outcome.data.status },
    }
  },
})

// ─────────────────────────────────────────────────────────────────
// availability / verification
// ─────────────────────────────────────────────────────────────────

export const paymentsAvailability = defineOperation({
  id: 'payments.availability',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Whether the company can pay through its bank from Accounted, and from which accounts.',
    description:
      'Answers available (a payment provider serves this installation, the company is on a paid plan and it is not a sandbox), ' +
      'why not when it is false (reason: no_provider, not_in_pilot, subscription, sandbox), the provider, and the company\'s bank accounts with ' +
      'payable true or a reason (account_disabled, not_sek, iban_missing, bank_unknown). signer_known says whether the calling ' +
      'person has a BankID login on file, so signing needs no typed personnummer. IBANs are masked.',
    useWhen: 'Before preparing a bank payment: pick a payable cash_account_id.',
    doNotUseFor: 'Payment files, which need no provider (GET /supplier-payment-batches/preview).',
    pitfalls: [
      'available false means POST /payment-orders answers PAYMENTS_UNAVAILABLE; pay with a payment file instead.',
      'reason subscription: bank payments are part of the paid plan; the company upgrades under Inställningar, Abonnemang.',
    ],
    example: {
      response: {
        data: {
          available: true,
          reason: null,
          provider: 'open_payments',
          accounts: [{ cash_account_id: EXAMPLE_ACCOUNT_ID, name: 'Företagskonto', ledger_account: '1930', iban: 'SE35 **** 0003', payable: true, reason: null }],
          signer_known: true,
        },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({
    available: z.boolean(),
    reason: z.enum(['no_provider', 'not_in_pilot', 'subscription', 'sandbox']).nullable().describe('Why available is false; null when it is true.'),
    provider: z.string().nullable(),
    accounts: z.array(
      z.object({
        cash_account_id: z.string().uuid(),
        name: z.string().nullable(),
        ledger_account: z.string(),
        iban: z.string().nullable().describe('Masked to country, check digits and the last four.'),
        payable: z.boolean(),
        reason: z.enum(['account_disabled', 'not_sek', 'iban_missing', 'bank_unknown']).nullable(),
      }),
    ),
    signer_known: z.boolean(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payment-orders/availability' },
  run: async (ctx) => {
    const availability = await getPaymentsAvailability(ctx)
    return {
      ok: true,
      data: {
        available: availability.available,
        reason: availability.reason,
        provider: availability.provider,
        accounts: availability.accounts.map((account) => ({
          cash_account_id: account.id,
          name: account.name,
          ledger_account: account.ledger_account,
          iban: account.iban ? maskIban(account.iban) : null,
          payable: account.payable,
          reason: account.reason,
        })),
        signer_known: availability.signer_known,
      },
    }
  },
})

const Verification = z.object({
  status: z
    .enum(['valid', 'invalid', 'unknown'])
    .describe('valid: payments are allowed. invalid: not verified, or the verification failed or lapsed. unknown: the provider gave no answer.'),
  valid_until: z.string().nullable().describe('YYYY-MM-DD, when the provider reports it.'),
})

export const paymentsVerification = defineOperation({
  id: 'payments.verification',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The company\'s verification (know your customer) at the payment provider.',
    description:
      'Asks the provider whether it has verified the company. Payments are refused until the status is valid. A missing or lapsed ' +
      'verification is started with POST /payment-orders/verification/start, which answers a form a signatory fills in and signs.',
    useWhen: 'Bank payments are available but signing is refused for the company, or before the first payment.',
    doNotUseFor: 'Whether payments are switched on at all (GET /payment-orders/availability).',
    pitfalls: ['PAYMENT_PROVIDER_UNAVAILABLE is transient: the provider did not answer; try again shortly.'],
    example: { response: { data: { status: 'valid', valid_until: '2027-10-03' }, meta: META } },
  },
  input: z.object({}),
  output: Verification,
  errorCodes: ['PAYMENTS_UNAVAILABLE', 'PAYMENT_PROVIDER_UNAVAILABLE', 'PAYMENT_PROVIDER_REFUSED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payment-orders/verification' },
  run: async (ctx) => getCompanyPaymentVerification(ctx),
})

export const paymentsVerificationStart = defineOperation({
  id: 'payments.verification-start',
  kind: 'write',
  scope: 'suppliers:write',
  risk: 'low',
  reversible: true,
  docs: {
    summary: 'Start the company\'s verification at the payment provider and get the form link.',
    description:
      'Creates a verification at the provider and answers the link to its form, which a signatory of the company fills in and ' +
      'signs with BankID (valid for a limited time; starting again makes a new form). The provider approves afterwards; read the ' +
      'result with GET /payment-orders/verification. Changes nothing in the books.',
    useWhen: 'GET /payment-orders/verification answers invalid.',
    doNotUseFor: 'Checking the status (GET /payment-orders/verification).',
    pitfalls: ['The link is for a person who may sign for the company; it is not an API.'],
    example: { response: { data: { url: 'https://kyc.openbankingplatform.com/…' }, meta: META } },
  },
  input: z.object({}),
  output: z.object({ url: z.string() }),
  errorCodes: ['PAYMENTS_UNAVAILABLE', 'PAYMENT_PROVIDER_UNAVAILABLE', 'PAYMENT_PROVIDER_REFUSED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/payment-orders/verification/start', requireIdempotencyKey: false },
  run: async (ctx, _input, { dryRun }) => {
    if (dryRun) return { ok: true, dryRun: true, preview: { action: 'start_company_verification' } }
    return startCompanyPaymentVerification(ctx)
  },
})

// ─────────────────────────────────────────────────────────────────
// signing link
// ─────────────────────────────────────────────────────────────────

const OPEN_FOR_SIGNING_STATUSES = ['draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'] as const

export const paymentsSigningLink = defineOperation({
  id: 'payments.signing-link',
  kind: 'read',
  scope: 'suppliers:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The Betalningar page link where a person approves and signs bank payments, with what is waiting there.',
    description:
      'Answers the URL of the Betalningar page in Accounted (optionally with orders preselected), how many orders wait for ' +
      'approval, how many wait for a BankID signing, how many the bank holds, how many have an unknown bank outcome, and the ' +
      'company\'s verification at the provider when it answers. Approval and signing are a person\'s acts in Accounted; no door here ' +
      'does them.',
    useWhen: 'After preparing payments, to hand the person the place where they sign; or to report what is waiting.',
    doNotUseFor: 'The orders themselves (GET /payment-orders).',
    pitfalls: ['verification is null when the provider did not answer in time; it is informational here.'],
    example: {
      response: {
        data: {
          url: 'https://app.accounted.se/payments?orders=7c2e…',
          awaiting_approval: 1,
          awaiting_signature: 0,
          at_bank: 0,
          outcome_unknown: 0,
          verification: { status: 'valid', valid_until: '2027-10-03' },
          note: SIGNING_NOTE,
        },
        meta: META,
      },
    },
  },
  input: z.object({
    payment_order_ids: z
      .string()
      .optional()
      .describe('Comma-separated payment_order_id values to preselect on the page; omit for the page as it stands.'),
  }),
  output: z.object({
    url: z.string(),
    awaiting_approval: z.number().int().describe('Draft orders.'),
    awaiting_signature: z.number().int().describe('Approved orders not yet signed.'),
    at_bank: z.number().int().describe('Orders the bank holds and has not finished with.'),
    outcome_unknown: z.number().int().describe('Orders whose bank answer was lost; a person resolves them.'),
    verification: Verification.nullable(),
    note: z.string(),
  }),
  http: { method: 'GET', path: '/api/v1/companies/:companyId/payment-orders/signing-link' },
  mcp: {
    name: 'gnubok_get_payments_signing_link',
    title: 'Get Payments Signing Link',
    description:
      'The link to the Betalningar page where a person approves and signs bank payments with BankID, with how many orders wait for ' +
      'approval, for signing or at the bank, and the company\'s provider verification. Agents hand out the link; a person signs.',
    keywords: ['signera betalningar', 'bankid signering', 'betalningar att signera', 'länk betalningar', 'godkänn betalningar', 'betalningssida'],
  },
  run: async (ctx, input) => {
    const ids = (input.payment_order_ids ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    const invalid = ids.filter((id) => !z.string().uuid().safeParse(id).success)
    if (invalid.length > 0) {
      return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'payment_order_ids', invalid } }
    }
    const { data, error } = await ctx.supabase
      .from('payment_orders')
      .select('id, status, outcome_unknown_at')
      .eq('company_id', ctx.companyId)
      .in('status', [...OPEN_FOR_SIGNING_STATUSES])
      .limit(1000)
    if (error) return { ok: false, code: 'INTERNAL_ERROR', error }
    const rows = (data ?? []) as Array<{ id: string; status: string; outcome_unknown_at: string | null }>
    let verification: z.infer<typeof Verification> | null = null
    try {
      const outcome = await getCompanyPaymentVerification(ctx)
      if (outcome.ok && !outcome.dryRun) verification = outcome.data
    } catch (err) {
      ctx.log.warn('payments verification not read for the signing link', { err: err instanceof Error ? err.message : String(err) })
    }
    return {
      ok: true,
      data: {
        url: paymentsPageUrl(ids),
        awaiting_approval: rows.filter((row) => row.status === 'draft').length,
        awaiting_signature: rows.filter((row) => row.status === 'approved').length,
        at_bank: rows.filter((row) => row.status !== 'draft' && row.status !== 'approved').length,
        outcome_unknown: rows.filter((row) => row.outcome_unknown_at !== null).length,
        verification,
        note: SIGNING_NOTE,
      },
    }
  },
})
