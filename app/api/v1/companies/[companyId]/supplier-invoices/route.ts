/**
 * /api/v1/companies/{companyId}/supplier-invoices — list + register endpoints.
 *
 * GET   — list with filters (status, supplier_id, currency, invoice_date range).
 *         Cursor pagination on (invoice_date DESC, id DESC).
 * POST  — register a new supplier invoice. Idempotent (mandatory Idempotency-Key).
 *         Dry-runnable.
 *
 * Lifecycle: a fresh SI is created in `registered` status. Under
 * faktureringsmetoden the registration JE (Debit expense + Debit 2641 / Credit
 * 2440) is posted in the same call — failure aborts and the SI row is rolled
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
import type { SupabaseClient } from '@supabase/supabase-js'
import { created, paginated } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { CreateSupplierInvoiceSchema } from '@/lib/api/schemas'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import { isBookkeepingError } from '@/lib/bookkeeping/errors'
import { eventBus } from '@/lib/events'
import type { SupplierInvoice, SupplierInvoiceItem } from '@/types'

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

registerEndpoint({
  operation: 'supplier-invoices.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/supplier-invoices',
  summary: 'List supplier invoices for a company.',
  description:
    'Returns supplier invoices in most-recent-first order. Filters: status, supplier_id, currency, date_from / date_to (filter by invoice_date).',
  useWhen:
    'You need to enumerate registered supplier invoices for an AP dashboard, a payment run, or a leverantörsreskontra reconciliation.',
  doNotUseFor:
    'Fetching a single supplier invoice — use GET /supplier-invoices/{id}. Listing customer invoices (different resource).',
  pitfalls: [
    'Credit notes (is_credit_note=true) appear in the same list as the originals; filter by status=credited or check the flag to separate.',
    'remaining_amount is the unpaid portion; a partially_paid SI has remaining_amount > 0.',
    'arrival_number is internal book-keeping, not the seller\'s invoice number — use supplier_invoice_number for matching to received documents.',
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
  response: { success: SupplierInvoicesListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'supplier-invoices.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      status: SupplierInvoiceStatus.optional(),
      supplier_id: z.string().uuid().optional(),
      currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO-4217 code').optional(),
      date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_from must be ISO YYYY-MM-DD').optional(),
      date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date_to must be ISO YYYY-MM-DD').optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      status: url.searchParams.get('status') ?? undefined,
      supplier_id: url.searchParams.get('supplier_id') ?? undefined,
      currency: url.searchParams.get('currency') ?? undefined,
      date_from: url.searchParams.get('date_from') ?? undefined,
      date_to: url.searchParams.get('date_to') ?? undefined,
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

    let query = ctx.supabase
      .from('supplier_invoices')
      .select(`${SI_SUMMARY_COLUMNS}, supplier:suppliers(${SUPPLIER_NAME_ONLY_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .order('invoice_date', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (filters.status) query = query.eq('status', filters.status)
    if (filters.supplier_id) query = query.eq('supplier_id', filters.supplier_id)
    if (filters.currency) query = query.eq('currency', filters.currency)
    if (filters.date_from) query = query.gte('invoice_date', filters.date_from)
    if (filters.date_to) query = query.lte('invoice_date', filters.date_to)

    if (decoded) {
      // Keyset on (invoice_date DESC, id DESC).
      query = query.or(
        `invoice_date.lt.${decoded.ts},and(invoice_date.eq.${decoded.ts},id.lt.${decoded.id})`,
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
      ? encodeDefaultCursor({ id: last.id, created_at: last.invoice_date })
      : null

    return paginated(supplier_invoices, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST — register supplier invoice
// ──────────────────────────────────────────────────────────────────

const SI_RESPONSE_COLUMNS =
  'id, supplier_id, arrival_number, supplier_invoice_number, invoice_date, due_date, received_date, delivery_date, status, currency, exchange_rate, subtotal, subtotal_sek, vat_amount, vat_amount_sek, total, total_sek, vat_treatment, reverse_charge, payment_reference, paid_amount, remaining_amount, is_credit_note, credited_invoice_id, registration_journal_entry_id, payment_journal_entry_id, notes, created_at, updated_at'

const SI_ITEMS_RESPONSE_COLUMNS =
  'id, sort_order, description, quantity, unit, unit_price, line_total, account_number, vat_code, vat_rate, vat_amount, reverse_charge_rate'

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
    'invoice_date must fall within an open fiscal period — a date covered by a locked period or the company-wide bookkeeping lock returns 400 PERIOD_LOCKED.',
    'Under faktureringsmetoden the registration JE is posted atomically with the SI row. JE failure aborts the whole call and no SI row is left behind (strict-mode).',
    'supplier_id must reference an existing, non-archived supplier in the same company — 404 SUPPLIER_NOT_FOUND otherwise.',
    'Duplicate (supplier_id, supplier_invoice_number) returns 409 SI_CREATE_DUPLICATE_INVOICE_NUMBER. Use the credit flow on the original instead of re-registering with a tweaked number.',
  ],
  example: {
    request: {
      supplier_id: 'a8f1…',
      supplier_invoice_number: '2026-1234',
      invoice_date: '2026-05-10',
      due_date: '2026-06-09',
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
  response: { success: SupplierInvoiceCreated },
})

interface ComputedItem {
  sort_order: number
  description: string
  quantity: number
  unit: string
  unit_price: number
  line_total: number
  account_number: string
  vat_code: string | null
  vat_rate: number
  vat_amount: number
  reverse_charge_rate: number | null
}

// Swedish VAT rates per ML 2 kap 1 § + Skatteverket's 2026 satser. Allow
// 0 (export / undantag / reverse charge), 6 (livsmedel / kultur), 12 (food
// service / hotel), 25 (default). A misstated rate flows straight into the
// registration JE → momsdeklaration Ruta 48 + INK2R, so reject anything
// else at the surface rather than silently book a wrong figure.
const ALLOWED_SV_VAT_RATES = new Set<number>([0, 0.06, 0.12, 0.25])

function computeItemsAndTotals(input: z.infer<typeof CreateSupplierInvoiceSchema>):
  | { ok: true; items: ComputedItem[]; subtotal: number; vatAmount: number; total: number }
  | { ok: false; field: string; message: string; attempted_rate: number; index: number } {
  const items: ComputedItem[] = []
  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]
    const vatRate = item.vat_rate ?? 0.25
    if (!ALLOWED_SV_VAT_RATES.has(vatRate)) {
      return {
        ok: false,
        field: `items[${index}].vat_rate`,
        message: 'vat_rate must be one of 0, 0.06, 0.12, or 0.25 (ML 2 kap 1 §).',
        attempted_rate: vatRate,
        index,
      }
    }
    const lineTotal = item.amount != null
      ? Math.round(item.amount * 100) / 100
      : Math.round((item.quantity ?? 1) * (item.unit_price ?? 0) * 100) / 100
    const vatAmount = Math.round(lineTotal * vatRate * 100) / 100
    items.push({
      sort_order: index,
      description: item.description,
      quantity: item.amount != null ? 1 : (item.quantity ?? 1),
      unit: item.amount != null ? 'st' : (item.unit || 'st'),
      unit_price: item.amount != null ? lineTotal : (item.unit_price ?? 0),
      line_total: lineTotal,
      account_number: item.account_number,
      vat_code: item.vat_code || null,
      vat_rate: vatRate,
      vat_amount: vatAmount,
      // Self-assessed RC rate (0.06/0.12/0.25) or null. For reverse charge the
      // line vat_rate is 0 (validated below); the engine self-assesses at this
      // rate, defaulting to 25% huvudregeln when null.
      reverse_charge_rate: item.reverse_charge_rate ?? null,
    })
  }
  const subtotal = items.reduce((sum, i) => sum + i.line_total, 0)
  const vatAmount = items.reduce((sum, i) => sum + i.vat_amount, 0)
  const total = Math.round((subtotal + vatAmount) * 100) / 100
  return {
    ok: true,
    items,
    subtotal: Math.round(subtotal * 100) / 100,
    vatAmount: Math.round(vatAmount * 100) / 100,
    total,
  }
}

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'supplier-invoices.create',
  async (request, ctx) => {
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

    const parsed = CreateSupplierInvoiceSchema.safeParse(rawBody)
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

    // Supplier lookup. Scoped to company; deny soft-archived.
    const { data: supplier, error: supplierErr } = await ctx.supabase
      .from('suppliers')
      .select('id, name, supplier_type, archived_at')
      .eq('company_id', ctx.companyId!)
      .eq('id', body.supplier_id)
      .maybeSingle()

    if (supplierErr) {
      return v1ErrorResponse(supplierErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!supplier || supplier.archived_at) {
      return v1ErrorResponseFromCode('SUPPLIER_NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
      })
    }

    // Application-layer period-lock check on invoice_date. The DB trigger
    // remains authoritative; this is for ergonomics so agents get a
    // structured PERIOD_LOCKED instead of a generic 500.
    const lockVerdict = await checkPeriodLock(ctx.supabase, ctx.companyId!, body.invoice_date)
    if (lockVerdict.locked) {
      return v1ErrorResponseFromCode('PERIOD_LOCKED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: lockVerdict.reason,
          fiscal_period_id: lockVerdict.fiscal_period_id,
        },
      })
    }

    const totalsResult = computeItemsAndTotals(body)
    if (!totalsResult.ok) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: [{ field: totalsResult.field, message: totalsResult.message }],
          attempted_rate: totalsResult.attempted_rate,
          allowed_rates: [0, 0.06, 0.12, 0.25],
        },
      })
    }
    const { items, subtotal, vatAmount, total } = totalsResult
    const exchangeRate = body.exchange_rate ?? null
    const subtotalSek = exchangeRate ? Math.round(subtotal * exchangeRate * 100) / 100 : null
    const vatAmountSek = exchangeRate ? Math.round(vatAmount * exchangeRate * 100) / 100 : null
    const totalSek = exchangeRate ? Math.round(total * exchangeRate * 100) / 100 : null

    // Derive a sensible default for vat_treatment + reverse_charge from the
    // supplier_type. EU/non-EU suppliers default to reverse-charge unless the
    // caller explicitly overrides; Swedish suppliers default to standard 25%.
    // The engine looks at `invoice.reverse_charge` (boolean) for the actual
    // booking choice — `vat_treatment` is recorded as metadata. Keeping the
    // two in sync prevents momsdeklaration Ruta 30 / 48 misclassification on
    // EU-supplier rows that omit both fields.
    const foreignSupplier =
      supplier.supplier_type === 'eu_business' || supplier.supplier_type === 'non_eu_business'
    const reverseCharge = body.reverse_charge ?? foreignSupplier
    // Force `vat_treatment` to track the resolved `reverse_charge` flag.
    // Otherwise a caller could pass `vat_treatment: 'standard_25'` explicitly
    // and have it co-exist with `reverse_charge=true` (driven by
    // supplier_type), producing inconsistent metadata: the engine books via
    // `reverse_charge` (Ruta 30 / 48) but a downstream momsdeklaration
    // export reading `vat_treatment` would mis-classify. Normalisation here
    // keeps the two fields in lock-step; an explicit override only sticks
    // when it agrees with the boolean flag.
    const vatTreatment = reverseCharge
      ? 'reverse_charge'
      : (body.vat_treatment ?? 'standard_25')

    // Cross-field constraint for reverse-charge invoices: the Swedish supplier
    // does not charge VAT, the buyer self-assesses (ML 1 kap 2§ p.4b /
    // 16 kap 6 § / 16 kap 13 §). All item vat_rates MUST be 0 — otherwise the
    // engine will mis-book ingående moms in Ruta 30 / 48 (BAS 2614 / 2645 /
    // 2641). Reject up front rather than booking a phantom VAT line.
    if (reverseCharge) {
      const offending = items.findIndex((it) => it.vat_rate !== 0)
      if (offending !== -1) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: `items[${offending}].vat_rate`,
            message:
              'reverse_charge invoices must have vat_rate=0 on every line item — the buyer self-assesses VAT.',
            attempted_rate: items[offending].vat_rate,
            reverse_charge: true,
          },
        })
      }
    }

    // Dry-run preview — no arrival_number is allocated (would burn a sequence
    // number on a non-commit).
    if (ctx.dryRun) {
      return dryRunPreview(
        {
          supplier_id: body.supplier_id,
          supplier_invoice_number: body.supplier_invoice_number,
          invoice_date: body.invoice_date,
          due_date: body.due_date,
          delivery_date: body.delivery_date ?? null,
          status: 'registered',
          currency: body.currency ?? 'SEK',
          exchange_rate: exchangeRate,
          vat_treatment: vatTreatment,
          reverse_charge: reverseCharge,
          subtotal,
          subtotal_sek: subtotalSek,
          vat_amount: vatAmount,
          vat_amount_sek: vatAmountSek,
          total,
          total_sek: totalSek,
          remaining_amount: total,
          is_credit_note: false,
          notes: body.notes ?? null,
          items,
          // Indicate what the live commit would do; the actual JE row is not
          // staged in pending_operations because the SI write path is
          // orchestrated here, not via the staging substrate.
          would_create_registration_journal_entry: true,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Allocate arrival_number (atomic, per-company sequence).
    const { data: arrivalNum, error: arrivalErr } = await ctx.supabase
      .rpc('get_next_arrival_number', { p_company_id: ctx.companyId! })

    if (arrivalErr || arrivalNum == null) {
      ctx.log.error('arrival_number allocation failed', (arrivalErr as Error) ?? new Error('null arrival_number'))
      return v1ErrorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'arrival_number' },
      })
    }

    // Insert SI row.
    const { data: invoice, error: invoiceErr } = await ctx.supabase
      .from('supplier_invoices')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        supplier_id: body.supplier_id,
        arrival_number: arrivalNum,
        supplier_invoice_number: body.supplier_invoice_number,
        invoice_date: body.invoice_date,
        due_date: body.due_date,
        delivery_date: body.delivery_date ?? null,
        status: 'registered',
        currency: body.currency ?? 'SEK',
        exchange_rate: exchangeRate,
        vat_treatment: vatTreatment,
        reverse_charge: reverseCharge,
        payment_reference: body.payment_reference ?? null,
        subtotal,
        subtotal_sek: subtotalSek,
        vat_amount: vatAmount,
        vat_amount_sek: vatAmountSek,
        total,
        total_sek: totalSek,
        remaining_amount: total,
        notes: body.notes ?? null,
      })
      .select(SI_RESPONSE_COLUMNS)
      .single()

    if (invoiceErr || !invoice) {
      const pgErr = invoiceErr as { code?: string; message?: string } | null
      const isDuplicateNumber =
        pgErr?.code === '23505' &&
        (pgErr.message || '').includes('idx_supplier_invoices_company_supplier_number')
      if (isDuplicateNumber) {
        return v1ErrorResponseFromCode('SI_CREATE_DUPLICATE_INVOICE_NUMBER', ctx.log, {
          requestId: ctx.requestId,
          details: {
            supplier_id: body.supplier_id,
            supplier_invoice_number: body.supplier_invoice_number,
          },
        })
      }
      ctx.log.error('supplier invoice insert failed', invoiceErr, {
        companyId: ctx.companyId,
        pgCode: pgErr?.code,
      })
      return v1ErrorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { pg_code: pgErr?.code },
      })
    }

    const invoiceId = (invoice as { id: string }).id

    // Insert items; rollback the parent on failure.
    const itemInserts = items.map((item) => ({ supplier_invoice_id: invoiceId, ...item }))
    const { error: itemsErr } = await ctx.supabase
      .from('supplier_invoice_items')
      .insert(itemInserts)
    if (itemsErr) {
      // items_insert fires before any engine call — no JE could exist.
      await rollbackSupplierInvoice(ctx.supabase, invoiceId, ctx.companyId!, ctx.log, 'items_insert', false)
      return v1ErrorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { step: 'items_insert', pg_code: (itemsErr as { code?: string }).code },
      })
    }

    // Determine accounting method — registration JE is only posted under accrual.
    const { data: settings } = await ctx.supabase
      .from('company_settings')
      .select('accounting_method')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    const accountingMethod = (settings as { accounting_method?: string } | null)?.accounting_method ?? 'accrual'

    let registrationJournalEntryId: string | null = null
    if (accountingMethod === 'accrual') {
      try {
        const entry = await createSupplierInvoiceRegistrationEntry(
          ctx.supabase,
          ctx.companyId!,
          ctx.userId,
          invoice as unknown as SupplierInvoice,
          itemInserts as unknown as SupplierInvoiceItem[],
          supplier.supplier_type,
          supplier.name,
        )
        if (entry) {
          registrationJournalEntryId = entry.id
          const { error: linkErr } = await ctx.supabase
            .from('supplier_invoices')
            .update({ registration_journal_entry_id: entry.id })
            .eq('id', invoiceId)
            .eq('company_id', ctx.companyId!)
          if (linkErr) {
            // The JE is posted but the SI denormalised back-reference failed
            // to update. Storno the orphan JE first, then roll back the SI row
            // to preserve strict-mode atomicity (otherwise a subsequent GET
            // would show registration_journal_entry_id=null with a live JE on
            // the books). reverseEntry takes the entry id directly.
            ctx.log.error('SI register: JE link update failed — stornoing JE and rolling back row', linkErr, {
              invoiceId,
              companyId: ctx.companyId,
              userId: ctx.userId,
              journalEntryId: entry.id,
            })
            try {
              await reverseEntry(ctx.supabase, ctx.companyId!, ctx.userId, entry.id, body.invoice_date)
            } catch (revErr) {
              ctx.log.error('JE storno failed after SI link-update error — manual reconciliation required', revErr as Error, {
                invoiceId,
                companyId: ctx.companyId,
                userId: ctx.userId,
                journalEntryId: entry.id,
              })
            }
            // je_link_failed: the JE was posted (and we just stornoed it
            // above). Soft-mark keeps the audit trail visible per BFL 5:5.
            await rollbackSupplierInvoice(ctx.supabase, invoiceId, ctx.companyId!, ctx.log, 'je_link_failed', true)
            return v1ErrorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
              requestId: ctx.requestId,
              details: { step: 'registration_journal_entry_link' },
            })
          }
        } else {
          // Engine returned null (no open fiscal period). Strict-mode: roll back.
          // Engine returned null before posting — no JE exists.
          await rollbackSupplierInvoice(ctx.supabase, invoiceId, ctx.companyId!, ctx.log, 'no_fiscal_period', false)
          return v1ErrorResponseFromCode('SI_CREATE_NO_FISCAL_PERIOD', ctx.log, {
            requestId: ctx.requestId,
            details: { step: 'registration_journal_entry', invoice_date: body.invoice_date },
          })
        }
      } catch (err) {
        // Engine threw — conservatively assume the JE may have committed
        // before the throw (createJournalEntry is the atomic write inside
        // the engine; a throw after that point would still leave a posted
        // JE). Soft-mark to preserve any half-committed audit trail.
        await rollbackSupplierInvoice(ctx.supabase, invoiceId, ctx.companyId!, ctx.log, 'registration_journal_entry', true)
        if (isBookkeepingError(err)) {
          return v1ErrorResponse(err, ctx.log, { requestId: ctx.requestId })
        }
        ctx.log.error('supplier-invoice registration JE creation failed', err as Error, {
          invoiceId,
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('SI_CREATE_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { step: 'registration_journal_entry' },
        })
      }
    }

    try {
      await eventBus.emit({
        type: 'supplier_invoice.registered',
        payload: {
          supplierInvoice: invoice as unknown as SupplierInvoice,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('supplier_invoice.registered emit failed', err as Error)
    }

    // Refetch with the registration_journal_entry_id populated and items.
    const { data: complete } = await ctx.supabase
      .from('supplier_invoices')
      .select(`${SI_RESPONSE_COLUMNS}, items:supplier_invoice_items(${SI_ITEMS_RESPONSE_COLUMNS})`)
      .eq('company_id', ctx.companyId!)
      .eq('id', invoiceId)
      .maybeSingle()

    return created(
      complete ?? { ...invoice, items: itemInserts, registration_journal_entry_id: registrationJournalEntryId },
      { requestId: ctx.requestId },
    )
  },
  { requireIdempotencyKey: true },
)

async function rollbackSupplierInvoice(
  supabase: SupabaseClient,
  invoiceId: string,
  companyId: string,
  log: import('@/lib/logger').Logger,
  reason: string,
  journalEntryPosted: boolean,
) {
  // BFL 5 kap 5 § applies once a verifikation has been committed to the
  // books. A failed insert that never produced a JE (items_insert error,
  // engine returning null because no fiscal period covers the date) is a
  // failed insertion, not a bokföringspost — a row with status='reversed'
  // and registration_journal_entry_id=null would be a dangling
  // räkenskapsinformation entry harder to audit than a clean removal.
  //
  // So: soft-mark `reversed` ONLY when a JE existed at the point of
  // failure. Pre-JE failures hard-delete (with explicit items wipe in case
  // the items insert partially succeeded — which Postgres makes atomic for
  // a single INSERT, but the defense is cheap).
  if (!journalEntryPosted) {
    await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', invoiceId)
    const { error: parentErr } = await supabase
      .from('supplier_invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('company_id', companyId)
    if (parentErr) {
      log.error('supplier-invoice hard-rollback failed — orphan row', parentErr, {
        invoiceId,
        companyId,
        rollbackReason: reason,
      })
    } else {
      log.warn('supplier-invoice hard-rolled back (no JE existed)', {
        invoiceId,
        companyId,
        rollbackReason: reason,
      })
    }
    return
  }

  // Post-JE soft-mark. Status='reversed' is the same flag the dashboard
  // uses for "Ångra kreditering"; the row + items remain queryable, the
  // already-stornoed verifikation pair stays visible on the JE side.
  const { error: updateErr } = await supabase
    .from('supplier_invoices')
    .update({ status: 'reversed', reversed_at: new Date().toISOString() })
    .eq('id', invoiceId)
    .eq('company_id', companyId)
  if (updateErr) {
    log.error('supplier-invoice soft-rollback failed — manual reconciliation required', updateErr, {
      invoiceId,
      companyId,
      rollbackReason: reason,
    })
  } else {
    log.warn('supplier-invoice soft-rolled back (status=reversed)', {
      invoiceId,
      companyId,
      rollbackReason: reason,
    })
  }
}
