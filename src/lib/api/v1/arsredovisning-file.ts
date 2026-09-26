/**
 * The v1 file doors for the årsredovisning (PDF and iXBRL), shared by
 * app/api/v1/companies/[companyId]/fiscal-periods/[id]/arsredovisning/{pdf,ixbrl}.
 * The fiscal period comes from the path; the bytes come from
 * lib/bokslut/arsredovisning/file-service.ts, the same service the dashboard
 * downloads use, holding the SIE import read lease for a live draft.
 */
import { z } from 'zod'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { ReportFile } from '@/lib/reports/filing-report-service'

const PeriodId = z.string().uuid()

export async function arsredovisningFileBuild(
  kind: 'pdf' | 'ixbrl',
  ctx: OperationContext,
  query: { version_id?: string; proposed_dividend?: number },
  path: Record<string, string>,
): Promise<OperationOutcome<ReportFile>> {
  const periodId = PeriodId.safeParse(path.id)
  if (!periodId.success) {
    return { ok: false, code: 'VALIDATION_ERROR', details: { field: 'id', message: 'The fiscal period id must be a UUID.' } }
  }
  const service = await import('@/lib/bokslut/arsredovisning/file-service')
  const fileQuery = { fiscal_period_id: periodId.data, ...query }
  return kind === 'pdf'
    ? service.getArsredovisningPdfFile(ctx, fileQuery, { leaseLiveRead: true })
    : service.getArsredovisningIxbrlFile(ctx, fileQuery, { leaseLiveRead: true })
}
