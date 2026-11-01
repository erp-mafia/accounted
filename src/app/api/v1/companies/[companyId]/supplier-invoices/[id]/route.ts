/**
 * /api/v1/companies/{companyId}/supplier-invoices/{id}: detail + update.
 *
 * GET   : full record. ?expand=supplier,items,payments embeds related rows.
 * PATCH : partial update. Only allowed on `registered` status (mirrors the
 *         dashboard: an approved/paid SI is effectively immutable from the
 *         caller's perspective; for those, use the action verbs or :credit).
 *         Idempotent (mandatory Idempotency-Key). Dry-runnable.
 *
 * DELETE: only an unbooked, unpaid invoice (operation supplier-invoices.delete,
 *         rules in lib/supplier-invoices/manage.ts, shared with the dashboard).
 *         A booked invoice is withdrawn via :credit, which keeps both the
 *         original AND the credit note in the audit trail per BFL 5 kap 5 §
 *         (corrections via reversing entries).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand, expandQueryShape } from '@/lib/api/v1/expand'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { scopeSatisfied } from '@/lib/auth/scope-catalog'
import { SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS } from '@/types'
import { v1OperationHandler } from '@/lib/operations/v1'
import { supplierInvoicesDelete } from '@/lib/operations/supplier-invoice-actions'
import {
  findChangedVerifikatFields,
  findLockedVerifikatFields,
} from '@/lib/supplier-invoices/lifecycle'
import { selfBilledLockedFields } from '@/lib/supplier-invoices/self-billing/edit-guard'

// V1-only strict variant. The shared `UpdateSupplierInvoiceSchema` is also
// consumed by the dashboard, where unknown keys are silently stripped, fine
// for a UI that controls its own payload. The public API treats unknown keys
// as a contract violation: if a future schema iteration ever adds a
// protected field (status, company_id, user_id), `.strict()` makes the
// mass-assignment vector structurally impossible regardless of whether the
// downstream allowlist iteration catches it.
const V1PatchSupplierInvoiceSchema = UpdateSupplierInvoiceSchema.strict()

const SI_DETAIL_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, received_date, delivery_date, status, currency, exchange_rate, exchange_rate_date, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, reverse_charge, reverse_charge_kind, payment_reference, paid_at, paid_amount, remaining_amount, is_credit_note, credited_invoice_id, is_self_billed, self_billing_number, self_billing_agreement_ref, registration_journal_entry_id, payment_journal_entry_id, transaction_id, document_id, notes, default_dimensions, reversed_at, approved_at, bank_entered_at, created_at, updated_at'

const SI_ITEM_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate, apply_slp, dimensions'

const SI_PAYMENT_COLUMNS =
  'id, payment_date, amount, currency, exchange_rate, exchange_rate_difference, journal_entry_id, transaction_id, notes, created_at'

const SUPPLIER_DETAIL_COLUMNS_EXPAND =
  'id, name, supplier_type, email, org_number, vat_number, default_payment_terms, default_currency, bankgiro, plusgiro, iban, bic, default_expense_account, archived_at'

const SupplierInvoiceDetail = z.object({
  id: z.string().uuid(),
  supplier_id: z.string().uuid(),
  arrival_number: z.number().int(),
  // NULL when the supplier's invoice carries no number (never a stand-in).
  supplier_invoice_number: z.string().nullable(),
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
  // Under reverse charge from an EU supplier: eu_goods (ruta 20) or
  // eu_services (ruta 21); null books services.
  reverse_charge_kind: z.enum(SUPPLIER_INVOICE_REVERSE_CHARGE_KINDS).nullable(),
  paid_amount: z.number(),
  remaining_amount: z.number(),
  is_credit_note: z.boolean(),
  credited_invoice_id: z.string().uuid().nullable(),
  // A self-billing invoice we issued in the supplier's name (crm#1367): its
  // supplier_invoice_number is ours, from the series (self_billing_number).
  is_self_billed: z.boolean(),
  self_billing_number: z.number().int().nullable(),
  self_billing_agreement_ref: z.string().nullable(),
  registration_journal_entry_id: z.string().uuid().nullable(),
  payment_journal_entry_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  // Attest time: an attested invoice past its due date reads 'overdue', like
  // one nobody attested, so the status alone cannot tell (crm#1229).
  approved_at: z.string().nullable(),
  // "Inlagd i banken": paid by hand at the bank, money not landed yet.
  // Cleared when a payment lands; books nothing.
  bank_entered_at: z.string().nullable(),
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
    'You need the full record before approving, paying, or crediting it, or for audit trail / reconciliation.',
  doNotUseFor:
    'Listing supplier invoices (use the list endpoint). Customer-invoice lookups (different resource).',
  pitfalls: [
    'Credit notes return is_credit_note=true and a credited_invoice_id pointing at the original.',
    'A self-billing invoice (is_self_billed=true) is one the company issued in the supplier\'s name: supplier_invoice_number is the company\'s own series number and the document is GET .../self-billing-pdf.',
    'registration_journal_entry_id and payment_journal_entry_id let you trace the SI to its bokföring rows; they are null when no JE has been posted (e.g. on a kontantmetoden SI before payment).',
    'status does not say whether an invoice is attested (an attested invoice past its due date is overdue): read approved_at, which kontantmetoden companies leave null (no attest step there). bank_entered_at is set while a payment entered at the bank by hand has not landed; it clears itself when a payment is recorded on the invoice.',
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
  request: { query: z.object(expandQueryShape(ALLOWED_EXPAND)) },
  response: { success: dataEnvelope(SupplierInvoiceDetail) },
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
// PATCH: partial update (registered-only)
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'supplier-invoices.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/supplier-invoices/:id',
  summary: 'Update a registered supplier invoice.',
  description:
    'Patches a supplier invoice with the supplied fields. Only allowed on `registered` status: once approved, paid, or credited, the record is effectively immutable from the API\'s perspective. Idempotent (mandatory Idempotency-Key). Dry-runnable.',
  useWhen:
    'You need to adjust due_date, or attach a payment reference / notes to a registered SI before approval. Use dry-run to confirm the merged state first.',
  doNotUseFor:
    'Editing line items (immutable: credit the SI and register a new one). Changing status (use action verbs). Approved/paid/credited SIs (returns 400 SI_NOT_DRAFT). invoice_date / supplier_invoice_number on an SI that already has a registration verifikat (returns 400 SI_EDIT_VERIFIKAT_LOCKED).',
  pitfalls: [
    'Returns 400 SI_NOT_DRAFT when current status !== "registered".',
    'invoice_date and supplier_invoice_number are on the posted registration verifikat (entry_date and description). Once registration_journal_entry_id is set, patching them returns 400 SI_EDIT_VERIFIKAT_LOCKED: correct the entry via a rättelse (gnubok_correct_entry) or credit the SI and re-register. Resending the unchanged value is accepted.',
    'Patching a field never re-posts the registration JE.',
  ],
  example: {
    request: { payment_reference: 'OCR-1234567890' },
    response: {
      data: { id: '0e9c…', payment_reference: 'OCR-1234567890' },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  // suppliers:register (included in suppliers:write) edits only an invoice
  // that posted nothing and nobody approved (checked in the handler).
  scope: 'suppliers:register',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: V1PatchSupplierInvoiceSchema },
  response: { success: dataEnvelope(SupplierInvoiceDetail) },
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

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    const parsed = V1PatchSupplierInvoiceSchema.safeParse(rawBody)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)
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

    // A register-only key (suppliers:register, crm#1548) edits what it could
    // have registered: no verifikat, not approved or bank-entered, not a
    // självfaktura. Anything further on needs suppliers:write.
    if (!scopeSatisfied(ctx.scopes, 'suppliers:write')) {
      const held = existing as {
        registration_journal_entry_id: string | null
        approved_at: string | null
        bank_entered_at: string | null
        is_self_billed: boolean | null
      }
      if (held.registration_journal_entry_id || held.approved_at || held.bank_entered_at || held.is_self_billed) {
        return v1ErrorResponseFromCode('INSUFFICIENT_SCOPE', ctx.log, {
          requestId: ctx.requestId,
          details: {
            required_scope: 'suppliers:write',
            granted_scopes: ctx.scopes,
            message:
              'This supplier invoice has a verifikat, is approved or bank-entered, or is a self-billing invoice: editing it needs suppliers:write.',
          },
        })
      }
    }

    // An issued self-billing invoice keeps its number and date (crm#1367).
    const selfBilledFields = selfBilledLockedFields(
      body,
      existing as { is_self_billed: boolean | null; supplier_invoice_number: string | null; invoice_date: string | null },
    )
    if (selfBilledFields.length > 0) {
      return v1ErrorResponseFromCode('SI_SELF_BILL_IMMUTABLE', ctx.log, {
        requestId: ctx.requestId,
        details: { fields: selfBilledFields },
      })
    }

    // For a company without defer_invoice_booking the registration verifikat is
    // posted at create time, so a 'registered' SI is normally already booked.
    // invoice_date is that entry's entry_date and supplier_invoice_number is in
    // its description: patching either here would desync the verifikat outside
    // both sanctioned rättelse paths (#1230). Dry-run is gated too, so the
    // preview never promises a write the real call refuses.
    const lockedFields = findLockedVerifikatFields(
      body,
      existing as {
        registration_journal_entry_id: string | null
        invoice_date: string | null
        supplier_invoice_number: string | null
      },
    )
    if (lockedFields.length > 0) {
      return v1ErrorResponseFromCode('SI_EDIT_VERIFIKAT_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          fields: lockedFields,
          journal_entry_id: (existing as { registration_journal_entry_id: string | null })
            .registration_journal_entry_id,
        },
      })
    }

    if (ctx.dryRun) {
      return dryRunPreview({ ...existing, ...updateData }, { requestId: ctx.requestId, log: ctx.log })
    }

    // The lock check read a row that was still unbooked. If this patch moves a
    // verifikat-critical field, the write stays conditional on that: a
    // registration entry posted in between must lose the race rather than end
    // up disagreeing with the invoice it was built from.
    const movesVerifikatFields =
      findChangedVerifikatFields(
        body,
        existing as { invoice_date: string | null; supplier_invoice_number: string | null },
      ).length > 0

    let write = ctx.supabase
      .from('supplier_invoices')
      .update(updateData)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      // Race guard: another request may have approved / paid between the
      // pre-flight status check and this update.
      .eq('status', 'registered')
    if (movesVerifikatFields) {
      write = write.is('registration_journal_entry_id', null)
    }

    const { data, error } = await write.select(SI_DETAIL_COLUMNS).maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      // Either the status moved or a registration entry landed. Re-read so the
      // caller gets the reason that actually applies instead of a guess.
      const { data: current } = await ctx.supabase
        .from('supplier_invoices')
        .select('status, registration_journal_entry_id, invoice_date, supplier_invoice_number')
        .eq('company_id', ctx.companyId!)
        .eq('id', invoiceId)
        .maybeSingle()

      const nowLocked = current
        ? findLockedVerifikatFields(
            body,
            current as {
              registration_journal_entry_id: string | null
              invoice_date: string | null
              supplier_invoice_number: string | null
            },
          )
        : []
      if (nowLocked.length > 0) {
        return v1ErrorResponseFromCode('SI_EDIT_VERIFIKAT_LOCKED', ctx.log, {
          requestId: ctx.requestId,
          details: {
            fields: nowLocked,
            journal_entry_id: (current as { registration_journal_entry_id: string | null })
              .registration_journal_entry_id,
            reason: 'race',
          },
        })
      }
      return v1ErrorResponseFromCode('SI_NOT_DRAFT', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: 'race' },
      })
    }

    return ok(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)

export const DELETE = v1OperationHandler(supplierInvoicesDelete)
