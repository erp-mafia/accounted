/**
 * /api/v1/companies/{companyId}/customers/{id}: customer detail + writes.
 *
 * GET   : full record. ?expand=invoices embeds open invoices, each with the
 *          status the invoice endpoints report (effectiveInvoiceStatus).
 * PATCH : partial update. Idempotent (mandatory Idempotency-Key).
 *          Dry-runnable. VIES re-validation on commit if vat_number changes.
 *          Setting archived_at: null un-archives the customer.
 * DELETE: soft-delete (sets archived_at). Idempotent. Dry-runnable. 204
 *          on success. REFUSES to archive while the customer still owes on
 *          an invoice (filterOwedInvoices: a credit note or a fully
 *          credited original owes nothing): preserves the canonical buyer
 *          name/address that ML 17 kap 24§ requires the invoice to carry.
 *          Issue a kreditfaktura first if needed.
 */

import { z } from 'zod'
import { noContent, ok } from '@/lib/api/v1/response'
import { dryRunPreview } from '@/lib/api/v1/dry-run'
import { parseExpand, expandQueryShape } from '@/lib/api/v1/expand'
import { PartyForApiSchema, expandParty } from '@/lib/parties/party-api'
import { registerEndpoint, dataEnvelope, NoBodyResponse } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { readV1JsonBody } from '@/lib/api/v1/body'
import { UpdateCustomerSchema } from '@/lib/api/schemas'
import {
  CUSTOMER_RECORD_COLUMNS,
  CustomerRecordSchema,
  customerRecordOutcome,
  readCustomerRecord,
} from '@/lib/customers/customer-record'
import { updateCustomer } from '@/lib/customers/customer-commands'
import { maskCustomerRow } from '@/lib/customers/protect-personal-number'
import { effectiveInvoiceStatus, filterOwedInvoices, type OverdueInvoiceInput } from '@/lib/invoices/overdue'
import { v1OutcomeResponse } from '@/lib/operations/v1'
import { withAmountToPay, type AmountToPayRow } from '@/lib/invoices/amount-to-pay-fields'
import { todayIsoStockholm } from '@/lib/dates/iso'

// v1-only extension: allow PATCH to set archived_at back to null to
// un-archive a customer. Restricted to literal `null` so the caller can't
// fake an archive timestamp.
const V1PatchCustomerSchema = UpdateCustomerSchema.extend({
  archived_at: z.null().optional(),
})

// The record itself (and its select) is defined once in
// lib/customers/customer-record.ts, shared with the MCP drill-in
// gnubok_get_customer; only the expansions are v1's own.
const CustomerDetail = CustomerRecordSchema.extend({
  /** Present with ?expand=party: identity, the SCB register summary and what the ledger has seen. */
  party: PartyForApiSchema.nullable().optional(),
})

const ALLOWED_EXPAND = ['invoices', 'party'] as const

const CUSTOMER_DETAIL_COLUMNS = CUSTOMER_RECORD_COLUMNS

// ore_rounding, deduction_total and credited_invoice_id are read for
// amount_to_pay (crm#1568) and not returned, as on the invoice list.
const OPEN_INVOICE_COLUMNS =
  'id, invoice_number, invoice_date, due_date, status, currency, total, remaining_amount, ore_rounding, deduction_total, credited_invoice_id'

registerEndpoint({
  operation: 'customers.get',
  method: 'GET',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Retrieve a single customer by id.',
  description:
    'Returns the full customer record. Pass ?expand=invoices to embed any open invoices (sent / partially_paid / overdue) for the customer in the same response; each carries the status the invoice endpoints report, so a sent invoice past its due_date with remaining_amount > 0 reads overdue. Pass ?expand=party to embed the party (motpart) behind the customer: legal name, org and VAT number, country, the SCB company-register summary and what the ledger has seen for it. Private individuals have no party.',
  useWhen:
    'You need the full customer record: address, payment terms, VAT validation status, contact details: before invoicing or syncing to another system.',
  doNotUseFor:
    'Listing customers (use the list endpoint). Looking up arbitrary supplier or employee records (different resources).',
  pitfalls: [
    'archived_at is non-null when the customer has been soft-deleted; the customer is still queryable by id but excluded from default lists.',
    'vat_number_validated reflects the last successful VIES check; it can become stale if the EU registry revokes a number.',
    'personal_number is always returned in the masked form ********-1234; the stored value is encrypted and never leaves the API.',
  ],
  example: {
    response: {
      data: {
        id: 'a8f1…',
        name: 'Acme AB',
        customer_type: 'business',
        email: 'finance@acme.example',
        org_number: '556677-8899',
        vat_number: 'SE556677889901',
        vat_number_validated: true,
        country: 'SE',
        default_payment_terms: 30,
        archived_at: null,
        created_at: '2025-04-12T08:30:00Z',
        updated_at: '2026-04-30T11:22:09Z',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { query: z.object(expandQueryShape(ALLOWED_EXPAND)) },
  response: { success: dataEnvelope(CustomerDetail) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.get',
  async (request, ctx, params) => {
    const { id } = await params.params

    // Defense in depth: validate the path id is a UUID before touching the
    // database or reflecting it in error details.
    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

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

    // Masked on read: personal_number is the display form, never the ciphertext.
    const { data: customer, error } = await readCustomerRecord(ctx.supabase, ctx.companyId!, customerId)

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!customer) {
      // Generic NOT_FOUND: do not echo the queried id back to the caller
      // (enumeration hardening).
      ctx.log.warn('customers.get: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    // Open invoices expansion: separate query to avoid bloating the
    // customer base shape with a join that's only sometimes needed.
    let invoices: unknown[] | undefined
    const partialExpansions: string[] = []
    if (expand.has('invoices')) {
      const { data: invs, error: invErr } = await filterOwedInvoices(
        ctx.supabase
          .from('invoices')
          .select(OPEN_INVOICE_COLUMNS)
          .eq('company_id', ctx.companyId!)
          .eq('customer_id', customerId),
      ).order('invoice_date', { ascending: false })

      if (invErr) {
        // Soft-degrade: log but still return the customer. The agent gets
        // the primary resource; ?expand is a hint, not a guarantee.
        // `meta.partial_expansions` signals which expansions failed so
        // careful callers can retry or fall back without parsing the body.
        const errMsg = (invErr as { code?: string; message?: string }).message ?? 'unknown'
        const errCode = (invErr as { code?: string }).code ?? 'unknown'
        // Postgres error class 42 = "Syntax Error or Access Rule Violation"
        // (includes 42501 insufficient_privilege). These indicate a real
        // misconfiguration: a revoked grant or an incorrect RLS policy:
        // and should be logged at error level, which is what the observability
        // sink (lib/observability) forwards, rather than blending
        // into informational warn logs. Other classes are typically
        // transient (network, timeout) and stay at warn.
        const isPermissionError = typeof errCode === 'string' && errCode.startsWith('42')
        if (isPermissionError) {
          ctx.log.error('customers.get: open-invoices expansion permission denied', new Error(errMsg), {
            errCode,
            customerId,
          })
        } else {
          ctx.log.warn('customers.get: open-invoices expansion failed', { errCode, errMsg })
        }
        invoices = []
        partialExpansions.push('invoices')
      } else {
        // What each open invoice asks for, as the invoice endpoints report it
        // (crm#1568). The company setting is read only for a row without its
        // own choice; a failed read degrades the expansion like a failed
        // query, never a figure computed on a guessed setting.
        try {
          const priced = await withAmountToPay(
            ctx.supabase,
            ctx.companyId!,
            (invs ?? []) as unknown as Array<AmountToPayRow & OverdueInvoiceInput & Record<string, unknown>>,
          )
          // The status is the one the invoice endpoints report too
          // (lib/invoices/overdue.ts): overdue follows the due date and the
          // open remainder, never the stored status alone.
          const today = todayIsoStockholm()
          invoices = priced.map((row) => {
            const { ore_rounding: _oreRounding, deduction_total: _deduction, credited_invoice_id: _credited, ...invoice } = row
            return { ...invoice, status: effectiveInvoiceStatus(row, today) }
          })
        } catch (err) {
          ctx.log.warn('customers.get: open-invoices amount to pay failed', {
            errMsg: err instanceof Error ? err.message : String(err),
          })
          invoices = []
          partialExpansions.push('invoices')
        }
      }
    }

    const party = expand.has('party') ? await expandParty(ctx.supabase, ctx.companyId!, customer.party_id) : undefined

    return ok(
      { ...(party !== undefined ? { party } : {}), ...customer, ...(invoices !== undefined ? { invoices } : {}) },
      {
        requestId: ctx.requestId,
        partialExpansions: partialExpansions.length > 0 ? partialExpansions : undefined,
      },
    )
  },
)

// ──────────────────────────────────────────────────────────────────
// PATCH: partial update
// ──────────────────────────────────────────────────────────────────

registerEndpoint({
  operation: 'customers.update',
  method: 'PATCH',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Partially update a customer.',
  description:
    'Patches the customer with the supplied fields. All fields optional. Idempotent (mandatory Idempotency-Key). Dry-runnable: the dry run answers the would-be record with `changes` (each changed field, from and to). When vat_number changes on an eu_business customer, VIES re-validation runs on commit (best-effort).',
  useWhen:
    'You need to change a customer\'s contact details, payment terms, address, or VAT registration. Use dry-run first to confirm the merged record before committing.',
  doNotUseFor:
    'Archiving a customer (use DELETE: sets archived_at). Replacing the entire record (no PUT verb is exposed; PATCH is partial).',
  pitfalls: [
    'Idempotency-Key is mandatory; calls without it return 400.',
    'An empty body returns 400 VALIDATION_ERROR; an unknown id returns 404 CUSTOMER_NOT_FOUND.',
    'org_number uniqueness is enforced at DB level: 23505 → 409 CUSTOMER_DUPLICATE_ORG_NUMBER.',
    'VIES re-validation is best-effort and runs only on commit. A VIES timeout does not fail the update.',
    'personal_number: a plaintext value is stored encrypted (individual customers only); the masked form a read returned (********-1234) means "leave unchanged" and is never stored; null clears it. Changing customer_type away from individual clears any stored personal_number.',
    'An org_number shaped like a Swedish personnummer is accepted on customer_type=swedish_business: an enskild firma has no separate org number, so it is the firm\'s identifier, and the list endpoint masks it. It is rejected for eu_business and non_eu_business (400 CUSTOMER_ORG_NUMBER_IS_PERSONAL). On an individual it is the personnummer in the wrong field: it is stored encrypted as personal_number and org_number is cleared; next to a different personal_number in the same body it is 400 CUSTOMER_PERSONAL_NUMBER_CONFLICT.',
    'An individual has no org number: any other non-empty org_number on customer_type=individual, including one the row would keep through a type change, is 400 CUSTOMER_ORG_NUMBER_ON_INDIVIDUAL. Send org_number "" with the type change to clear it.',
  ],
  example: {
    request: { default_payment_terms: 14, notes: 'New payment terms agreed 2026-05-12.' },
    response: {
      data: {
        id: '0e9c…',
        name: 'Acme AB',
        default_payment_terms: 14,
        notes: 'New payment terms agreed 2026-05-12.',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'customers:write',
  risk: 'low',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  request: { body: UpdateCustomerSchema },
  response: { success: dataEnvelope(CustomerDetail) },
})

export const PATCH = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.update',
  async (request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }

    const rawBodyResult = await readV1JsonBody(request, ctx)
    if (!rawBodyResult.ok) return rawBodyResult.response

    const parsed = V1PatchCustomerSchema.safeParse(rawBodyResult.body)
    if (!parsed.success) return v1ValidationError(ctx, parsed.error)

    // One update and one rule set with the dashboard and the agent's approval
    // (lib/customers/customer-commands.ts). The dry run answers the would-be
    // record and `changes`; VIES runs only on the real update.
    const outcome = await updateCustomer(
      { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
      idParse.data,
      parsed.data,
      { dryRun: ctx.dryRun },
    )
    return v1OutcomeResponse(customerRecordOutcome(outcome), ctx)
  },
  { requireIdempotencyKey: true },
)


registerEndpoint({
  operation: 'customers.delete',
  method: 'DELETE',
  path: '/api/v1/companies/:companyId/customers/:id',
  summary: 'Archive a customer (soft-delete).',
  description:
    'Sets archived_at on the customer; the record is preserved (invoices and audit history remain intact) but excluded from default list responses. To un-archive, PATCH archived_at back to null. Idempotent: archiving an already-archived customer is a no-op. Dry-runnable.',
  useWhen:
    'You want to remove a customer from active rosters without losing their history. Idempotent: re-archiving is safe.',
  doNotUseFor:
    'Permanently deleting a customer with all history: the public API does not expose hard-delete. GDPR erasure requests go through a dedicated workflow.',
  pitfalls: [
    'Idempotency-Key is mandatory.',
    'A customer who still owes on an invoice (sent / partially_paid / overdue with an amount remaining) cannot be archived: returns 409 CUSTOMER_HAS_INVOICES. Credit notes and fully credited invoices do not count. Issue a kreditfaktura first if you need to close the relationship cleanly. This protects ML 17 kap 24§: the customer record is the canonical source of buyer name/address for invoice reissuance.',
    '204 No Content is returned on success: there is no response body to parse.',
  ],
  example: {
    response: { data: null, meta: { request_id: 'req_…', api_version: '2026-05-12' } },
  },
  scope: 'customers:write',
  risk: 'medium',
  idempotent: true,
  reversible: true,
  dryRunSupported: true,
  response: { success: NoBodyResponse },
})

export const DELETE = withApiV1<{ params: Promise<{ companyId: string; id: string }> }>(
  'customers.delete',
  async (_request, ctx, params) => {
    const { id } = await params.params

    const idParse = z.string().uuid().safeParse(id)
    if (!idParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'id', message: 'Customer id must be a UUID.' },
      })
    }
    const customerId = idParse.data

    // Pre-flight: check for open invoices BEFORE archiving. Preserves the
    // canonical buyer record per ML 17 kap 24§: an open invoice points at
    // this customer for its statutory name/address fields. Open is what the
    // customer still owes (filterOwedInvoices), the same rows ?expand=invoices
    // lists: an issued credit note keeps status 'sent' but owes nothing, and
    // the original it fully credits is 'credited' (PH 226).
    const { count: openInvoiceCount, error: openErr } = await filterOwedInvoices(
      ctx.supabase
        .from('invoices')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', ctx.companyId!)
        .eq('customer_id', customerId),
    )

    if (openErr) {
      return v1ErrorResponse(openErr, ctx.log, { requestId: ctx.requestId })
    }
    if ((openInvoiceCount ?? 0) > 0) {
      return v1ErrorResponseFromCode('CUSTOMER_HAS_INVOICES', ctx.log, {
        requestId: ctx.requestId,
        details: { open_invoice_count: openInvoiceCount },
      })
    }

    // Dry-run: confirm the customer exists. No state change.
    if (ctx.dryRun) {
      const { data: current, error: fetchErr } = await ctx.supabase
        .from('customers')
        .select(CUSTOMER_DETAIL_COLUMNS)
        .eq('company_id', ctx.companyId!)
        .eq('id', customerId)
        .maybeSingle()

      if (fetchErr) {
        return v1ErrorResponse(fetchErr, ctx.log, { requestId: ctx.requestId })
      }
      if (!current) {
        ctx.log.warn('customers.delete dry-run: not found', { customerId, companyId: ctx.companyId })
        return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
          requestId: ctx.requestId,
          details: { resource: 'customer' },
        })
      }

      return dryRunPreview(
        maskCustomerRow({ ...(current as Record<string, unknown> & { personal_number?: string | null }), archived_at: new Date().toISOString() }),
        { requestId: ctx.requestId, log: ctx.log },
      )
    }

    const { data, error } = await ctx.supabase
      .from('customers')
      .update({ archived_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId!)
      .eq('id', customerId)
      .select('id')
      .maybeSingle()

    if (error) {
      return v1ErrorResponse(error, ctx.log, { requestId: ctx.requestId })
    }
    if (!data) {
      ctx.log.warn('customers.delete: not found', { customerId, companyId: ctx.companyId })
      return v1ErrorResponseFromCode('NOT_FOUND', ctx.log, {
        requestId: ctx.requestId,
        details: { resource: 'customer' },
      })
    }

    return noContent({ requestId: ctx.requestId })
  },
  { requireIdempotencyKey: true },
)
