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
  async (_request, { supabase, companyId, user }, { params }) => {
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

    // A generated-but-unfiled AGI now carries stale amounts — delete it so the
    // stale XML can't be exported. Regeneration on the forward path recreates
    // it. A rejected declaration is kept: it documents the rejection, and
    // regeneration upserts over it.
    if (agiDeclaration && ['generated', 'exported'].includes(agiDeclaration.status)) {
      await supabase.from('agi_declarations').delete().eq('id', agiDeclaration.id)
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
      .select()
      .single()

    if (error || !updatedRun) {
      return NextResponse.json({ error: 'Kunde inte återkalla godkännandet' }, { status: 500 })
    }

    await eventBus.emit({
      type: 'salary_run.approval_reverted',
      payload: { salaryRunId: id, revertedBy: user.id, userId: user.id, companyId },
    })

    return NextResponse.json({ data: updatedRun })
  },
  { requireWrite: true },
)
