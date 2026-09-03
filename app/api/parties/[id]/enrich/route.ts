import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createScbClient } from '@/lib/parties/scb/client'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { isLegalPersonOrgNumber } from '@/lib/parties/scb/org-number'
import { ScbApiError } from '@/lib/parties/scb/transport'

/**
 * POST /api/parties/[id]/enrich: fetch the party's registry facts from SCB
 * and record them with provenance (source registry_scb, fetched_at). Legal
 * persons only: a sole trader's org number is a personnummer and stays out
 * of registry lookups in this phase.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.enrich',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    if (!isScbConfigured()) return errorResponseFromCode('SCB_NOT_CONFIGURED', log, { requestId })

    const { data: party, error } = await supabase
      .from('parties')
      .select('id, org_number, legal_name')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('merged_into', null)
      .maybeSingle()
    if (error) throw new Error(`parties lookup failed: ${error.message}`)
    if (!party) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const p = party as { id: string; org_number: string | null; legal_name: string | null }
    if (!isLegalPersonOrgNumber(p.org_number)) return errorResponseFromCode('SCB_NOT_A_LEGAL_PERSON', log, { requestId })

    let lookup
    try {
      lookup = await createScbClient(scbConfigFromEnv()).lookupByOrgNumber(p.org_number!)
    } catch (err) {
      log.warn('scb lookup failed', { partyId: id, status: err instanceof ScbApiError ? err.status : undefined, message: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
    }

    if (!lookup.found) {
      return NextResponse.json({ data: { found: false, orgNumber: p.org_number, inserted: 0, superseded: 0, refreshed: 0 } })
    }

    const { data: summary, error: recordError } = await supabase.rpc('record_party_facts', {
      p_company_id: companyId,
      p_user_id: user.id,
      p_party_id: id,
      p_source: 'registry_scb',
      p_facts: lookup.facts.map((f) => ({ ...f, reference: { ...(f.reference ?? {}), layout: 'Je', pe_org_nr: lookup.peOrgNr } })),
      p_fetched_at: lookup.fetchedAt,
    })
    if (recordError) throw new Error(`record_party_facts failed: ${recordError.message}`)

    // Survivorship (plan section 05): user > registry > document. The
    // registry's legal name replaces one read from documents or none at all,
    // but never one a person entered (a legal_name fact with source 'user').
    const legal = lookup.facts.find((f) => f.field === 'legal_name')?.value
    if (typeof legal === 'string' && legal && legal !== p.legal_name) {
      const { count } = await supabase
        .from('party_facts')
        .select('id', { count: 'exact', head: true })
        .eq('company_id', companyId)
        .eq('party_id', id)
        .eq('field', 'legal_name')
        .eq('source', 'user')
        .is('superseded_at', null)
      if (!count) {
        await supabase.from('parties').update({ legal_name: legal }).eq('company_id', companyId).eq('id', id)
      }
    }

    const r = (summary ?? {}) as Partial<Record<'inserted' | 'superseded' | 'refreshed', number>>
    return NextResponse.json({
      data: { found: true, orgNumber: p.org_number, inserted: r.inserted ?? 0, superseded: r.superseded ?? 0, refreshed: r.refreshed ?? 0, facts: lookup.facts },
    })
  },
  { requireWrite: true },
)
