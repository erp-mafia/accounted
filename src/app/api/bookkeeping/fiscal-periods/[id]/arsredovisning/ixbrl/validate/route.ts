import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks, type PreflightIssue } from '@/lib/bokslut/ixbrl/validate/rules'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getVersionIxbrlInput } from '@/lib/bokslut/arsredovisning/version-ixbrl'

/**
 * GET /api/bookkeeping/fiscal-periods/:id/arsredovisning/ixbrl/validate
 *
 * Layer-1 validation (local mirror of Bolagsverket kontrollera, GUIDE
 * Appendix E) + a generation dry-run so taxonomy-level problems (unknown
 * concept, context mismatch) surface as issues instead of a 500 in the
 * preview. Layer 3 (the real kontrollera call) lives in the bolagsverket
 * extension and runs in the Skicka in step.
 */
export const GET = withRouteContext(
  'period.arsredovisning_ixbrl_validate',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx
    try {
      const url = new URL(request.url)
      const versionId = url.searchParams.get('version')
      const utdelningRaw = url.searchParams.get('utdelning')
      const proposedDividend = utdelningRaw ? Number(utdelningRaw) : undefined

      const input = versionId
        ? await getVersionIxbrlInput(supabase, companyId, id, versionId)
        : await buildIxbrlInput(supabase, companyId, id, {
            proposedDividend:
              proposedDividend !== undefined && Number.isFinite(proposedDividend)
                ? proposedDividend
                : undefined,
          })
      if (!input) return errorResponseFromCode('NOT_FOUND', log, { requestId })
      const result = runPreflightChecks(input)

      // Generation dry-run: a document that cannot even be generated must
      // block, with the reason in the issue list rather than a raw error.
      const issues: PreflightIssue[] = [...result.issues]
      let generatedBytes = 0
      try {
        const { xhtml } = generateK2IxbrlDocument(input)
        generatedBytes = Buffer.byteLength(xhtml, 'utf8')
        if (generatedBytes >= 5 * 1024 * 1024) {
          issues.push({
            code: '5006',
            severity: 'error',
            message: 'Dokumentet överstiger Bolagsverkets maxstorlek 5 MB.',
          })
        }
      } catch (genErr) {
        issues.push({
          code: 'ACC-GEN',
          severity: 'error',
          message: `iXBRL-dokumentet kunde inte genereras: ${genErr instanceof Error ? getUserErrorMessage(genErr) : 'okänt fel'}`,
        })
      }

      const errors = issues.filter((issue) => issue.severity === 'error')
      return NextResponse.json({
        data: {
          ok: errors.length === 0,
          issues,
          error_count: errors.length,
          warning_count: issues.length - errors.length,
          generated_bytes: generatedBytes,
          entry_point: input.entryPointId,
          period: input.period,
          annual_report_version_id: versionId,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      if (/not found/i.test(message)) {
        return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      }
      return errorResponse(err, log, { requestId })
    }
  },
)
