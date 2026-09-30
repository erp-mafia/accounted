/**
 * POST /api/dimensions/import-existing: one-shot scan that backfills the
 * dimension_values registry from codes already present on journal lines.
 *
 * Every {sie_dim_no: code} entry found in journal_entry_lines.dimensions
 * that lacks a registry row gets one created with is_active = false and
 * name = code: referential validity holds retroactively without polluting
 * pickers. Dimensions missing from the registry entirely (e.g. a custom dim
 * number written via the v1 API) are created too, so no line code is
 * skipped. Idempotent: re-running creates nothing new.
 *
 * The scan is lib/dimensions/import-existing.ts. Turning dimensions on runs
 * it on every door (lib/company/settings-service.ts); this route runs it
 * again on request.
 *
 * Response: 200 { created: number } (count of dimension_values created).
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { importExistingDimensionCodes } from '@/lib/dimensions/import-existing'
import { sessionFailureResponse } from '@/lib/operations/session'

ensureInitialized()

export const POST = withRouteContext(
  'dimension.import_existing',
  async (_request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const outcome = await importExistingDimensionCodes({ supabase, companyId, log })
    if (!outcome.ok) return sessionFailureResponse(outcome, log, requestId)
    if (outcome.dryRun) return NextResponse.json(outcome.preview)
    return NextResponse.json({ created: outcome.data.created })
  },
  { requireWrite: true },
)
