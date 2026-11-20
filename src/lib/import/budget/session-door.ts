/**
 * The dashboard's two budget import doors (app/api/budgets/[id]/import and
 * its /preview): one multipart reader, so the preview the user confirms and
 * the import it confirms read the file and its options the same way. Two
 * routes rather than a ?dry_run flag, because a door's permission is decided
 * by its path (lib/permissions/doors.ts): the preview only reads, the
 * import writes the budget.
 */
import { NextResponse } from 'next/server'
import { isUuid } from '@/lib/invariants/uuid'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { sessionFailureResponse } from '@/lib/operations/session'
import { ImportBudgetOptionsSchema } from '@/lib/budgets/schemas'
import type { OperationContext } from '@/lib/operations/types'
import { importBudgetFile } from './import-budget'

/** multipart: file, and optionally sign (debit_positive | revenue_positive) and replace (true). */
export async function budgetImportDoor(
  request: Request,
  ctx: OperationContext & { requestId?: string },
  budgetId: string,
  dryRun: boolean,
): Promise<NextResponse> {
  if (!isUuid(budgetId)) return errorResponseFromCode('BUDGET_NOT_FOUND', ctx.log, { requestId: ctx.requestId })

  let form: FormData
  try {
    form = await request.formData()
  } catch (error) {
    ctx.log.warn('budget import body is not multipart form data', { error: error instanceof Error ? error.message : String(error) })
    return errorResponseFromCode('BUDGET_IMPORT_UNREADABLE', ctx.log, { requestId: ctx.requestId })
  }
  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'file is required', type: 'validation_error' }, { status: 400 })
  }
  const replace = form.get('replace')
  const options = ImportBudgetOptionsSchema.safeParse({
    sign: form.get('sign') || undefined,
    replace: replace === null ? undefined : replace === 'true',
  })
  if (!options.success) {
    return NextResponse.json(
      { error: 'sign must be debit_positive or revenue_positive', type: 'validation_error' },
      { status: 400 },
    )
  }

  const outcome = await importBudgetFile(
    ctx,
    { budget_id: budgetId, filename: file.name, bytes: await file.arrayBuffer(), ...options.data },
    { dryRun },
  )
  if (!outcome.ok) return sessionFailureResponse(outcome, ctx.log, ctx.requestId)
  return NextResponse.json({ data: outcome.dryRun ? outcome.preview : outcome.data })
}
