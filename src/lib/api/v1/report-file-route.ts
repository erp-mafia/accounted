/**
 * v1 door for a report FILE (SRU zip, SKV CSV, eSKD XML): the bytes the
 * dashboard download serves, streamed with Content-Disposition: attachment,
 * like GET /reports/balance-sheet/pdf. Files are v1-only: an MCP read answers
 * the JSON and names this path.
 *
 * The rules and the bytes come from a lib service returning
 * OperationOutcome<ReportFile> (lib/reports/filing-report-service.ts), the
 * same one the dashboard route uses, so the two downloads are identical.
 * Registers the endpoint for /api/v1/openapi.json. An operation id starting
 * with "reports." holds the SIE import lease (withSIEExternalReport), as the
 * dashboard's requireCompleteLedger does: no file escapes while an import is
 * half done.
 */
import { z } from 'zod'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponse, v1ErrorResponseFromCode, v1ValidationError } from '@/lib/api/v1/errors'
import { contentDisposition } from '@/lib/api/content-disposition'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { ReportFile } from '@/lib/reports/filing-report-service'

export interface ReportFileRouteSpec<Q extends z.ZodTypeAny> {
  operation: string
  path: string
  summary: string
  description: string
  useWhen: string
  doNotUseFor: string
  pitfalls: string[]
  contentType: string
  errorCodes?: string[]
  query: Q
  build: (ctx: OperationContext, query: z.infer<Q>) => Promise<OperationOutcome<ReportFile>>
}

export function v1ReportFileHandler<Q extends z.ZodTypeAny>(spec: ReportFileRouteSpec<Q>) {
  registerEndpoint({
    operation: spec.operation,
    method: 'GET',
    path: spec.path,
    summary: spec.summary,
    description: spec.description,
    useWhen: spec.useWhen,
    doNotUseFor: spec.doNotUseFor,
    pitfalls: spec.pitfalls,
    example: { response: { _note: `Returns ${spec.contentType} as a binary download.` } },
    scope: 'reports:read',
    risk: 'low',
    idempotent: true,
    reversible: false,
    dryRunSupported: false,
    request: { query: spec.query },
    response: {
      success: z.unknown(), // Marker: the success body is binary, see contentType.
      contentType: spec.contentType,
      errorCodes: spec.errorCodes,
    },
  })

  return withApiV1<{ params: Promise<{ companyId: string }> }>(
    spec.operation,
    async (request, ctx) => {
      const raw = Object.fromEntries(new URL(request.url).searchParams.entries())
      const parsed = spec.query.safeParse(raw)
      if (!parsed.success) return v1ValidationError(ctx, parsed.error)

      const outcome = await spec.build(
        { supabase: ctx.supabase, companyId: ctx.companyId!, userId: ctx.userId, log: ctx.log },
        parsed.data,
      )
      if (!outcome.ok) {
        if (outcome.error) return v1ErrorResponse(outcome.error, ctx.log, { requestId: ctx.requestId })
        return v1ErrorResponseFromCode(outcome.code, ctx.log, {
          requestId: ctx.requestId,
          details: outcome.messageSv ? { ...(outcome.details ?? {}), reason: outcome.messageSv } : outcome.details,
        })
      }
      if (outcome.dryRun) {
        return v1ErrorResponseFromCode('INTERNAL_ERROR', ctx.log, { requestId: ctx.requestId })
      }
      const file = outcome.data
      return new Response(new Uint8Array(file.bytes), {
        status: 200,
        headers: {
          'Content-Type': file.contentType,
          'Content-Disposition': contentDisposition('attachment', file.filename),
          'Content-Length': String(file.bytes.byteLength),
          'Cache-Control': 'private, no-store',
          'X-Request-Id': ctx.requestId,
        },
      })
    },
    { requireScope: 'reports:read' },
  )
}
