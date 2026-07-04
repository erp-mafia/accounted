/**
 * GET /api/v1/companies/{companyId}/reports/supplier-ledger
 *
 * Accounts payable ledger (leverantörsreskontra): unpaid supplier
 * invoices grouped by supplier with aging buckets.
 */

import { z } from 'zod'
import { ok } from '@/lib/api/v1/response'
import { registerEndpoint, dataEnvelope } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import { safeGenerate } from '@/lib/api/v1/report-period'
import { generateSupplierLedger } from '@/lib/reports/supplier-ledger'

registerEndpoint({
  operation: 'reports.supplier-ledger',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/supplier-ledger',
  summary: 'Supplier ledger: unpaid supplier invoices with aging.',
  description:
    'Returns the supplier-payable ledger as of `as_of_date` (defaults to today). Each supplier entry includes outstanding invoices grouped into aging buckets. Reconciles against BAS 2440.',
  useWhen:
    'AP workflow dashboards, due-date prioritisation, reconciliation against the 2440 trial-balance figure.',
  doNotUseFor:
    'Listing all supplier invoices regardless of status (use /supplier-invoices). Initiating payment (the v1 surface does not expose payment files yet).',
  pitfalls: [
    '`as_of_date` is optional; format `YYYY-MM-DD`. Defaults to today (UTC).',
    'Only invoices with outstanding `remaining_amount > 0` appear. Credited and fully-paid invoices are excluded.',
  ],
  example: {
    response: {
      data: { as_of_date: '2026-05-31', suppliers: [], totals: {} },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: dataEnvelope(z.unknown()) },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.supplier-ledger',
  async (request, ctx) => {
    const url = new URL(request.url)
    const asOfDate = url.searchParams.get('as_of_date') || undefined
    if (asOfDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'as_of_date', message: 'Expected YYYY-MM-DD.' },
        })
      }
      // Calendar validity: regex alone accepts 2026-13-45.
      const probe = new Date(`${asOfDate}T00:00:00Z`)
      if (Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== asOfDate) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: { field: 'as_of_date', message: 'Not a valid calendar date.' },
        })
      }
      // Sanity range: year 2000 → current+1 (see ar-ledger comment).
      const year = probe.getUTCFullYear()
      const maxYear = new Date().getUTCFullYear() + 1
      if (year < 2000 || year > maxYear) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'as_of_date',
            message: `Year out of supported range. Accepted: 2000 to ${maxYear}.`,
          },
        })
      }
    }

    const gen = await safeGenerate(
      () => generateSupplierLedger(ctx.supabase, ctx.companyId!, asOfDate),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'supplier-ledger' },
    )
    if (!gen.ok) return gen.response

    return ok(gen.result, { requestId: ctx.requestId })
  },
)
