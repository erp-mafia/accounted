/**
 * /api/v1/companies/{companyId}/invoices: list + create invoice endpoints.
 *
 * GET: list with filters (status, customer_id, document_type, currency).
 *        Cursor pagination on (invoice_date DESC, id DESC).
 * POST: create draft invoice. Idempotent (mandatory Idempotency-Key).
 *        Dry-runnable (?dry_run=true returns the validated would-be
 *        invoice + items with computed VAT totals; no DB writes).
 *        Lifecycle: drafts have invoice_number=null until the :send action
 *        verb (PR-B-2b) triggers F-series allocation atomically. Delivery
 *        notes get a number on create from a separate D-series sequence.
 *        Rationale (ML 17 kap 24§ p.2): the löpnummer series must be
 *        unbroken AND cover only issued invoices: consuming numbers for
 *        drafts that get abandoned creates legal gaps.
 */

import { z } from 'zod'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1, type ApiV1Context } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { CreateInvoiceSchema } from '@/lib/api/schemas'
import { INVOICE_FULL_COLUMNS, INVOICE_ITEM_FULL_COLUMNS } from '@/lib/api/v1/invoice-columns'
import { buildInvoiceWriteData } from '@/lib/invoices/build-invoice-write'
import {
  resolveSelfBilledSaleDraft,
  createSelfBilledSaleInvoice,
  type SelfBilledSaleInput,
  type SelfBilledSaleFailure,
} from '@/lib/invoices/self-billed-sale'
import { eventBus } from '@/lib/events'
import type { Customer, Invoice, InvoiceDocumentType } from '@/types'

// Map a self-billed-sale service failure onto the v1 invoice error envelope.
function selfBilledFailureResponse(failure: SelfBilledSaleFailure, ctx: ApiV1Context) {
  const base = { requestId: ctx.requestId }
  switch (failure.code) {
    case 'customer_not_found':
      return v1ErrorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', ctx.log, { ...base, details: { resource: 'customer' } })
    case 'vat_rule_violation':
      return v1ErrorResponseFromCode('INVOICE_CREATE_VAT_RULE_VIOLATION', ctx.log, {
        ...base,
        details: {
          attempted_rate: failure.attemptedRate,
          allowed_rates: failure.allowedRates,
          customer_type: failure.customerType,
        },
      })
    case 'fx_rate_unavailable':
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        ...base,
        details: {
          field: 'currency',
          currency: failure.currency,
          invoice_date: failure.invoiceDate,
          message: `Ingen växelkurs för ${failure.currency} på fakturadatumet (${failure.invoiceDate}). Försök igen senare.`,
        },
      })
    case 'no_fiscal_period':
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        ...base,
        details: { field: 'invoice_date', message: 'Ingen öppen bokföringsperiod för fakturadatumet.' },
      })
    case 'insert_failed':
      return v1ErrorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', ctx.log, {
        ...base,
        details: { stage: failure.stage, pg_code: failure.pgCode },
      })
    case 'items_failed':
      return v1ErrorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctx.log, { ...base, details: { pg_code: failure.pgCode } })
  }
}

const InvoiceStatus = z.enum([
  'draft',
  'sent',
  'paid',
  'partially_paid',
  'overdue',
  'cancelled',
  'credited',
])

const InvoiceDocumentType = z.enum(['invoice', 'proforma', 'delivery_note'])

const InvoiceSummary = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  customer_name: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: InvoiceStatus,
  document_type: InvoiceDocumentType,
  currency: z.string(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  remaining_amount: z.number(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
})

const InvoicesListResponse = listEnvelope(InvoiceSummary)

const ALLOWED_EXPAND = ['customer', 'items'] as const

// Explicit projection: excludes user_id, company_id, and SEK-conversion
// fields not in the summary schema. Schema migrations adding columns must
// update this list before the field becomes visible on the public API.
const INVOICE_SUMMARY_COLUMNS =
  'id, invoice_number, customer_id, invoice_date, due_date, status, document_type, currency, subtotal, vat_amount, total, remaining_amount, paid_at, created_at'

// Customer projections: three tiers for different contexts:
//   - NAME_ONLY: default for the invoice list (inline customer_name only)
//   - LIST_CONTEXT: ?expand=customer in a LIST endpoint. Contact-summary
//     subset only: full PII like address/phone/notes/vat_number lives on
//     the dedicated customer detail endpoint. GDPR Art.5(1)(c)
//     data-minimisation: bulk fetches should not transmit a full PII
//     record per row.
// All projections deliberately omit user_id, company_id, and
// vat_number_validated_at (internal scoping / timestamp).
const CUSTOMER_NAME_ONLY_COLUMNS = 'id, name'
const CUSTOMER_LIST_CONTEXT_COLUMNS = 'id, name, customer_type, email, country, archived_at'

// Invoice items projection: excludes invoice_id (redundant) and internal
// linkage fields not in the documented response shape.
const INVOICE_ITEM_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, vat_rate, vat_amount, created_at'

registerEndpoint({
  operation: 'invoices.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/invoices',
  summary: 'List invoices for a company.',
  description:
    'Returns invoices in most-recent-first order. Includes the customer name inline; pass ?expand=customer for the full customer record, ?expand=items for line items.',
  useWhen:
    'You need to enumerate invoices for a company: for AR reporting, payment matching, or building an invoice dashboard.',
  doNotUseFor:
    'Fetching a single invoice you already know the id of: use GET /api/v1/companies/{companyId}/invoices/{id}. Supplier invoices are a different resource (supplier-invoices).',
  pitfalls: [
    'Draft invoices have invoice_number=null until they are sent.',
    'remaining_amount is the unpaid portion (total − paid_amount); use status=paid or remaining_amount=0 to filter for closed invoices.',
    'Credit notes appear with status=credited and a credited_invoice_id field on the detail endpoint.',
  ],
  example: {
    response: {
      data: [
        {
          id: '0e9c…',
          invoice_number: '2026-0042',
          customer_id: 'a8f1…',
          customer_name: 'Acme AB',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          status: 'sent',
          document_type: 'invoice',
          currency: 'SEK',
          subtotal: 10000,
          vat_amount: 2500,
          total: 12500,
          remaining_amount: 12500,
          paid_at: null,
          created_at: '2026-05-01T09:14:33Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'invoices:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: InvoicesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoices.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    // Validate ?expand against the allowlist; reject unknown values clearly.
    const expandResult = parseExpand(url, ALLOWED_EXPAND)
    if (!expandResult.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'expand',
          invalidKeys: expandResult.invalidKeys,
          allowed: expandResult.allowed,
        },
      })
    }
    const expand = expandResult.expand

    // Validate query filters. Currency is strict ISO-4217 (3 uppercase
    // letters): accepting arbitrary 3-8 char strings would pass through
    // to the DB filter without serving any documented purpose.
    const FiltersSchema = z.object({
      status: InvoiceStatus.optional(),
      customer_id: z.string().uuid().optional(),
      document_type: InvoiceDocumentType.optional(),
      currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code').optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      status: url.searchParams.get('status') ?? undefined,
      customer_id: url.searchParams.get('customer_id') ?? undefined,
      document_type: url.searchParams.get('document_type') ?? undefined,
      currency: url.searchParams.get('currency') ?? undefined,
    })
    if (!filtersResult.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: filtersResult.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const filters = filtersResult.data

    // Build the select clause. customer is always joined for the inline
    // customer_name; ?expand=customer upgrades it from a name-only shape to
    // the full record. ?expand=items pulls line items.
    const customerSelect = expand.has('customer')
      ? `customer:customers(${CUSTOMER_LIST_CONTEXT_COLUMNS})`
      : `customer:customers(${CUSTOMER_NAME_ONLY_COLUMNS})`
    const itemsSelect = expand.has('items') ? `, items:invoice_items(${INVOICE_ITEM_COLUMNS})` : ''
    const selectClause = `${INVOICE_SUMMARY_COLUMNS}, ${customerSelect}${itemsSelect}`

    let query = ctx.supabase
      .from('invoices')
      .select(selectClause)
      .eq('company_id', ctx.companyId!)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (filters.status) query = query.eq('status', filters.status)
    if (filters.customer_id) query = query.eq('customer_id', filters.customer_id)
    if (filters.document_type) query = query.eq('document_type', filters.document_type)
    if (filters.currency) query = query.eq('currency', filters.currency)

    if (decoded) {
      // Keyset on (invoice_date DESC, id DESC):
      //   invoice_date < ts OR (invoice_date = ts AND id < cursor_id)
      query = query.or(
        `invoice_date.lt.${decoded.ts},and(invoice_date.eq.${decoded.ts},id.lt.${decoded.id})`,
      )
    }

    const { data, error } = await query

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    // The joined customer can return as either an object or a single-element
    // array, mirroring the pattern in /companies. Pick safely.
    type CustomerObj = { id: string; name: string } & Record<string, unknown>
    type InvoiceRow = {
      id: string
      invoice_number: string | null
      customer_id: string
      invoice_date: string
      due_date: string
      status: string
      document_type: string
      currency: string
      subtotal: number
      vat_amount: number
      total: number
      remaining_amount: number
      paid_at: string | null
      created_at: string
      customer: CustomerObj | CustomerObj[] | null
      items?: unknown
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as InvoiceRow[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    const pickCustomer = (c: InvoiceRow['customer']): CustomerObj | null => {
      if (!c) return null
      return Array.isArray(c) ? (c[0] ?? null) : c
    }

    const invoices = trimmed.map((r) => {
      const c = pickCustomer(r.customer)
      const base = {
        id: r.id,
        invoice_number: r.invoice_number,
        customer_id: r.customer_id,
        customer_name: c?.name ?? '',
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        status: r.status,
        document_type: r.document_type,
        currency: r.currency,
        subtotal: r.subtotal,
        vat_amount: r.vat_amount,
        total: r.total,
        remaining_amount: r.remaining_amount,
        paid_at: r.paid_at,
        created_at: r.created_at,
      }
      return {
        ...base,
        ...(expand.has('customer') && c ? { customer: c } : {}),
        ...(expand.has('items') ? { items: r.items ?? [] } : {}),
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.invoice_date })
      : null

    return paginated(invoices, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST: create draft invoice (or proforma / delivery_note)
// ──────────────────────────────────────────────────────────────────

// Response projection on create: same shape as the detail endpoint
// (shared module so create/detail/patch never drift).
const INVOICE_RESPONSE_COLUMNS = INVOICE_FULL_COLUMNS
const INVOICE_ITEMS_RESPONSE_COLUMNS = INVOICE_ITEM_FULL_COLUMNS

// Loose response schema: invoices have many fields; pinning every one in
// the registry is overkill until we have a real schema-drift test.
const InvoiceCreated = z.object({
  id: z.string().uuid(),
  invoice_number: z.string().nullable(),
  customer_id: z.string().uuid(),
  invoice_date: z.string(),
  due_date: z.string(),
  status: z.string(),
  document_type: z.string(),
  currency: z.string(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  remaining_amount: z.number(),
  created_at: z.string(),
})

registerEndpoint({
  operation: 'invoices.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/invoices',
  summary: 'Create a draft invoice, proforma, or delivery note.',
  description:
    'Creates an invoice in draft status. The F-series invoice_number is allocated atomically on the first send action (PR-B-2b). Per-item VAT rates are validated against the customer\'s allowed rates (mixed-rate invoices supported). Non-SEK invoices are converted to SEK at the Riksbanken exchange rate fetched at create time. Supports ROT/RUT deduction lines (items[].deduction_type = "rot"|"rut" with invoice-level deduction_personnummer + deduction_housing_designation, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt), article linkage (items[].article_id + optional revenue_account override from the artikelregister), and project/cost-centre tagging (default_dimensions / items[].dimensions). Idempotent (mandatory Idempotency-Key). Dry-runnable: the preview returns the validated would-be invoice + items with computed totals; no journal entry is involved at draft stage (posting happens on :send). Set is_self_billed=true (with external_invoice_number + received_date) to instead register a received self-billing invoice (mottagen självfaktura, ML 17 kap 15§): a sale booked immediately with the counterparty\'s number, not a draft.',
  useWhen:
    'You need to issue a new invoice, proforma, or delivery note. Use dry-run first to confirm VAT calculations and currency conversion before committing.',
  doNotUseFor:
    'Updating an existing invoice (PATCH instead, drafts only). Issuing a credit note (use POST /:id:credit in PR-B-2b). Posting a previously-created draft to the journal (use POST /:id:send in PR-B-2b).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'For mixed-rate invoices, set vat_rate per item explicitly. Items where vat_rate is omitted use the customer\'s default rate from getVatRules().',
    'Non-SEK currencies require an active Riksbanken exchange-rate fetch. Failure is non-fatal: the invoice is created with null SEK fields and the agent can recompute later.',
    'invoice_number is null on creation. The number is allocated atomically when the invoice transitions out of draft. Counting on a specific number at create time is a bug.',
    'document_type=\'delivery_note\' produces no VAT and a different number sequence (D-series). Most use cases want the default document_type=\'invoice\'.',
    'is_self_billed=true registers a self-billing invoice your CUSTOMER issued on your behalf (a sale for you). It is booked immediately (not a draft, no F-number), so external_invoice_number and received_date are required and it is NOT dry-run-free of side effects on the live call. Do NOT set it for a normal invoice you issue yourself.',
    'Project/cost-center tagging: pass default_dimensions ({"6":"P001"} = project, {"1":"KS01"} = kostnadsställe) for the whole invoice and/or items[].dimensions per line (per-line wins per key). Tags are stored on the draft and applied to the journal entry lines when the invoice is sent. When the company has the dimension registry enabled, unknown or archived codes are rejected at :send with 400 DIMENSION_VALIDATION_FAILED — list valid codes via GET /dimensions.',
    'ROT/RUT: set items[].deduction_type ("rot"|"rut") on labor lines plus labor_hours and work_type (Skatteverket arbetstypskod). The invoice must carry deduction_personnummer AND housing info: deduction_housing_designation (fastighetsbeteckning) for småhus, or deduction_apartment_number + deduction_brf_org_number for bostadsrätt. deduction_amount is computed server-side and cannot be set by the caller; the response exposes deduction_total and remaining_amount = total - deduction_total (Skatteverket pays the rest via 1513). Validation failures return 400 INVOICE_CREATE_ROT_RUT_VALIDATION.',
    'Articles: pass items[].article_id (from the artikelregister, GET /articles) to link a line to a catalog article; price/description are still taken from the request body (the API never auto-fills from the article: send the values you want on the invoice). items[].revenue_account optionally overrides the BAS class-3 account and is validated against the chart of accounts.',
  ],
  example: {
    request: {
      customer_id: 'a8f1…',
      invoice_date: '2026-05-12',
      due_date: '2026-06-11',
      currency: 'SEK',
      items: [
        { description: 'Konsultation', quantity: 8, unit: 'tim', unit_price: 1250 },
      ],
    },
    response: {
      data: {
        id: '0e9c…',
        invoice_number: null,
        customer_id: 'a8f1…',
        invoice_date: '2026-05-12',
        due_date: '2026-06-11',
        status: 'draft',
        currency: 'SEK',
        subtotal: 10000,
        vat_amount: 2500,
        total: 12500,
        remaining_amount: 12500,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'invoices:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateInvoiceSchema },
  response: { success: dataEnvelope(InvoiceCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'invoices.create',
  async (request, ctx) => {
    // Defensive: companyId comes from the URL and was already validated for
    // membership by the wrapper, but UUID-validate it before using as a DB
    // predicate: mirrors the pattern in the detail-route :id check.
    if (!z.string().uuid().safeParse(ctx.companyId).success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'companyId', message: 'companyId must be a UUID.' },
      })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = CreateInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const input = parsed.data

    // Self-billing (mottagen självfaktura, ML 17 kap 15§): the customer issued
    // the invoice on our behalf, so for our books it is a SALE booked
    // immediately (never a draft). Optional flag; delegated to the shared
    // self-billed-sale service so this and the internal dashboard route agree.
    if (input.is_self_billed) {
      if (!input.external_invoice_number || !input.received_date) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            issues: [
              ...(!input.external_invoice_number
                ? [{ field: 'external_invoice_number', message: 'external_invoice_number is required when is_self_billed is true.' }]
                : []),
              ...(!input.received_date
                ? [{ field: 'received_date', message: 'received_date is required when is_self_billed is true.' }]
                : []),
            ],
          },
        })
      }

      const selfBilledInput: SelfBilledSaleInput = {
        customer_id: input.customer_id,
        external_invoice_number: input.external_invoice_number,
        self_billing_agreement_ref: input.self_billing_agreement_ref ?? null,
        invoice_date: input.invoice_date,
        received_date: input.received_date,
        due_date: input.due_date,
        currency: input.currency,
        notes: input.notes ?? null,
        items: input.items.map((it) => ({
          description: it.description,
          quantity: it.quantity,
          unit: it.unit ?? 'st',
          unit_price: it.unit_price,
          vat_rate: it.vat_rate,
        })),
      }

      if (ctx.dryRun) {
        const resolved = await resolveSelfBilledSaleDraft(ctx.supabase, ctx.companyId!, selfBilledInput)
        if (!resolved.ok) return selfBilledFailureResponse(resolved.failure, ctx)
        const { draft } = resolved
        return dryRunPreview(
          {
            invoice_number: null,
            customer_id: selfBilledInput.customer_id,
            customer_name: draft.customer.name,
            is_self_billed: true,
            external_invoice_number: selfBilledInput.external_invoice_number,
            self_billing_agreement_ref: selfBilledInput.self_billing_agreement_ref,
            invoice_date: selfBilledInput.invoice_date,
            received_date: selfBilledInput.received_date,
            due_date: selfBilledInput.due_date,
            status: 'sent' as const,
            currency: draft.currency,
            exchange_rate: draft.exchangeRate,
            subtotal: draft.subtotal,
            subtotal_sek: draft.subtotalSek,
            vat_amount: draft.vatAmount,
            vat_amount_sek: draft.vatAmountSek,
            total: draft.total,
            total_sek: draft.totalSek,
            remaining_amount: draft.total,
            vat_treatment: draft.vatTreatment,
            vat_rate: draft.vatRate,
            moms_ruta: draft.momsRuta,
            document_type: 'invoice' as const,
            items: draft.items,
            would_book_journal_entry: true,
          },
          { requestId: ctx.requestId, log: ctx.log },
        )
      }

      try {
        const result = await createSelfBilledSaleInvoice(ctx.supabase, ctx.companyId!, ctx.userId, selfBilledInput)
        if (!result.ok) return selfBilledFailureResponse(result.failure, ctx)
        return created(result.invoice as unknown as Record<string, unknown>, { requestId: ctx.requestId })
      } catch (err) {
        return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
      }
    }

    const documentType: InvoiceDocumentType = input.document_type || 'invoice'

    // Customer fetch (scoped to company). The builder only reads
    // customer_type + vat_number_validated (VAT rules / allowed rates);
    // select exactly those instead of '*' to keep PII out of this path.
    const { data: customer, error: customerErr } = await ctx.supabase
      .from('customers')
      .select('id, customer_type, vat_number_validated')
      .eq('company_id', ctx.companyId!)
      .eq('id', input.customer_id)
      .maybeSingle()

    if (customerErr) {
      return v1ErrorResponse(customerErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!customer) {
      return v1ErrorResponseFromCode('INVOICE_CUSTOMER_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    // Shared write-builder: identical validation + computation to the
    // dashboard create/edit routes (VAT rule gating, accrual guards,
    // revenue-account override checks, server-side ROT/RUT compute +
    // personnummer encryption, currency conversion, item-row mapping).
    // A v1 caller therefore gets the same field coverage as the UI:
    // deduction lines, article linkage, and per-line dimensions included.
    const build = await buildInvoiceWriteData({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      // Narrow projection above; the builder only touches these two fields.
      customer: customer as unknown as Customer,
      documentType,
      input,
    })
    if (!build.ok) {
      if ('dbError' in build) {
        return v1ErrorResponse(build.dbError, ctx.log, { requestId: ctx.requestId })
      }
      // The builder emits camelCase detail keys (internal-route convention);
      // the v1 wire shape for this code predates the builder and is
      // documented snake_case: keep it stable for existing consumers.
      const details =
        build.code === 'INVOICE_CREATE_VAT_RULE_VIOLATION' && build.details
          ? {
              attempted_rate: build.details.attemptedRate,
              allowed_rates: build.details.allowedRates,
              customer_type: build.details.customerType,
            }
          : build.details
      return v1ErrorResponseFromCode(build.code, ctx.log, {
        requestId: ctx.requestId,
        details,
      })
    }
    const { invoiceFields, items: itemRows } = build

    // Dry-run: validation-only preview. Drafts have no journal-entry side
    // effects yet, so no pending_operations staging needed; the
    // dryRunStaged() variant lands in PR-B-2b for :send.
    if (ctx.dryRun) {
      // Never echo the encrypted personnummer blob in a preview; last4 is
      // the display-safe representation the response columns expose too.
      const { deduction_personnummer_encrypted: _omit, ...previewFields } = invoiceFields
      return dryRunPreview(
        {
          // Would-be invoice row.
          invoice_number: null,
          status: 'draft' as const,
          ...previewFields,
          items: itemRows,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Delivery notes get their number from a dedicated sequence on insert.
    // Invoices and proformas allocate F-series numbers via
    // ensureInvoiceNumber AFTER insert (atomic, but can fail: soft-cancel
    // on failure to preserve sequence integrity per ML 17 kap 24§).
    let invoiceNumber: string | null = null
    if (documentType === 'delivery_note') {
      const { data: dnNumber } = await ctx.supabase.rpc('generate_delivery_note_number', {
        p_company_id: ctx.companyId!,
      })
      invoiceNumber = dnNumber as string | null
    }

    const { data: invoice, error: invoiceErr } = await ctx.supabase
      .from('invoices')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        invoice_number: invoiceNumber,
        ...invoiceFields,
      })
      .select(INVOICE_RESPONSE_COLUMNS)
      .single()

    if (invoiceErr) {
      // pg_message can interpolate field values from constraint detail:       // log internally, never echo to the client.
      ctx.log.error('invoice insert failed', invoiceErr, {
        invoiceId: undefined,
        companyId: ctx.companyId,
        pgCode: invoiceErr.code,
      })
      return v1ErrorResponseFromCode('INVOICE_CREATE_INSERT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { pg_code: invoiceErr.code },
      })
    }

    const invoiceId = (invoice as { id: string }).id

    // Insert items. If this fails, roll back the invoice row to avoid
    // orphaned headers. Scope the rollback by company_id (defense in depth
    // against UUID collision / logic error in compensating logic) and
    // check the delete result so a double-failure is visible.
    const itemsToInsert = itemRows.map((r) => ({ ...r, invoice_id: invoiceId }))
    const { error: itemsErr } = await ctx.supabase.from('invoice_items').insert(itemsToInsert)
    if (itemsErr) {
      const { error: rollbackErr } = await ctx.supabase
        .from('invoices')
        .delete()
        .eq('id', invoiceId)
        .eq('company_id', ctx.companyId!)
      if (rollbackErr) {
        ctx.log.error(
          'invoice items insert failed AND rollback delete failed: orphaned invoice header',
          rollbackErr,
          { invoiceId, companyId: ctx.companyId, originalPgCode: itemsErr.code },
        )
      } else {
        ctx.log.error('invoice items insert failed; rolled back invoice', itemsErr, {
          invoiceId,
          companyId: ctx.companyId,
        })
      }
      return v1ErrorResponseFromCode('INVOICE_CREATE_ITEMS_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { pg_code: itemsErr.code },
      })
    }

    // Note: F-series invoice_number is NOT allocated at draft-create.
    // Allocation happens atomically on the first :send action (Phase 2
    // PR-B-2b). Draft invoices keep invoice_number=null until then.
    // Rationale: ML 17 kap 24§ p.2 requires the löpnummer series to be
    // unbroken and to cover only issued invoices: consuming numbers for
    // drafts that are later abandoned creates legal gaps.
    // Delivery notes use a separate D-series sequence (already allocated
    // on insert above) and are NOT subject to the F-series constraint.

    // Refetch with embedded items for the response.
    const { data: complete, error: refetchErr } = await ctx.supabase
      .from('invoices')
      .select(`${INVOICE_RESPONSE_COLUMNS}, items:invoice_items(${INVOICE_ITEMS_RESPONSE_COLUMNS})`)
      .eq('id', invoiceId)
      .eq('company_id', ctx.companyId!)
      .single()

    if (refetchErr) {
      // The invoice WAS created; the items WERE inserted. Refetch failed
      // for a transient DB reason. Log it so the partial-response is
      // visible; fall back to the header without items rather than
      // mis-leading the agent with a 5xx.
      ctx.log.warn('invoice refetch after create failed; returning header without items', {
        invoiceId,
        companyId: ctx.companyId,
        pgCode: (refetchErr as { code?: string }).code,
      })
    }

    // Emit invoice.created only for real invoices: proformas and delivery
    // notes are informational and have no downstream consumer obligation.
    if (complete && documentType === 'invoice') {
      try {
        await eventBus.emit({
          type: 'invoice.created',
          payload: {
            invoice: complete as unknown as Invoice,
            companyId: ctx.companyId!,
            userId: ctx.userId,
          },
        })
      } catch (err) {
        ctx.log.warn('invoice.created emit failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
      }
    }

    return created(complete ?? invoice, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
