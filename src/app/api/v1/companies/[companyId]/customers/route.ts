/**
 * /api/v1/companies/{companyId}/customers: list + create customer endpoints.
 *
 * GET  : list with filters (customer_type, search, include_archived).
 *         Cursor pagination on (created_at ASC, id ASC).
 * POST : create. Idempotent (mandatory Idempotency-Key). Dry-runnable
 *         (?dry_run=true returns validated would-be record without
 *         committing). VIES validation runs only on commit.
 */

import { z } from 'zod'
import { paginated } from '@/lib/api/v1/response'
import {
  decodeDefaultCursor,
  encodeDefaultCursor,
  parsePaginationParams,
  PaginationQueryShape,
} from '@/lib/api/v1/pagination'
import { registerEndpoint, listEnvelope, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { CreateCustomerSchema } from '@/lib/api/schemas'
import { orgNumberIsPersonalIdentifier } from '@/lib/customers/personal-number-shape'
import { createCustomer } from '@/lib/customers/customer-commands'
import { CustomerRecordSchema, customerRecordOutcome } from '@/lib/customers/customer-record'
import { v1OutcomeResponse } from '@/lib/operations/v1'

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
  /** The party (motpart) behind the row; fetch it with GET .../{id}?expand=party or the MCP tool get_party. */
  party_id: z.string().uuid().nullable().optional(),
  archived_at: z.string().nullable(),
  created_at: z.string(),
})

const CustomersListResponse = listEnvelope(CustomerSummary)

// Explicit projection: never SELECT *. Schema migrations adding columns
// must update this list before the field becomes visible on the public API.
const CUSTOMER_SUMMARY_COLUMNS =
  'id, name, customer_type, email, org_number, vat_number, default_payment_terms, party_id, archived_at, created_at'

const ListFilters = z.object({
  customer_type: CustomerType.optional().describe('Only customers of this type.'),
  search: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe('Case-insensitive match on the name (anywhere) or the org number (prefix), 1-200 characters.'),
  include_archived: z
    .enum(['true', 'false'])
    .optional()
    .describe('true also returns archived customers. Default: false.'),
})

const ListQuery = ListFilters.extend(PaginationQueryShape)

registerEndpoint({
  operation: 'customers.list',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers',
  summary: 'List customers for a company.',
  description:
    'Returns active customers in created-first order. Pass ?include_archived=true to include archived rows. Use ?search to match against name or org_number.',
  useWhen:
    'You need a customer roster: for building a UI picker, syncing a CRM, or resolving a customer_id before creating an invoice.',
  doNotUseFor:
    'Fetching a single customer you already know the id of: use GET /api/v1/companies/{companyId}/customers/{id}. Suppliers are a separate resource.',
  pitfalls: [
    'Archived customers are hidden by default; the dashboard makes the same choice.',
    'org_number is included so callers can match against external CRM identifiers, except where it is a natural person\'s identity number: a sole trader (enskild firma) has no org number of its own, so its org_number and vat_number come back null in the list. Read the record with GET /customers/{id} for the full value.',
  ],
  example: {
    response: {
      data: [
        {
          id: 'a8f1…',
          name: 'Acme AB',
          customer_type: 'swedish_business',
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
  request: { query: ListQuery },
  response: { success: CustomersListResponse },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.list',
  async (request, ctx) => {
    const url = new URL(request.url)
    const { limit, cursor } = parsePaginationParams(url)
    const decoded = decodeDefaultCursor(cursor)

    const filtersResult = ListFilters.safeParse({
      customer_type: url.searchParams.get('customer_type') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      include_archived: url.searchParams.get('include_archived') ?? undefined,
    })
    if (!filtersResult.success) {
      return v1ValidationError(ctx, filtersResult.error)
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
    // customer_type='individual'), org_number IS the personnummer: a
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
    //
    // An enskild firma registered as customer_type='swedish_business' is the
    // same disclosure without the individual type: it has no org number of
    // its own, so org_number holds the owner's personnummer and vat_number is
    // derived from it. Masked here on the same grounds (#2367).
    const INDIVIDUAL_TYPES = new Set(['individual', 'eu_individual'])

    const customers = trimmed.map((r) => {
      const isIndividual =
        INDIVIDUAL_TYPES.has(r.customer_type)
        || orgNumberIsPersonalIdentifier(r.customer_type, r.org_number)
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
// POST: create customer
// ──────────────────────────────────────────────────────────────────

// The customer record every v1 customer read and write answers
// (lib/customers/customer-record.ts). A dry run writes nothing, so it has no
// id and no timestamps.
const CustomerCreated = CustomerRecordSchema.extend({
  id: z.string().uuid().nullable(),
  customer_type: CustomerType,
  created_at: z.string().nullable(),
  updated_at: z.string().nullable(),
})

registerEndpoint({
  operation: 'customers.create',
  method: 'POST',
  path: '/api/v1/companies/:companyId/customers',
  summary: 'Create a customer.',
  description:
    'Creates a new customer for the company. Requires Idempotency-Key (UUID). Supports ?dry_run=true for input validation without committing: the dry-run response shows the would-be record minus id and timestamps. EU-business customers with a VAT number are auto-validated against VIES on commit.',
  useWhen:
    'You need to register a new customer before invoicing them. Use dry-run first to catch validation errors before committing.',
  doNotUseFor:
    'Updating an existing customer (PATCH instead). Creating suppliers (different resource).',
  pitfalls: [
    'Idempotency-Key is mandatory: calls without it return 400 VALIDATION_ERROR.',
    'org_number uniqueness is enforced at the database level; duplicate inserts return 409 CUSTOMER_DUPLICATE_ORG_NUMBER.',
    'A personnummer-shaped org_number on customer_type=individual is treated as the personnummer submitted in the wrong field: it is stored encrypted as personal_number, returned masked (********-1234), and org_number is left empty. Prefer passing it as personal_number. Next to a different personal_number in the same body it is a 400.',
    'An org_number shaped like a Swedish personnummer is accepted on customer_type=swedish_business: a sole trader (enskild firma) has no separate org number, so its owner\'s personnummer is the firm\'s identifier, and the list endpoint masks it. It is rejected for eu_business and non_eu_business, which cannot have one.',
    'personal_number is accepted only for customer_type=individual, stored encrypted, and returned in the masked form ********-1234.',
    'An individual has no org number: an org_number on customer_type=individual that is not a personnummer is a 400. Leave it empty, or use customer_type=swedish_business for a business.',
    'If default_payment_terms is omitted, it defaults to the company setting invoice_default_days, falling back to 30.',
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
  response: { success: dataEnvelope(CustomerCreated) },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'customers.create',
  async (request, ctx) => {
    const raw = await readV1JsonBody(request, ctx)
    if (!raw.ok) return raw.response

    const parsed = CreateCustomerSchema.safeParse(raw.body)
    if (!parsed.success) {
      return v1ValidationError(ctx, parsed.error)
    }

    // One insert and one rule set with the dashboard and the agent's approval
    // (lib/customers/customer-commands.ts). The dry run answers the would-be
    // record; VIES runs only on the real insert.
    const outcome = await createCustomer(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      parsed.data,
      { dryRun: ctx.dryRun },
    )
    return v1OutcomeResponse(customerRecordOutcome(outcome), ctx)
  },
  { requireIdempotencyKey: true },
)
