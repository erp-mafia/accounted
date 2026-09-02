/**
 * /api/v1/companies/{companyId}/settings: company-settings writes.
 *
 * PATCH: partial update of invoice payment details (bank account, Bankgiro,
 *        Plusgiro, Swish, IBAN/BIC), company contact details shown on
 *        invoices (email, phone, website, contact_person), and the custom
 *        invoice email texts. Idempotent (mandatory Idempotency-Key).
 *        Dry-runnable.
 *
 * The field set is deliberately identical to the MCP staging tool
 * gnubok_update_company_settings and validation is the SAME shared schema
 * (UpdateCompanySettingsParamsSchema): Luhn-checked Bankgiro/Plusgiro and a
 * fixed placeholder whitelist for the invoice email texts. Do not widen this
 * surface toward the internal /api/settings PUT: that route accepts tax and
 * legal profile fields and regenerates tax deadlines as a side effect.
 *
 * The write is direct (no staged operation), following the v1 customers
 * precedent: REST callers are already gated by the companies:write scope.
 *
 * No GET here yet: a read endpoint is a possible follow-up (the MCP tool
 * gnubok_get_company_settings covers reads today).
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { InvoiceEmailTextsSchema, UpdateSettingsSchema } from '@/lib/api/schemas'
import { UpdateCompanySettingsParamsSchema } from '@/lib/pending-operations/schemas/company-settings'

// Flat body keys copied into the update payload verbatim. Mirrors the MCP
// tool gnubok_update_company_settings field for field; contact_person is
// handled separately because it aliases the default_our_reference column.
const FLAT_BODY_KEYS = [
  'bank_name',
  'clearing_number',
  'account_number',
  'bankgiro',
  'plusgiro',
  'swish',
  'iban',
  'bic',
  'email',
  'phone',
  'website',
  'invoice_email_texts',
] as const

const KNOWN_BODY_KEYS: ReadonlySet<string> = new Set([...FLAT_BODY_KEYS, 'contact_person'])

interface SettingsRow {
  bank_name: string | null
  clearing_number: string | null
  account_number: string | null
  bankgiro: string | null
  plusgiro: string | null
  swish: string | null
  iban: string | null
  bic: string | null
  default_our_reference: string | null
  email: string | null
  phone: string | null
  website: string | null
  invoice_email_texts: unknown
}

const CompanySettingsResource = z.object({
  company_id: z.string().uuid(),
  bank_name: z.string().nullable(),
  clearing_number: z.string().nullable(),
  account_number: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  swish: z.string().nullable(),
  iban: z.string().nullable(),
  bic: z.string().nullable(),
  contact_person: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  invoice_email_texts: InvoiceEmailTextsSchema.nullable(),
})

// Documentation body schema (OpenAPI + agent tool docs). Field shapes are
// reused from UpdateSettingsSchema, exactly like the shared changes schema
// composes them; contact_person exposes the default_our_reference column
// under its public name. Runtime validation goes through the shared
// UpdateCompanySettingsParamsSchema in the handler so the REST endpoint and
// the MCP tool can never drift apart on the Swedish-domain rules.
const V1PatchCompanySettingsSchema = z
  .object({
    bank_name: UpdateSettingsSchema.shape.bank_name,
    clearing_number: UpdateSettingsSchema.shape.clearing_number,
    account_number: UpdateSettingsSchema.shape.account_number,
    bankgiro: UpdateSettingsSchema.shape.bankgiro,
    plusgiro: UpdateSettingsSchema.shape.plusgiro,
    swish: UpdateSettingsSchema.shape.swish,
    iban: UpdateSettingsSchema.shape.iban,
    bic: UpdateSettingsSchema.shape.bic,
    contact_person: UpdateSettingsSchema.shape.default_our_reference,
    email: UpdateSettingsSchema.shape.email,
    phone: UpdateSettingsSchema.shape.phone,
    website: UpdateSettingsSchema.shape.website,
    invoice_email_texts: UpdateSettingsSchema.shape.invoice_email_texts,
  })
  .strict()

function toSettingsResource(companyId: string, row: SettingsRow) {
  return {
    company_id: companyId,
    bank_name: row.bank_name ?? null,
    clearing_number: row.clearing_number ?? null,
    account_number: row.account_number ?? null,
    bankgiro: row.bankgiro ?? null,
    plusgiro: row.plusgiro ?? null,
    swish: row.swish ?? null,
    iban: row.iban ?? null,
    bic: row.bic ?? null,
    contact_person: row.default_our_reference ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    invoice_email_texts: row.invoice_email_texts ?? null,
  }
}

/**
 * Map a Zod issue path from the shared `{ changes: {...} }` wrapper back to
 * the public body field names: strip the `changes` prefix and rename
 * `default_our_reference` (the DB column) to `contact_person` (the only name
 * this endpoint accepts in the request body).
 */
function formatIssueField(path: ReadonlyArray<PropertyKey>): string {
  const rest = path[0] === 'changes' ? path.slice(1) : [...path]
  if (rest.length === 0) return 'body'
  return rest
    .map((segment, index) =>
      index === 0 && segment === 'default_our_reference' ? 'contact_person' : String(segment),
    )
    .join('.')
}

registerEndpoint({
  operation: 'companies.settings.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/settings',
  summary: 'Partially update company settings.',
  description:
    'Patches the company payment details (bank account, Bankgiro, Plusgiro, Swish, IBAN/BIC), the contact details shown on invoices (contact_person, email, phone, website), and the custom invoice email texts. All fields optional; at least one must be supplied. Idempotent (mandatory Idempotency-Key). Dry-runnable. The same validation as the MCP staging tool applies: Bankgiro/Plusgiro numbers are Luhn-checked and invoice email texts only accept a fixed placeholder set.',
  useWhen:
    'You need to change the payment or contact details that appear on invoices, or override the invoice email texts, directly over REST instead of the staged MCP flow.',
  doNotUseFor:
    'Legal or tax profile changes (org number, VAT registration, fiscal year, accounting method): those are not exposed on the public API. Reading settings (no GET endpoint yet; use the MCP tool gnubok_get_company_settings).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'contact_person is stored as default_our_reference: the default "Our reference" value on new invoices.',
    'bankgiro and plusgiro must carry a valid Luhn check digit; null or empty string clears them.',
    'invoice_email_texts only accepts the placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp}; any other {token} is rejected. Null clears every override.',
  ],
  example: {
    request: { bankgiro: '991-2346', contact_person: 'Anna Andersson' },
    response: {
      data: {
        company_id: 'aaaa1111-2222-4333-8444-555566667777',
        bank_name: 'Testbanken',
        clearing_number: null,
        account_number: null,
        bankgiro: '991-2346',
        plusgiro: null,
        swish: null,
        iban: null,
        bic: null,
        contact_person: 'Anna Andersson',
        email: 'faktura@acme.example',
        phone: null,
        website: null,
        invoice_email_texts: null,
      },
      meta: { request_id: 'req_...', api_version: '2026-05-12' },
    },
  },
  scope: 'companies:write',
  // Matches lib/pending-operations/risk-tiers.ts (update_company_settings):
  // payment settings control where customers send money on future invoices.
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: V1PatchCompanySettingsSchema },
  response: { success: dataEnvelope(CompanySettingsResource) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'companies.settings.update',
  async (request, ctx) => {
    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response
    const rawBody = rawBodyResult.body

    if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Body must be a JSON object.' },
      })
    }
    const body = rawBody as Record<string, unknown>

    // Reject unknown fields under their public names before the alias
    // mapping, so the caller is told about `contact_person`, never about the
    // internal column name.
    const unknownKeys = Object.keys(body).filter((key) => !KNOWN_BODY_KEYS.has(key))
    if (unknownKeys.length > 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: unknownKeys.map((key) => ({ field: key, message: 'Unknown field.' })),
        },
      })
    }

    // Build the changes payload exactly like the MCP tool: copy the flat keys
    // verbatim and alias the public contact_person field onto the
    // default_our_reference column.
    const rawChanges: Record<string, unknown> = {}
    for (const key of FLAT_BODY_KEYS) {
      if (body[key] !== undefined) rawChanges[key] = body[key]
    }
    if (body.contact_person !== undefined) {
      rawChanges.default_our_reference = body.contact_person
    }

    // Shared Swedish-domain validation (same schema as the MCP staging tool):
    // Luhn-checked bankgiro/plusgiro, placeholder whitelist on the invoice
    // email texts, and the at-least-one-field rule.
    const parsed = UpdateCompanySettingsParamsSchema.safeParse({ changes: rawChanges })
    if (!parsed.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: parsed.error.issues.map((issue) => ({
            field: formatIssueField(issue.path),
            message: issue.message,
          })),
        },
      })
    }
    const changes = parsed.data.changes

    // Dry-run: fetch the current row, merge the proposed changes, return the
    // merged preview. No DB write.
    if (ctx.dryRun) {
      // Literal projection (not a shared const): the schema guard
      // (tests/schema/no-phantom-columns.test.ts) can only verify columns in
      // inline literals. Same column set as the MCP tool; excludes tax/legal
      // profile columns on purpose (see the module doc).
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('company_settings')
        .select('bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, default_our_reference, email, phone, website, invoice_email_texts')
        .eq('company_id', ctx.companyId!)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('companies.settings.update dry-run: settings row not found', {
          companyId: ctx.companyId,
        })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'company_settings' },
        })
      }

      return dryRunPreview(
        toSettingsResource(ctx.companyId!, { ...(current as unknown as SettingsRow), ...changes }),
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    // Literal payload (not the parsed object): the schema guard can then
    // statically verify every column name. Fields the caller did not supply
    // are `undefined` here and are dropped by supabase-js JSON serialization,
    // so only supplied fields are written; explicit null still clears.
    const { data, error } = await ctx.supabase
      .from('company_settings')
      .update({
        bank_name: changes.bank_name,
        clearing_number: changes.clearing_number,
        account_number: changes.account_number,
        bankgiro: changes.bankgiro,
        plusgiro: changes.plusgiro,
        swish: changes.swish,
        iban: changes.iban,
        bic: changes.bic,
        default_our_reference: changes.default_our_reference,
        email: changes.email,
        phone: changes.phone,
        website: changes.website,
        invoice_email_texts: changes.invoice_email_texts,
      })
      .eq('company_id', ctx.companyId!)
      .select('bank_name, clearing_number, account_number, bankgiro, plusgiro, swish, iban, bic, default_our_reference, email, phone, website, invoice_email_texts')
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('companies.settings.update: settings row not found', {
        companyId: ctx.companyId,
      })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'company_settings' },
      })
    }

    return ok(toSettingsResource(ctx.companyId!, data as unknown as SettingsRow), {
      requestId: ctx.requestId,
    })
  },
  { requireIdempotencyKey: true },
)
