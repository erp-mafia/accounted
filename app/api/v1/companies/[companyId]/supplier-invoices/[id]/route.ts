/**
 * /api/v1/companies/{companyId}/supplier-invoices/{id} — detail + update.
 *
 * GET   — full record. ?expand=supplier,items,payments embeds related rows.
 * PATCH — partial update. Only allowed on `registered` status (mirrors the
 *         dashboard: an approved/paid SI is effectively immutable from the
 *         caller's perspective; for those, use the action verbs or :credit).
 *         Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * No DELETE — supplier-invoice withdrawal is via :credit (mirrors v1 invoices).
 * The credit verb keeps both originals AND credit notes in the audit trail per
 * BFL 5 kap 5 § (corrections via reversing entries).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand } from '@/lib/api/v1/expand'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'

// V1-only strict variant. The shared `UpdateSupplierInvoiceSchema` is also
// consumed by the dashboard, where unknown keys are silently stripped — fine
// for a UI that controls its own payload. The public API treats unknown keys
// as a contract violation: if a future schema iteration ever adds a
// protected field (status, company_id, user_id), `.strict()` makes the
// mass-assignment vector structurally impossible regardless of whether the
// downstream allowlist iteration catches it.
const V1PatchSupplierInvoiceSchema = UpdateSupplierInvoiceSchema.strict()

const SI_DETAIL_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, received_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, reverse_charge, payment_reference, paid_at, paid_amount, remaining_amount, is_credit_note, credited_invoice_id, registration_journal_entry_id, payment_journal_entry_id, transaction_id, document_id, notes, reversed_at, created_at, updated_at'

const SI_ITEM_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate'

const SI_PAYMENT_COLUMNS =
  'id, payment_date, amount, currency, exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id, notes, created_at'

const SUPPLIER_DETAIL_COLUMNS_EXPAND =
  'id, name, supplier_type, email, org_number, vat_number, default_payment_terms, default_currency, bankgiro, plusgiro, iban, bic, default_expense_account, archived_at'

const SupplierInvoiceDetail = z.object({
  id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  arrival_number: z.number().int(),
  supplier_invoice_number: z.string(),
  invoice_date: z.string(),
  due_date: z.string(),
  received_date: z.string(),
  delivery_date: z.string().nullable(),
  status: z.string(),
  currency: z.string(),
  exchange_rate: z.number().nullable(),
  subtotal: z.number(),
  vat_amount: z.number(),
  total: z.number(),
  vat_treatment: z.string(),
  reverse_charge: z.boolean(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  is_credit_note: z.boolean(),
  credited_invoice_id: z.string().uuid().nullable(),
  registration_journal_entry_id: z.string().uuid().nullable(),
  payment_journal_entry_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
})

const ALLOWED_EXPAND = ['supplier', 'items', 'payments'] as const

registerEndpoint({
  operation: 'supplier-invoices.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id',
  summary: 'Retrieve a single supplier invoice by id.',
  description:
    'Returns the full supplier-invoice record. Pass ?expand=supplier,items,payments to embed the related rows in the same response.',
  useWhen:
    'You need the full record before approving, paying, or crediting it — or for audit trail / reconciliation.',
  doNotUseFor:
    'Listing supplier invoices (use the list endpoint). Customer-invoice lookups (different resource).',
  pitfalls: [
    'Credit notes return is_credit_note=true and a credited_invoice_id pointing at the original.',
    'registration_journal_entry_id and payment_journal_entry_id let you trace the SI to its bokföring rows; they are null when no JE has been posted (e.g. on a kontantmetoden SI before payment).',
  ],
  example: {
    response: {
      data: {
        id: '0e9c…',
        supplier_id: 'a8f1…',
        arrival_number: 42,
        supplier_invoice_number: '2026-1234',
        status: 'registered',
        currency: 'SEK',
        subtotal: 1000,
        vat_amount: 250,
        total: 1250,
        remaining_amount: 1250,
        is_credit_note: false,
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: SupplierInvoiceDetail },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.get',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    const url = new URL(request.url)
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

    const parts: string[] = [SI_DETAIL_COLUMNS]
    if (expand.has('supplier')) parts.push(`supplier:suppliers(${SUPPLIER_DETAIL_COLUMNS_EXPAND})`)
    if (expand.has('items')) parts.push(`items:supplier_invoice_items(${SI_ITEM_COLUMNS})`)
    if (expand.has('payments')) parts.push(`payments:supplier_invoice_payments(${SI_PAYMENT_COLUMNS})`)
    const selectClause = parts.join(', ')

    const { data, error } = await ctx.supabase
      .from('supplier_invoices')
      .select(selectClause)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('supplier-invoices.get: not found', { invoiceId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    return ok(data, { requestId: ctx.requestId })
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH — partial update (registered-only)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'supplier-invoices.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id',
  summary: 'Update a registered supplier invoice.',
  description:
    'Patches a supplier invoice with the supplied fields. Only allowed on `registered` status — once approved, paid, or credited, the record is effectively immutable from the API\'s perspective. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
  useWhen:
    'You need to fix a typo in supplier_invoice_number, adjust dates, or attach a payment reference / notes to a registered SI before approval. Use dry-run to confirm the merged state first.',
  doNotUseFor:
    'Editing line items (immutable — credit the SI and register a new one). Changing status (use action verbs). Approved/paid/credited SIs (returns 400 SI_NOT_DRAFT).',
  pitfalls: [
    'Returns 400 SI_NOT_DRAFT when current status !== "registered".',
    'invoice_date / due_date changes do not re-post the registration JE; if the entry date needs to change, credit the SI and re-register.',
  ],
  example: {
    request: { payment_reference: 'OCR-1234567890' },
    response: {
      data: { id: '0e9c…', payment_reference: 'OCR-1234567890' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: V1PatchSupplierInvoiceSchema },
  response: { success: SupplierInvoiceDetail },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'supplier-invoices.update',
  async (request, ctx, params) => {
    const { id } = await params.params
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Supplier-invoice id must be a UUID.' },
      })
    }
    const invoiceId = idParse.data

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = V1PatchSupplierInvoiceSchema.safeParse(rawBody)
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
    const body = parsed.data

    const updateData: Record<string, unknown> = {}
    for (const key of [
      'supplier_invoice_number',
      'invoice_date',
      'due_date',
      'delivery_date',
      'payment_reference',
      'notes',
    ] as const) {
      if (body[key] !== undefined) updateData[key] = body[key]
    }
    if (Object.keys(updateData).length === 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'At least one field must be supplied for update.' },
      })
    }

    // Status guard before doing anything else.
    const { data: existing, error: fetchErr } = await ctx.supabase
      .from('supplier_invoices')
      .select(SI_DETAIL_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    if (fetchErr) {
      return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!existing) {
      return v1ErrorResponseFromCode('SI_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }
    if ((existing as { status: string }).status !== 'registered') {
      return v1ErrorResponseFromCode('SI_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { current_status: (existing as { status: string }).status },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview({ ...existing, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    const { data, error } = await ctx.supabase
      .from('supplier_invoices')
      .update(updateData)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      // Race guard: another request may have approved / paid between the
      // pre-flight status check and this update.
      .eq('status', 'registered')
      .select(SI_DETAIL_COLUMNS)
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      return v1ErrorResponseFromCode('SI_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
