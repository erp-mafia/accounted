/**
 * GET /api/v1/companies/{companyId}/reports/sie-export
 *
 * Generates a SIE4 export (text/plain, .se file) for the given fiscal
 * period. Returns the SIE content with Content-Disposition: attachment so
 * agents can save it directly. Mirrors the dashboard generator.
 */

import { z } from 'zod'
import { NextResponse } from 'next/server'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode, v1ErrorResponse } from '@/lib/api/v1/errors'
import { loadPeriodFromQuery, safeGenerate } from '@/lib/api/v1/report-period'
import { generateSIEExport } from '@/lib/reports/sie-export'

registerEndpoint({
  operation: 'reports.sie-export',
  method: 'GET',
  path: '/api/v1/companies/:companyId/reports/sie-export',
  summary: 'SIE4 export (.se file) for a fiscal period.',
  description:
    'Returns the period\'s SIE4 export as text/plain UTF-8. Includes #FNAMN / #ORGNR header, #KONTO chart, #IB/#UB opening + closing balances, #RES result-account totals, and every #VER + #TRANS verifikation in the period. The byte stream matches what the dashboard\'s `/api/reports/sie-export` produces.',
  useWhen:
    'Year-end accountant handoff, migration to another bookkeeping system, audit archival, BFL 7 kap räkenskapsinformation backup.',
  doNotUseFor:
    'JSON drilldown of period entries (use /reports/journal-register). Full archive including documents (use /reports/full-archive — not yet on v1).',
  pitfalls: [
    '`period_id` is required.',
    'The response is text/plain with Content-Disposition: attachment — clients should treat as a binary download. Filename uses the pattern `export_{period_id}.se`.',
    'Encoding is UTF-8 (modern systems accept it; some legacy Swedish bookkeeping software still expects CP437/Latin-1 — convert client-side if needed).',
    'Only `posted` entries are exported; drafts and reversed entries\' originals are included but marked accordingly.',
  ],
  example: {
    response: { _note: 'Returns text/plain SIE4 content as binary download.' },
  },
  scope: 'reports:read',
  risk: 'low',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  response: { success: z.unknown(), contentType: 'text/plain' },
})

export const GET = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'reports.sie-export',
  async (request, ctx) => {
    const period = await loadPeriodFromQuery(request, {
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      requestId: ctx.requestId,
      log: ctx.log,
    })
    if (!period.ok) return period.response

    const excludeClosing = new URL(request.url).searchParams.get('exclude_closing') === 'true'

    const { data: company, error: companyErr } = await ctx.supabase
      .from('company_settings')
      .select('company_name, org_number')
      .eq('company_id', ctx.companyId!)
      .maybeSingle()
    if (companyErr) {
      return v1ErrorResponse(companyErr, ctx.log, { requestId: ctx.requestId })
    }
    if (!company) {
      return v1ErrorResponseFromCode('COMPANY_NOT_FOUND', ctx.log, { requestId: ctx.requestId })
    }

    const gen = await safeGenerate(
      () =>
        generateSIEExport(ctx.supabase, ctx.companyId!, {
          fiscal_period_id: period.period.id,
          company_name: (company as { company_name: string | null }).company_name || 'Unknown',
          org_number: (company as { org_number: string | null }).org_number,
          exclude_year_end_closing: excludeClosing,
        }),
      { log: ctx.log, requestId: ctx.requestId, reportName: 'sie-export' },
    )
    if (!gen.ok) return gen.response

    // OWASP V3.2 / V4 — sanitise period_id before splicing into the
    // Content-Disposition header. period_id is a server-supplied UUID
    // (already constrained by the fiscal_periods row lookup), so this
    // is belt-and-suspenders.
    const safeId = period.period.id.replace(/[^0-9a-fA-F-]/g, '')

    return new NextResponse(gen.result, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Disposition': `attachment; filename="export_${safeId}.se"`,
        'X-Request-Id': ctx.requestId,
      },
    })
  },
)
