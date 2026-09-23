import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { bookkeepingErrorResponse } from '@/lib/bookkeeping/errors'
import { correctSalaryRun } from '@/lib/salary/correct-run'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

const NOT_BOOKED_MESSAGE = 'Kan bara korrigera bokförda lönekörningar'
const PERIOD_CONFLICT_MESSAGE = 'Det finns redan en aktiv lönekörning för denna period. Ta bort den först.'

/**
 * Create a correction for a booked salary run.
 *
 * Per BFL 5 kap 5§ (Rättelse): Corrections must preserve the original.
 * This is implemented as:
 *   1. Reverse (storno) all journal entries from the original run
 *   2. Create a new correction salary run for the same period
 *   3. Mark the original run as 'corrected'
 *
 * The new run starts in 'draft' status so the user can edit and re-calculate.
 * On booking the correction run, new correct entries are created.
 * Both original and correction are visible in the journal per BFL.
 *
 * AGI must be re-generated with same FK570 (correction flag) per agi-filing.md.
 *
 * The orchestration lives in lib/salary/correct-run.ts (shared with the v1
 * verb); this route keeps the legacy `{ error }` messages and status codes.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.correct',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log } = ctx

    const result = await correctSalaryRun(supabase, {
      companyId: companyId!,
      userId: user.id,
      runId: id,
    })

    if (!result.ok) {
      switch (result.code) {
        case 'SALARY_RUN_NOT_FOUND':
        case 'SALARY_RUN_CORRECT_NOT_BOOKED':
          return NextResponse.json({ error: NOT_BOOKED_MESSAGE }, { status: 400 })
        case 'SALARY_RUN_ALREADY_CORRECTED':
          // A run that is already 'corrected' never passed the legacy
          // status='booked' filter; only the insert conflict was a 409.
          if (result.details.reason === 'status_corrected') {
            return NextResponse.json({ error: NOT_BOOKED_MESSAGE }, { status: 400 })
          }
          return NextResponse.json({ error: PERIOD_CONFLICT_MESSAGE }, { status: 409 })
        case 'DB_ERROR':
          if (result.stage === 'load_run') {
            return NextResponse.json({ error: NOT_BOOKED_MESSAGE }, { status: 400 })
          }
          return NextResponse.json({ error: getUserErrorMessage(result.error) }, { status: 500 })
        case 'REVERSAL_FAILED': {
          const typed = bookkeepingErrorResponse(result.error)
          if (typed) return typed
          return NextResponse.json(
            { error: getUserErrorMessage(result.error, { context: 'salary' }) },
            { status: 500 },
          )
        }
      }
    }

    for (const warning of result.warnings) {
      log.warn('salary run correction warning', { salaryRunId: id, message: warning })
    }

    return NextResponse.json({
      data: result.correctionRun,
      message: 'Korrigeringskörning skapad. Originalverifikationer har makulerats (storno). Redigera och beräkna om den nya körningen.',
      reversed_entry_count: result.reversedEntryIds.length,
    }, { status: 201 })
  },
  { requireWrite: true },
)
