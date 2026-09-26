/**
 * /api/v1/companies/{companyId}/supplier-invoices: list + register endpoints.
 *
 * GET   : list with filters (status, supplier_id, currency, invoice_date range).
 *         Cursor pagination on (created_at DESC, id ASC).
 * POST  : register a new supplier invoice. Idempotent (mandatory Idempotency-Key).
 *         Dry-runnable.
 *
 * Lifecycle: a fresh SI is created in `registered` status. Under
 * faktureringsmetoden the registration JE (Debit expense + Debit 2641 / Credit
 * 2440) is posted in the same call: failure aborts and the SI row is rolled
 * back to avoid orphaning a half-baked AP balance.
 *
 * Under kontantmetoden no JE is posted at registration; recognition is
 * deferred to :mark-paid.
 *
 * `arrival_number` (ankomstnummer) is an internal counter; it does NOT carry
 * the BFL/ML 17 kap löpnummer obligation that customer invoices do. The
 * supplier-invoice number (`supplier_invoice_number`) is the seller's own
 * series and is preserved verbatim.
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
  PaginationQueryShape,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createSupplierInvoice } from '@/lib/supplier-invoices/create'

const SupplierInvoiceStatus = z.enum([
  'registered',
  'approved',
  'paid',
  'partially_paid',
  'overdue',
  'disputed',
  'credited',
  'reversed',
])

const SupplierInvoiceSummary = z.object({
  id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  supplier_name: z.string(),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: SupplierInvoiceStatus,
  currency: z.string(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  is_credit_note: z.boolean(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
})

const SupplierInvoicesListResponse = listEnvelope(SupplierInvoiceSummary)

// Explicit projection.
const SI_SUMMARY_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, status, currency, subtotal, vat_amount, total, paid_amount, remaining_amount, is_credit_note, paid_at, created_at'

const SUPPLIER_NAME_ONLY_COLUMNS = 'id, name'

const ListFilters = z.object({
  status: SupplierInvoiceStatus.optional().describe('Only supplier invoices in this status.'),
  supplier_id: z.string().uuid().optional().describe('Only invoices from this supplier (id).'),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code')
    .optional()
    .describe('3-letter ISO 4217 code, uppercase (e.g. SEK, EUR).'),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be ISO YYYY-MM-DD')
    .optional()
    .describe('YYYY-MM-DD. Invoices with invoice_date on or after this date.'),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be ISO YYYY-MM-DD')
    .optional()
    .describe('YYYY-MM-DD. Invoices with invoice_date on or before this date.'),
})

const ListQuery = ListFilters.extend(PaginationQueryShape)

registerEndpoint({
  operation: 'supplier-invoices.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/supplier-invoices',
  summary: 'List supplier invoices for a company.',
  description:
    'Cursor-paginated supplier-invoice list ordered by created_at DESC, id ASC (newest-registered first; the `invoice_date` column is the seller\'s invoice date and is filterable via ?date_from / ?date_to but is not the sort key). Filters: status, supplier_id, currency, date_from / date_to (filter by invoice_date).',
  useWhen:
    'You need to enumerate registered supplier invoices for an AP dashboard, a payment run, or a leverantörsreskontra reconciliation.',
  doNotUseFor:
    'Fetching a single supplier invoice: use GET /supplier-invoices/{id}. Listing customer invoices (different resource).',
  pitfalls: [
    'Credit notes (is_credit_note=true) appear in the same list as the originals; filter by status=credited or check the flag to separate.',
    'remaining_amount is the unpaid portion; a partially_paid SI has remaining_amount > 0.',
    'arrival_number is internal book-keeping, not the seller\'s invoice number: use supplier_invoice_number for matching to received documents.',
    'Ordering is by created_at (registration time), not invoice_date. A late-registered invoice appears where it was registered: filter on ?date_from / ?date_to when you care about the seller\'s invoice date.',
    'Cursor pagination: pass ?cursor=<next_cursor> from the previous response. A stale or tampered cursor is ignored and the first page is returned again.',
  ],
  example: {
    response: {
      data: [
        {
          id: '0e9c…',
          supplier_id: 'a8f1…',
          supplier_name: 'Office Depot AB',
          arrival_number: 42,
          supplier_invoice_number: '2026-1234',
          invoice_date: '2026-05-10',
          due_date: '2026-06-09',
          status: 'registered',
          currency: 'SEK',
          subtotal: 1000,
          vat_amount: 250,
          total: 1250,
          paid_amount: 0,
          remaining_amount: 1250,
          is_credit_note: false,
          paid_at: null,
          created_at: '2026-05-13T15:00:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'suppliers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: ListQuery },
  response: { success: SupplierInvoicesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'supplier-invoices.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const filtersResult = ListFilters.safeParse({
      status: url.searchParams.get('status') ?? undefined,
      supplier_id: url.searchParams.get('supplier_id') ?? undefined,
      currency: url.searchParams.get('currency') ?? undefined,
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
    })
    if (!filtersResult.success) return v1ValidationError(ctx, filtersResult.error)
    const filters = filtersResult.data

    // Sort by (created_at DESC, id ASC). created_at is the stable cursor
    // anchor: it's a real timestamp (passes ISO-8601 validation in
    // decodeDefaultCursor), NOT NULL, and total-orderable once id breaks
    // ties. Sorting by `invoice_date` directly broke the cursor: a Postgres
    // `date` serializes as YYYY-MM-DD, the decoder rejected it, the keyset
    // predicate was never applied, and every "next page" silently returned
    // page 1 forever while still advertising a fresh next_cursor.
    // invoice_date is still on every row and ?date_from / ?date_to filter
    // on it. Same anchor as the transactions list.
    let query = ctx.supabase
      .from('supplier_invoices')
      .select(`${SI_SUMMARY_COLUMNS}, supplier:suppliers(${SUPPLIER_NAME_ONLY_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (filters.status) query = query.eq('status', filters.status)
    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.currency) query = query.eq('currency', filters.currency)
    if (filters.date_from) query = query.gte('invoice_date', filters.date_from)
    if (filters.date_to) query = query.lte('invoice_date', filters.date_to)

    if (decoded) {
      // Keyset on (created_at DESC, id ASC): created_at moves backward,
      // id breaks ties within the same timestamp.
      query = query.or(
        `created_at.lt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query
    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type SupplierObj = { id: string; name: string } & Record<string, unknown>
    type Row = {
      id: string
      supplier_id: string
      arrival_number: number
      supplier_invoice_number: string
      invoice_date: string
      due_date: string
      status: string
      currency: string
      subtotal: number
      vat_amount: number
      total: number
      paid_amount: number
      remaining_amount: number
      is_credit_note: boolean
      paid_at: string | null
      created_at: string
      supplier: SupplierObj | SupplierObj[] | null
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const pickSupplier = (s: Row['supplier']): SupplierObj | null => {
      if (!s) return null
      return Array.isArray(s) ? (s[0] ?? null) : s
    }

    const supplier_invoices = trimmed.map((r) => {
      const s = pickSupplier(r.supplier)
      return {
        id: r.id,
        supplier_id: r.supplier_id,
        supplier_name: s?.name ?? '',
        arrival_number: r.arrival_number,
        supplier_invoice_number: r.supplier_invoice_number,
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        status: r.status,
        currency: r.currency,
        subtotal: r.subtotal,
        vat_amount: r.vat_amount,
        total: r.total,
        paid_amount: r.paid_amount,
        remaining_amount: r.remaining_amount,
        is_credit_note: r.is_credit_note,
        paid_at: r.paid_at,
        created_at: r.created_at,
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(supplier_invoices, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: register supplier invoice
// ──────────────────────────────────────────────────────────────────

// default_dimensions must stay in this projection: the inserted row is passed
// straight to createSupplierInvoiceRegistrationEntry, which reads the bag off
// the row — dropping the column here silently untags the registration JE.
const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, received_date, delivery_date, status, currency, exchange_rate, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, reverse_charge, payment_reference, paid_amount, remaining_amount, is_credit_note, credited_invoice_id, registration_journal_entry_id, payment_journal_entry_id, notes, default_dimensions, created_at, updated_at'

const SI_ITEMS_RESPONSE_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate, apply_slp, dimensions'

const SupplierInvoiceCreated = z.object({
  id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: z.string(),
  currency: z.string(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  remaining_amount: z.number(),
  is_credit_note: z.boolean(),
  registration_journal_entry_id: z.string().uuid().nullable(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'supplier-invoices.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/supplier-invoices',
  summary: 'Register a new supplier invoice.',
  description:
    'Creates a supplier invoice in `registered` status and posts the registration journal entry under faktureringsmetoden (Debit expense + Debit 2641 Ingående moms / Credit 2440 Leverantörsskulder). Under kontantmetoden no JE is posted at this stage. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
  useWhen:
    'You\'re registering an incoming leverantörsfaktura. Use dry-run first to validate VAT calculations + period-lock state before committing.',
  doNotUseFor:
    'Marking an existing SI as paid (use POST /:id/mark-paid). Issuing a credit note (use POST /:id/credit). Customer invoices (different resource).',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'invoice_date must fall within an open fiscal period: a date covered by a locked period or the company-wide bookkeeping lock returns 400 PERIOD_LOCKED.',
    'Under faktureringsmetoden the registration JE is posted atomically with the SI row. JE failure aborts the whole call and no SI row is left behind (strict-mode).',
    'supplier_id must reference an existing, non-archived supplier in the same company: 404 SUPPLIER_NOT_FOUND otherwise.',
    'Duplicate (supplier_id, supplier_invoice_number) returns 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER. Use the credit flow on the original instead of re-registering with a tweaked number.',
    'Foreign currency: omit exchange_rate and the server fetches Riksbanken\'s rate for invoice_date (ML 8 kap 21-23 §). If no rate can be resolved the create is refused with 400 SI_FX_RATE_MISSING rather than stored unconverted: pass exchange_rate explicitly to proceed. A SEK invoice needs no rate and gets total_sek = total.',
    'exchange_rate is SEK per 1 unit of the invoice currency and must satisfy 0 < rate < 100000, the same bounds the supplier_invoices CHECK enforces. Out-of-range values return 400 VALIDATION_ERROR; passing an invoice total where a rate belongs is the usual cause.',
    'Project/cost-center tagging: pass default_dimensions ({"6":"P001"} = project, {"1":"KS01"} = kostnadsställe) for the whole invoice and/or items[].dimensions per line (per-line wins per key). The registration JE lines are tagged accordingly. When the company has the dimension registry enabled, unknown or archived codes are rejected with 400 DIMENSION_VALIDATION_FAILED — list valid codes via GET /dimensions.',
    'Tjänstepension invoices (Avanza etc.): set items[].apply_slp=true on the 741x premium line and the registration JE also books särskild löneskatt (debit 7533 / credit 2514 at 24.26% of the line amount) beyond the payable: 2440 stays at the invoice total. apply_slp on a non-741x account returns 400 SI_CREATE_SLP_INVALID_ACCOUNT.',
    'Underlag: upload the invoice PDF with POST /documents first and pass its id as document_id. The document is stored on the invoice and linked to the registration verifikat. A document that is missing, belongs to another company, or is already linked returns 400 SI_CREATE_INVALID_INPUT.',
    'Paid privately (eget utlägg): set paid_with_private_funds=true. The invoice is registered as paid and one verifikat books the expense against the payer: the owner (2893 AB, 2018 EF; claimant_name names them) or an employee (employee_id, 2820). payment_date is the out-of-pocket date (defaults to invoice_date). inbox_item_id takes the underlag from an inbox item and is only accepted on this path. Not combinable with reverse charge or periodisering.',
    'Periodisering: items[].accrual_period_start + accrual_period_end (and optionally accrual_balance_account, defaulting from the cost account) defer the cost over the period under faktureringsmetoden. Refused under kontantmetoden and with reverse charge.',
    'A company that is not VAT-registered cannot book input VAT: a line with vat_rate or vat_amount above 0 returns 400 SI_CREATE_INVALID_INPUT, and an omitted vat_rate defaults to 0. items[].vat_amount overrides line_total × vat_rate (partial deduction, rounding on the supplier\'s side).',
  ],
  example: {
    request: {
      supplier_id: 'a8f1…',
      supplier_invoice_number: '2026-1234',
      invoice_date: '2026-05-10',
      due_date: '2026-06-09',
      default_dimensions: { '6': 'P001' },
      items: [
        { description: 'Office supplies', amount: 1000, account_number: '5410', vat_rate: 0.25 },
      ],
    },
    response: {
      data: {
        id: '0e9c…',
        supplier_id: 'a8f1…',
        arrival_number: 42,
        supplier_invoice_number: '2026-1234',
        status: 'registered',
        total: 1250,
        registration_journal_entry_id: '7b3a…',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateSupplierInvoiceSchema },
  response: { success: dataEnvelope(SupplierInvoiceCreated) },
})

// Swedish VAT rates per ML 2 kap 1 § + Skatteverket's 2026 satser. Allow
// 0 (export / undantag / reverse charge), 6 (livsmedel / kultur), 12 (food
// service / hotel), 25 (default). A misstated rate flows straight into the
// registration JE → momsdeklaration Ruta 48 + INK2R, so an API caller's rate
// is checked here. The dashboard form takes any typed percentage, which is
// why this stays a door rule and not a service rule.
const ALLOWED_SV_VAT_RATES = new Set<number>([0, 0.06, 0.12, 0.25])

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'supplier-invoices.create',
  async (request, ctx) => {
    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = CreateSupplierInvoiceSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
    const body = parsed.data

    const badRate = body.items.findIndex(
      (item) => item.vat_rate != null && !ALLOWED_SV_VAT_RATES.has(item.vat_rate),
    )
    if (badRate !== -1) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [
            {
              field: `items[${badRate}].vat_rate`,
              message: 'vat_rate must be one of 0, 0.06, 0.12, or 0.25 (ML 2 kap 1 §).',
            },
          ],
          attempted_rate: body.items[badRate].vat_rate,
          allowed_rates: [0, 0.06, 0.12, 0.25],
        },
      })
    }

    // Every rule lives in the shared service, so this door and the dashboard
    // register an invoice the same way (lib/supplier-invoices/create.ts).
    const result = await createSupplierInvoice(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      body,
      { dryRun: ctx.dryRun },
    )
    if (!result.ok) {
      if (result.error) return v1ErrorResponse(result.error, ctx.log, { requestId: ctx.requestId })
      return v1ErrorResponseFromCode(result.code, ctx.log, {
        requestId: ctx.requestId,
        details: result.details,
      })
    }
    if (result.dryRun) {
      return dryRunPreview(result.preview, { requestId: ctx.requestId, log: ctx.log })
    }

    // Refetch with the response projection and the items.
    const { data: complete } = await ctx.supabase
      .from('supplier_invoices')
      .select(`${SI_RESPONSE_COLUMNS}, items:supplier_invoice_items(${SI_ITEMS_RESPONSE_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .eq('id', result.invoice.id)
      .maybeSingle()

    return created(
      complete ?? {
        ...result.invoice,
        items: result.items,
        registration_journal_entry_id: result.registrationJournalEntryId,
      },
      {
        requestId: ctx.requestId,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      },
    )
  },
  { requireIdempotencyKey: true },
)
