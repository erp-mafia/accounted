/**
 * /api/v1/companies/{companyId}/customers — list + create customer endpoints.
 *
 * GET   — list with filters (customer_type, search, include_archived).
 *         Cursor pagination on (created_at ASC, id ASC).
 * POST  — create. Idempotent (mandatory Idempotency-Key). Dry-runnable
 *         (?dry_run=true returns validated would-be record without
 *         committing). VIES validation runs only on commit.
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
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { validateVatNumber } from '@/lib/vat/vies-client'
import { eventBus } from '@/lib/events'
import type { Customer } from '@/types'

// Mirror the canonical CustomerTypeSchema from lib/api/schemas.ts. Only
// 'individual' refers to a natural person (Swedish sole trader / enskild
// firma); the three *_business variants are legal entities.
const CustomerType = z.enum([
  'individual',
  'swedish_business',
  'eu_business',
  'non_eu_business',
])

const CustomerSummary = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customer_type: CustomerType,
  email: z.string().nullable(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  default_payment_terms: z.number(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
})

const CustomersListResponse = listEnvelope(CustomerSummary)

// Explicit projection — never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
const CUSTOMER_SUMMARY_COLUMNS =
  'id, name, customer_type, email, org_number, vat_number, default_payment_terms, archived_at, created_at'

registerEndpoint({
  operation: 'customers.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers',
  summary: 'List customers for a company.',
  description:
    'Returns active customers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.',
  useWhen:
    'You need a customer roster — for building a UI picker, syncing a CRM, or resolving a customer_id before creating an invoice.',
  doNotUseFor:
    'Fetching a single customer you already know the id of — use GET /api/v1/companies/{companyId}/customers/{id}. Suppliers are a separate resource.',
  pitfalls: [
    'Archived customers are hidden by default; the dashboard makes the same choice.',
    'org_number is included so callers can match against external CRM identifiers; for sole traders (enskild firma) it equals the personnummer.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          name: 'Acme AB',
          customer_type: 'business',
          email: 'finance@acme.example',
          org_number: '556677-8899',
          vat_number: 'SE556677889901',
          default_payment_terms: 30,
          archived_at: null,
          created_at: '2025-04-12T08:30:00Z',
        },
      ],
      meta: { request_id: 'req_…', api_version: '2026-05-12', next_cursor: null },
    },
  },
  scope: 'customers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: CustomersListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const FiltersSchema = z.object({
      customer_type: CustomerType.optional(),
      search: z.string().min(1).max(200).optional(),
      include_archived: z.enum(['true', 'false']).optional(),
    })
    const filtersResult = FiltersSchema.safeParse({
      customer_type: url.searchParams.get('customer_type') ?? undefined,
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
      .from('customers')
      .select(CUSTOMER_SUMMARY_COLUMNS)
      .eq('company_id', ctx.companyId!)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .limit(limit + 1)

    if (!includeArchived) {
      query = query.is('archived_at', null)
    }
    if (filters.customer_type) {
      query = query.eq('customer_type', filters.customer_type)
    }
    if (filters.search) {
      // Build a safe ilike pattern. Two layers of escaping:
      //   1. PostgREST `.or()` filter syntax uses commas + parens as
      //      delimiters; strip them from the user-supplied term.
      //   2. SQL LIKE treats `%` and `_` (and `\` as the default escape) as
      //      wildcards; escape them so '100%' searches for the literal
      //      string '100%' rather than 'anything containing 100'.
      const term = filters.search
        .replace(/[,()]/g, '')      // PostgREST delimiters
        .replace(/[%_\\]/g, '\\$&') // LIKE wildcards
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
      customer_type: string
      email: string | null
      org_number: string | null
      vat_number: string | null
      default_payment_terms: number
      archived_at: string | null
      created_at: string
    } & Record<string, unknown>

    const rows = ((data ?? []) as unknown) as Row[]
    const trimmed = rows.slice(0, limit)
    const hasMore = rows.length > limit

    // GDPR Art.5(1)(c) data minimisation: for sole traders (enskild firma,
    // customer_type='individual'), org_number IS the personnummer — a
    // directly identifying special-category identifier. Mask both
    // org_number and vat_number in the LIST response so bulk fetches don't
    // expose personal IDs. The DETAIL endpoint (deliberate drill-in to one
    // record) still returns them. Business customers' org_numbers are
    // Bolagsverket public-record data and stay visible.
    //
    // 'eu_individual' is retained as defense-in-depth: it's not a valid
    // value in the canonical CustomerTypeSchema (so newly created customers
    // can never have it), but the `customer_type` DB column has no CHECK
    // constraint, so legacy rows from prior schema iterations could in
    // principle carry it. Masking is free when the value never appears and
    // protective if it ever does. Adding 'eu_individual' as a first-class
    // customer_type for EU natural persons is a separate product decision.
    const INDIVIDUAL_TYPES = new Set(['individual', 'eu_individual'])

    const customers = trimmed.map((r) => {
      const isIndividual = INDIVIDUAL_TYPES.has(r.customer_type)
      return {
        id: r.id,
        name: r.name,
        customer_type: r.customer_type,
        email: r.email,
        org_number: isIndividual ? null : r.org_number,
        vat_number: isIndividual ? null : r.vat_number,
        default_payment_terms: r.default_payment_terms,
        archived_at: r.archived_at,
        created_at: r.created_at,
      }
    })

    const last = trimmed[trimmed.length - 1]
    const nextCursor = hasMore && last
      ? encodeDefaultCursor({ id: last.id, created_at: last.created_at })
      : null

    return paginated(customers, {
      requestId: ctx.requestId,
      nextCursor: nextCursor ?? undefined,
    })
  },
)

// ──────────────────────────────────────────────────────────────────
// POST — create customer
// ──────────────────────────────────────────────────────────────────

const CustomerCreated = z.object({
  id: z.string().uuid().nullable(),
  name: z.string(),
  customer_type: CustomerType,
  email: z.string().nullable(),
  phone: z.string().nullable(),
  address_line1: z.string().nullable(),
  address_line2: z.string().nullable(),
  postal_code: z.string().nullable(),
  city: z.string().nullable(),
  country: z.string(),
  org_number: z.string().nullable(),
  vat_number: z.string().nullable(),
  vat_number_validated: z.boolean(),
  default_payment_terms: z.number(),
  notes: z.string().nullable(),
  archived_at: z.string().nullable(),
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})

// Drop vat_number_validated_at — declared in neither CustomerCreated nor
// CustomerDetail; an internal timestamp with no documented consumer.
const CUSTOMER_RESPONSE_COLUMNS =
  'id, name, customer_type, email, phone, address_line1, address_line2, postal_code, city, country, org_number, vat_number, vat_number_validated, default_payment_terms, notes, archived_at, created_at, updated_at'

registerEndpoint({
  operation: 'customers.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/customers',
  summary: 'Create a customer.',
  description:
    'Creates a new customer for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing — the dry-run response shows the would-be record minus id and timestamps. EU-business customers with a VAT number are auto-validated against VIES on commit.',
  useWhen:
    'You need to register a new customer before invoicing them. Use dry-run first to catch validation errors before committing.',
  doNotUseFor:
    'Updating an existing customer (PATCH instead). Creating suppliers (different resource).',
  pitfalls: [
    'Idempotency-Key is mandatory — calls without it return 400 VALIDATION_ERROR.',
    'org_number uniqueness is enforced at the database level; duplicate inserts return 409 CUSTOMER_DUPLICATE_ORG_NUMBER.',
    'For Swedish sole traders (customer_type=individual), org_number IS the personnummer. List responses mask it; the create endpoint accepts it as input.',
    'VIES validation runs only on commit. Dry-run skips the external call and leaves vat_number_validated=false in the preview.',
  ],
  example: {
    request: {
      name: 'Acme AB',
      customer_type: 'swedish_business',
      email: 'finance@acme.test',
      org_number: '556677-8899',
      default_payment_terms: 30,
    },
    response: {
      data: {
        id: '0e9c…',
        name: 'Acme AB',
        customer_type: 'swedish_business',
        email: 'finance@acme.test',
        org_number: '556677-8899',
        vat_number_validated: false,
        default_payment_terms: 30,
        archived_at: null,
        created_at: '2026-05-12T16:00:00Z',
        updated_at: '2026-05-12T16:00:00Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: CreateCustomerSchema },
  response: { success: CustomerCreated },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.create',
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

    const parsed = CreateCustomerSchema.safeParse(rawBody)
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

    // Dry-run: validate input, return the would-be record. id, timestamps,
    // and vat_number_validated all populate on commit, not here.
    if (ctx.dryRun) {
      return dryRunPreview(
        {
          id: null,
          name: body.name,
          customer_type: body.customer_type,
          email: body.email ?? null,
          phone: body.phone ?? null,
          address_line1: body.address_line1 ?? null,
          address_line2: body.address_line2 ?? null,
          postal_code: body.postal_code ?? null,
          city: body.city ?? null,
          country: body.country ?? 'Sweden',
          org_number: body.org_number ?? null,
          vat_number: body.vat_number ?? null,
          vat_number_validated: false,
          default_payment_terms: body.default_payment_terms ?? 30,
          notes: body.notes ?? null,
          archived_at: null,
          created_at: null,
          updated_at: null,
        },
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Best-effort VIES validation. Resolve BEFORE the insert so the
    // resulting row reflects the validation state atomically and the
    // API response can't expose stale vat_number_validated.
    let vatValidated = false
    let vatValidatedAt: string | null = null
    if (body.customer_type === 'eu_business' && body.vat_number) {
      try {
        const vatResult = await validateVatNumber(body.vat_number)
        if (vatResult.valid) {
          vatValidated = true
          vatValidatedAt = new Date().toISOString()
        }
      } catch (err) {
        ctx.log.warn('auto-VIES validation failed on customer create', err as Error)
      }
    }

    const { data, error } = await ctx.supabase
      .from('customers')
      .insert({
        user_id: ctx.userId,
        company_id: ctx.companyId!,
        name: body.name,
        customer_type: body.customer_type,
        email: body.email ?? null,
        phone: body.phone ?? null,
        address_line1: body.address_line1 ?? null,
        address_line2: body.address_line2 ?? null,
        postal_code: body.postal_code ?? null,
        city: body.city ?? null,
        country: body.country ?? 'Sweden',
        org_number: body.org_number ?? null,
        vat_number: body.vat_number ?? null,
        vat_number_validated: vatValidated,
        vat_number_validated_at: vatValidatedAt,
        language: body.language ?? 'sv',
        default_payment_terms: body.default_payment_terms ?? 30,
        notes: body.notes ?? null,
      })
      .select(CUSTOMER_RESPONSE_COLUMNS)
      .single()

    if (error) {
      if (error.code === '23505') {
        // GDPR Art.5(1)(c): do NOT echo body.org_number in the response —
        // for customer_type='individual' it IS the personnummer.
        // The error code alone tells the caller which field conflicted;
        // they already know the value they submitted.
        return v1ErrorResponseFromCode('CUSTOMER_DUPLICATE_ORG_NUMBER', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'org_number' },
        })
      }
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }

    // Emit customer.created so webhooks (Phase 2 PR-C) and downstream
    // handlers can react. Best-effort — emit failure does not roll back.
    // Cast through `unknown` because the response projection deliberately
    // omits internal scoping fields (user_id, company_id) the Customer type
    // requires; we re-inject them on the payload from ctx.
    try {
      await eventBus.emit({
        type: 'customer.created',
        payload: {
          customer: { ...(data as Record<string, unknown>), user_id: ctx.userId, company_id: ctx.companyId! } as unknown as Customer,
          companyId: ctx.companyId!,
          userId: ctx.userId,
        },
      })
    } catch (err) {
      ctx.log.warn('customer.created emit failed', err as Error)
    }

    return created(data, { requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
