import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { counterpartySetoffEnabled } from '@/lib/env/counterparty-setoff-switch'
import { loadCounterpartyBalance } from '@/lib/invoices/counterparty-setoff/open-items'

const ParamsSchema = z.object({ id: z.uuid() })

/**
 * GET /api/parties/[id]/open-items: the counterparty as one relation, its open
 * customer invoices (what they owe us), open supplier invoices (what we owe
 * them), the net per currency and its set-offs, with setoff_enabled telling
 * the dossier whether to offer Kvitta. A read of the invoices as they stand,
 * served whatever COUNTERPARTY_SETOFF_ENABLED says.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.open-items.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsed = ParamsSchema.safeParse(await params)
    if (!parsed.success) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const balance = await loadCounterpartyBalance(supabase, companyId, { partyId: parsed.data.id })
    if (!balance) return errorResponseFromCode('SETOFF_PARTY_NOT_FOUND', log, { requestId })
    return NextResponse.json(
      { data: { ...balance, setoff_enabled: counterpartySetoffEnabled() } },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  },
)
