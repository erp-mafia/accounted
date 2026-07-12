import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { eventBus } from '@/lib/events'

ensureInitialized()

/**
 * Submit AGI to Skatteverket via the extension API.
 *
 * This route orchestrates the AGI submission flow:
 * 1. Validates the salary run is in a submittable state
 * 2. Ensures AGI has been generated (in agi_declarations table)
 * 3. Calls the Skatteverket extension to save draft + lock for signing
 * 4. Returns the signeringslänk for BankID signing
 *
 * The user then signs on Skatteverket's site (Mina Sidor). The frontend
 * polls /api/extensions/ext/skatteverket/agi/kvittenser to detect completion.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'salary.run.agi.submit',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log } = ctx

    // Load salary run
    const { data: run, error: runError } = await supabase
      .from('salary_runs')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (runError || !run) {
      return NextResponse.json({ error: 'Lönekörning hittades inte' }, { status: 404 })
    }

    if (!['review', 'approved', 'paid', 'booked'].includes(run.status)) {
      return NextResponse.json(
        { error: 'AGI kan bara skickas till Skatteverket efter granskning' },
        { status: 400 }
      )
    }

    // Ensure AGI has been generated
    const { data: agiDeclaration } = await supabase
      .from('agi_declarations')
      .select('id, status')
      .eq('company_id', companyId)
      .eq('salary_run_id', id)
      .single()

    if (!agiDeclaration) {
      return NextResponse.json(
        { error: 'AGI har inte genererats ännu. Generera AGI XML först.' },
        { status: 400 }
      )
    }

    if (agiDeclaration.status === 'submitted' || agiDeclaration.status === 'accepted') {
      return NextResponse.json(
        { error: 'AGI har redan skickats till Skatteverket för denna period' },
        { status: 409 }
      )
    }

    // The actual SKV interaction lives in the Skatteverket extension. This
    // route is a thin orchestrator: it forwards the salary_run_id to the
    // extension's /agi/submit endpoint (which posts the stored XML underlag),
    // then records that the AGI submission process has started.
    //
    // The frontend (AGIPanel) handles the rest of the flow:
    //   1. POST /api/extensions/ext/skatteverket/agi/submit         { salaryRunId }
    //      → returns { inlamningId }
    //   2. GET  /api/extensions/ext/skatteverket/agi/kontrollresultat?inlamningId=...
    //      → poll until status != PROCESSING
    //   3. POST /api/extensions/ext/skatteverket/agi/spara           { inlamningId }
    //   4. POST /api/extensions/ext/skatteverket/agi/granskningsunderlag?arbetsgivare&period
    //      → returns { link } (Mina Sidor BankID signing)
    //   5. GET  /api/extensions/ext/skatteverket/agi/kvittenser?arbetsgivare&period

    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

    try {
      const submitResponse = await fetch(
        `${appUrl}/api/extensions/ext/skatteverket/agi/submit`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Cookie': request.headers.get('Cookie') || '',
          },
          body: JSON.stringify({ salaryRunId: id }),
        }
      )

      if (!submitResponse.ok) {
        const errorData = await submitResponse.json().catch(() => ({ error: 'Okänt fel' }))
        return NextResponse.json(
          { error: errorData.error || `Kunde inte skicka AGI-underlag (${submitResponse.status})` },
          { status: submitResponse.status }
        )
      }

      const submitData = await submitResponse.json()

      // Don't stamp salary_runs.agi_submitted_at here. The underlag has only
      // been ingested; the user still has to pass kontrollresultat, save,
      // produce a granskningsunderlag, and sign with BankID before the AGI is
      // actually filed. Recording the submission time at ingest would make the
      // audit trail lie about when filing completed.
      //
      // The real timestamp is set by the kvittenser handler in the extension
      // (extensions/general/skatteverket/index.ts /agi/kvittenser route) when
      // it observes a uuidKvittens for the period, mirroring SKV's signeradTid.

      await eventBus.emit({
        type: 'agi.submitted',
        payload: {
          salaryRunId: id,
          periodYear: run.period_year,
          periodMonth: run.period_month,
          userId: user.id,
          companyId,
        },
      })

      return NextResponse.json({
        data: {
          ...submitData.data,
          salaryRunId: id,
          periodYear: run.period_year,
          periodMonth: run.period_month,
          message: 'AGI-underlag inläst hos Skatteverket. Skapa granskningsunderlag och signera med BankID i Mina Sidor.',
        },
      })
    } catch (err) {
      log.error('[salary/agi/submit] Error', err as Error)
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Kunde inte skicka AGI till Skatteverket' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true },
)
