import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { eventBus } from '@/lib/events'

ensureInitialized()

/**
 * approved → review (recall approval, unlock the run for recalculation).
 *
 * Approval is an internal control point — nothing legally binding has happened
 * until payment, booking, or AGI filing — so recalling it is allowed as long
 * as the AGI has not reached Skatteverket. Once the AGI is in flight
 * (pending_signature) or filed (submitted/accepted), the period must instead
 * be redone via a correction AGI with the same specifikationsnummer, so this
 * route refuses.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.unapprove',
  async (_request, { supabase, companyId, user, log }, { params }) => {
    const { id } = await params

    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (runError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    if (run.status !== 'approved') {
      return NextResponse.json(
        { error: 'Bara en godkänd lönekörning kan låsas upp. En betald eller bokförd körning korrigeras via korrigeringsflödet.' },
        { status: 400 },
      )
    }

    const { data: agiDeclaration } = await supabase
      .from('agi_declarations')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('salary_run_id', id)
      .single()

    if (
      run.agi_submitted_at ||
      ['pending_signature', 'submitted', 'accepted'].includes(agiDeclaration?.status ?? '')
    ) {
      return NextResponse.json(
        { error: 'AGI har redan skickats till Skatteverket för denna period. Ändra genom att lämna in en korrigerad AGI (samma specifikationsnummer) i stället.' },
        { status: 409 },
      )
    }

    // Clear payment-file tracking too: a previously generated file would show
    // as current after re-approval even though the amounts may change. Whether
    // the file already reached the bank is outside the app's knowledge — the
    // UI makes the user confirm that before calling this route.
    const { data: updatedRun, error } = await supabase
      .from('salary_runs')
      .update({
        status: 'review',
        approved_by: null,
        approved_at: null,
        agi_generated_at: null,
        payment_file_format: null,
        payment_file_generated_at: null,
      })
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('status', 'approved')
      // TOCTOU guard: AGI submission is allowed from `approved` (also out of
      // band via MCP / the public API), so a filing may have landed since the
      // read above. Re-assert it hasn't inside the update filter.
      .is('agi_submitted_at', null)
      .select()
      .single()

    if (error || !updatedRun) {
      // Zero rows matched (PGRST116): the run moved on concurrently — marked
      // paid, or the AGI was filed — between the read and this update. Not a
      // server fault; tell the user to reload instead of returning 500.
      if ((error as { code?: string } | null)?.code === 'PGRST116') {
        return NextResponse.json(
          { error: 'Lönekörningens status har ändrats — ladda om sidan och försök igen.' },
          { status: 409 },
        )
      }
      return NextResponse.json({ error: 'Kunde inte återkalla godkännandet' }, { status: 500 })
    }

    // A generated-but-unfiled AGI now carries stale amounts — delete it so the
    // stale XML can't be exported. Deliberately after the status flip: the
    // reverse order could destroy the declaration and then fail the
    // transition, leaving an approved run with its AGI gone. If this delete
    // misses instead, agi_generated_at is already null and regeneration on the
    // forward path upserts over the orphaned row. The status filter makes the
    // delete a no-op if the declaration advanced (e.g. to pending_signature)
    // since the read. A rejected declaration is kept: it documents the
    // rejection.
    const staleAgi =
      agiDeclaration && ['generated', 'exported'].includes(agiDeclaration.status)
        ? agiDeclaration
        : null
    let deletedAgiDeclarationId: string | null = null
    if (staleAgi) {
      const { data: deletedRows, error: deleteError } = await supabase
        .from('agi_declarations')
        .delete()
        .eq('id', staleAgi.id)
        .in('status', ['generated', 'exported'])
        .select('id')
      deletedAgiDeclarationId = deletedRows?.length ? staleAgi.id : null
      if (deleteError) {
        log.warn('stale AGI declaration delete failed', {
          agiDeclarationId: staleAgi.id,
          error: deleteError.message,
        })
      }
    }

    await eventBus.emit({
      type: 'salary_run.approval_reverted',
      payload: {
        salaryRunId: id,
        revertedBy: user.id,
        deletedAgiDeclarationId,
        userId: user.id,
        companyId,
      },
    })

    return NextResponse.json({ data: updatedRun })
  },
  { requireWrite: true },
)
