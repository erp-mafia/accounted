import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { SkattekontoFileExecuteSchema } from '@/lib/api/schemas'
import { recordSkattekontoFileImport } from '@/lib/import/skattekonto-file/import-file'
import { sessionFailureResponse } from '@/lib/operations/session'

/**
 * POST /api/import/skattekonto-file/execute
 *
 * Executes the import of confirmed skattekonto statement rows into
 * skattekonto_transactions. The service recomputes dedup keys and
 * re-partitions server-side (never trusts client-side duplicate indexes),
 * records the import in skattekonto_file_imports, and counts residual
 * unique-constraint conflicts as duplicates rather than failures. Shared with
 * the v1 operation imports.skattekonto-file (lib/import/skattekonto-file/import-file.ts).
 */
export const POST = withRouteContext(
  'skattekonto_file.execute',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx

    const validation = await validateBody(request, SkattekontoFileExecuteSchema)
    if (!validation.success) return validation.response
    const { rows, filename, file_hash, variant, closing_saldo } = validation.data

    const opLog = log.child({ filename, fileHash: file_hash, rowCount: rows.length })

    const outcome = await recordSkattekontoFileImport(
      { supabase, companyId: companyId!, userId: user.id, log: opLog },
      { rows, filename, file_hash, variant, closing_saldo },
    )
    if (!outcome.ok) return sessionFailureResponse(outcome, opLog, requestId)
    if (outcome.dryRun) throw new Error('unreachable: no dry run on the dashboard')

    return NextResponse.json({ data: outcome.data })
  },
  { requireWrite: true },
)
