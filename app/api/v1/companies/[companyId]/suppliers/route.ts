/**
 * /api/v1/companies/{companyId}/suppliers — list + create supplier endpoints.
 *
 * GET   — list with filters (supplier_type, search, include_archived).
 *         Cursor pagination on (created_at ASC, id ASC).
 * POST  — create. Idempotent (mandatory Idempotency-Key). Dry-runnable
 *         (?dry_run=true returns the validated would-be record without
 *         committing).
 *
 * VIES validation note: unlike customers, suppliers do not carry a
 * `vat_number_validated` flag in the schema today. The vat_number is
 * accepted as input but not auto-verified against VIES — a deliberate
 * scope decision documented in the endpoint pitfalls.
 */

import { z } from 'zod'
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
import { CreateSupplierSchema } from '@/lib/api/schemas'
import { eventBus } from '@/lib/events'
import type { Supplier } from '@/types'

const SupplierType = z.enum([
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

const SupplierSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  supplier_type: SupplierType,
  email: z.string().nullable(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
})

const SuppliersListResponse = listEnvelope(SupplierSummary)

// Explicit projection — never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
const SUPPLIER_SUMMARY_COLUMNS =
  'id, name, supplier_type, email, org_number, vat_number, default_payment_terms, default_currency, archived_at, created_at'

registerEndpoint({
  operation: 'suppliers.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/suppliers',
  summary: 'List suppliers for a company.',
  description:
    'Returns active suppliers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.',
  useWhen:
    'You need a supplier roster — for building a UI picker, resolving a supplier_id before registering a supplier invoice, or syncing an external AP system.',
  doNotUseFor:
    'Fetching a single supplier you already know the id of — use GET /api/v1/companies/{companyId}/suppliers/{id}. Customers are a separate resource.',
  pitfalls: [
    'Archived suppliers are hidden by default; the dashboard makes the same choice.',
    'org_number identifies legal entities only — suppliers currently have no `individual` type, so the field is Bolagsverket public-record data when present.',
    'vat_number is stored as supplied; unlike customers, suppliers are not auto-validated against VIES on create. Validate externally if the integration requires it.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          name: 'Office Depot AB',
          supplier_type: 'swedish_business',
          email: 'invoices@officedepot.example',
          org_number: '556677-8899',
          vat_number: 'SE556677889901',
          default_payment_terms: 30,
          default_currency: 'SEK',
          archived_at: null,
          created_at: '2026-04-12T08:30:00Z',
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
  response: { success: SuppliersListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'suppliers.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      supplier_type: SupplierType.optional(),
      search: z.string().min(1).max(200).optional(),
      include_archived: z.enum(['true', 'false']).optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      supplier_type: url.searchParams.get('supplier_type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_archived: url.searchParams.get('include_archived') ?? undefined,
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
    const includeArchived = filters.include_archived === 'true'

    let query = ctx.supabase
      .from('suppliers')
      .select(SUPPLIER_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (!includeArchived) {
      query = query.is('archived_at', null)
    }
    if (filters.supplier_type) {
      query = query.eq('supplier_type', filters.supplier_type)
    }
    if (filters.search) {
      // Two layers of escaping (matches the customers list):
      //   1. PostgREST `.or()` filter syntax uses commas + parens as
      //      delimiters; strip them from the user-supplied term.
      //   2. SQL LIKE treats `%` and `_` (and `\` as the default escape) as
      //      wildcards; escape them so '100%' matches the literal string.
      const term = filters.search
        .replace(/[,()]/g, '')
        .replace(/[%_\\]/g, '\\$&')
      query = query.or(`name.ilike.%${term}%,org_number.ilike.${term}%`)
    }

    if (decoded) {
      query = query.or(
        `created_at.gt.${decoded.ts},and(created_at.eq.${decoded.ts},id.gt.${decoded.id})`,
      )
    }

    const { data, error } = await query

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    type Row = {
      id: string
      name: string
      supplier_type: string
      email: string | null
      org_number: string | null
      vat_number: string | null
      default_payment_terms: number
      default_currency: string
      archived_at: string | null
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    // GDPR Art.5(1)(c) defense-in-depth: SupplierType has no `individual`
    // variant today (only swedish_business / eu_business / non_eu_business),
    // so the org_number is Bolagsverket public-record data. Were a future
    // schema iteration introduce a natural-person supplier type, the list
    // endpoint should mask org_number/vat_number the same way the customer
    // list does for `individual`. Leaving the hook (an empty INDIVIDUAL_TYPES
    // set) makes that change a one-line edit and signals the design intent
    // to anyone copying the file.
    const INDIVIDUAL_TYPES = new Set<string>([])

    const suppliers = trimmed.map((r) => {
      const isIndividual = INDIVIDUAL_TYPES.has(r.supplier_type)
      return {
        id: r.id,
        name: r.name,
        supplier_type: r.supplier_type,
        email: r.email,
        org_number: isIndividual ? null : r.org_number,
        vat_number: isIndividual ? null : r.vat_number,
        default_payment_terms: r.default_payment_terms,
        default_currency: r.default_currency,
        archived_at: r.archived_at,
        created_at: r.created_at,
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(suppliers, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST — create supplier
// ──────────────────────────────────────────────────────────────────

const SupplierCreated = z.object({
  id: z.string().uuid().nullable(),
  name: z.string(),
  supplier_type: SupplierType,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  bank_account: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  default_expense_account: z.string().nullable(),
  default_payment_terms: z.number(),
  default_currency: z.string(),
  notes: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})

const SUPPLIER_RESPONSE_COLUMNS =
  'id, name, supplier_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, bankgiro, plusgiro, bank_account, iban, bic, default_expense_account, default_payment_terms, default_currency, notes, archived_at, created_at, updated_at'

registerEndpoint({
  operation: 'suppliers.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/suppliers',
  summary: 'Create a supplier.',
  description:
    'Creates a new supplier for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing — the dry-run response shows the would-be record minus id and timestamps.',
  useWhen:
    'You need to register a new supplier before booking supplier invoices against them. Use dry-run first to catch validation errors before committing.',
  doNotUseFor:
    'Updating an existing supplier (PATCH instead). Creating customers (different resource).',
  pitfalls: [
    'Idempotency-Key is mandatory — calls without it return 400 VALIDATION_ERROR.',
    'org_number uniqueness is enforced at the database level; duplicate inserts return 409 SUPPLIER_DUPLICATE_ORG_NUMBER.',
    'Unlike customers, suppliers carry no `vat_number_validated` flag — vat_number is stored as supplied without VIES verification. Validate externally if your workflow requires it.',
    'default_expense_account is a BAS account number (e.g. "5410"); the value is stored as-is and used as the suggested debit account when supplier invoices are booked.',
  ],
  example: {
    request: {
      name: 'Office Depot AB',
      supplier_type: 'swedish_business',
      email: 'invoices@officedepot.example',
      org_number: '556677-8899',
      bankgiro: '123-4567',
      default_expense_account: '5410',
      default_payment_terms: 30,
      default_currency: 'SEK',
    },
    response: {
      data: {
        id: '0e9c…',
        name: 'Office Depot AB',
        supplier_type: 'swedish_business',
        email: 'invoices@officedepot.example',
        org_number: '556677-8899',
        bankgiro: '123-4567',
        default_expense_account: '5410',
        default_payment_terms: 30,
        default_currency: 'SEK',
        archived_at: null,
        created_at: '2026-05-13T15:00:00Z',
        updated_at: '2026-05-13T15:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'suppliers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateSupplierSchema },
  response: { success: SupplierCreated },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'suppliers.create',
  async (request, ctx) => {
    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body is not valid JSON.' },
      })
    }

    const parsed = CreateSupplierSchema.safeParse(rawBody)
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

    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: null,
          name: body.name,
          supplier_type: body.supplier_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          address_line1: body.address_line1 ?? null,
          address_line2: body.address_line2 ?? null,
          postal_code: body.postal_code ?? null,
          city: body.city ?? null,
          country: body.country ?? 'SE',
          org_number: body.org_number ?? null,
          vat_number: body.vat_number ?? null,
          bankgiro: body.bankgiro ?? null,
          plusgiro: body.plusgiro ?? null,
          bank_account: body.bank_account ?? null,
          iban: body.iban ?? null,
          bic: body.bic ?? null,
          default_expense_account: body.default_expense_account ?? null,
          default_payment_terms: body.default_payment_terms ?? 30,
          default_currency: body.default_currency ?? 'SEK',
          notes: body.notes ?? null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('suppliers')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        name: body.name,
        supplier_type: body.supplier_type,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address_line1: body.address_line1 ?? null,
        address_line2: body.address_line2 ?? null,
        postal_code: body.postal_code ?? null,
        city: body.city ?? null,
        country: body.country ?? 'SE',
        org_number: body.org_number ?? null,
        vat_number: body.vat_number ?? null,
        bankgiro: body.bankgiro ?? null,
        plusgiro: body.plusgiro ?? null,
        bank_account: body.bank_account ?? null,
        iban: body.iban ?? null,
        bic: body.bic ?? null,
        default_expense_account: body.default_expense_account ?? null,
        default_payment_terms: body.default_payment_terms ?? 30,
        default_currency: body.default_currency ?? 'SEK',
        notes: body.notes ?? null,
      })
      .select(SUPPLIER_RESPONSE_COLUMNS)
      .single()

    if (error) {
      if (error.code === '23505') {
        // Symmetric with customers: do NOT echo body.org_number — guards
        // against accidentally leaking a natural-person identifier in the
        // future if SupplierType ever gains an `individual` variant.
        return v1ErrorResponseFromCode('SUPPLIER_DUPLICATE_ORG_NUMBER', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'org_number' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    try {
      await eventBus.emit({
        type: 'supplier.created',
        payload: {
          supplier: { ...(data as Record<string, unknown>), user_id: ctx.userId, company_id: ctx.companyId! } as unknown as Supplier,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('supplier.created emit failed', err as Error)
    }

    return created(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
