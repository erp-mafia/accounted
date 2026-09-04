import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { PartySearchRegistryQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createScbClient } from '@/lib/parties/scb/client'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { ScbApiError } from '@/lib/parties/scb/transport'

/**
 * GET /api/parties/[id]/enrich/candidates?q=: SCB companies whose name
 * matches, for the picker shown when a party has no org number. Never
 * chooses; the user does, and the choice lands through POST .../enrich.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.enrich.candidates',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const validated = validateQuery(request, PartySearchRegistryQuerySchema, { log, operation: 'parties.enrich.candidates' })
    if (!validated.success) return validated.response
    if (!isScbConfigured()) return errorResponseFromCode('SCB_NOT_CONFIGURED', log, { requestId })

    const { data: party, error } = await supabase
      .from('parties')
      .select('id, display_name, legal_name')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('merged_into', null)
      .maybeSingle()
    if (error) throw new Error(`parties lookup failed: ${error.message}`)
    if (!party) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const p = party as { id: string; display_name: string; legal_name: string | null }
    const query = validated.data.q?.trim() || p.legal_name || p.display_name

    try {
      const result = await createScbClient(scbConfigFromEnv()).searchByName(query)
      return NextResponse.json({ data: result })
    } catch (err) {
      log.warn('scb search failed', { partyId: id, status: err instanceof ScbApiError ? err.status : undefined, message: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
    }
  },
)
