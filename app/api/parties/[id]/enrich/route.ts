import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { PartyEnrichSchema } from '@/lib/api/schemas'
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
 *
 * Body { orgNumber } is the picker's answer for a party that had none: the
 * choice is recorded as a fact with source 'user' and set on the party
 * before the fetch, so every later fetch is by number. A number already
 * held by another live party is refused (merge them instead).
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.enrich',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    if (!isScbConfigured()) return errorResponseFromCode('SCB_NOT_CONFIGURED', log, { requestId })
    // A body is optional (the plain button sends none); when present it is
    // the picker's answer. Read as text first: fetch sets no content-length.
    let chosen: string | undefined
    const raw = (await request.text()).trim()
    if (raw) {
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: { reason: 'invalid_json' } })
      }
      const validation = PartyEnrichSchema.safeParse(parsed)
      if (!validation.success) return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, details: validation.error.flatten() })
      chosen = validation.data.orgNumber
    }

    const { data: party, error } = await supabase
      .from('parties')
      .select('id, org_number, legal_name, vat_number')
      .eq('company_id', companyId)
      .eq('id', id)
      .is('merged_into', null)
      .maybeSingle()
    if (error) throw new Error(`parties lookup failed: ${error.message}`)
    if (!party) return errorResponseFromCode('NOT_FOUND', log, { requestId })
    const p = party as { id: string; org_number: string | null; legal_name: string | null; vat_number: string | null }

    if (chosen && chosen !== p.org_number) {
      if (!isLegalPersonOrgNumber(chosen)) return errorResponseFromCode('SCB_NOT_A_LEGAL_PERSON', log, { requestId })
      if (p.org_number) return errorResponseFromCode('CONFLICT', log, { requestId, details: { reason: 'party_has_org_number', orgNumber: p.org_number } })
      const { data: holder } = await supabase
        .from('parties')
        .select('id, display_name')
        .eq('company_id', companyId)
        .eq('org_number', chosen)
        .is('merged_into', null)
        .limit(1)
        .maybeSingle()
      if (holder) {
        return errorResponseFromCode('CONFLICT', log, { requestId, details: { reason: 'org_number_taken', partyId: (holder as { id: string }).id, displayName: (holder as { display_name: string }).display_name } })
      }
      const { error: setError } = await supabase.from('parties').update({ org_number: chosen }).eq('company_id', companyId).eq('id', id)
      if (setError) throw new Error(`parties update failed: ${setError.message}`)
      const { error: factError } = await supabase.rpc('record_party_facts', {
        p_company_id: companyId,
        p_user_id: user.id,
        p_party_id: id,
        p_source: 'user',
        p_facts: [{ field: 'org_number', value: chosen, reference: { picked_from: 'scb_search' } }],
        p_fetched_at: new Date().toISOString(),
      })
      if (factError) throw new Error(`record_party_facts failed: ${factError.message}`)
      p.org_number = chosen
    }

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

    // The VAT number has one valid form, so it fills an empty field outright,
    // on the party and on the supplier and customer rows that point at it.
    const vat = lookup.facts.find((f) => f.field === 'vat_number')?.value
    if (typeof vat === 'string' && vat) {
      if (!p.vat_number) await supabase.from('parties').update({ vat_number: vat }).eq('company_id', companyId).eq('id', id)
      await supabase.from('suppliers').update({ vat_number: vat }).eq('company_id', companyId).eq('party_id', id).is('vat_number', null)
      await supabase.from('customers').update({ vat_number: vat }).eq('company_id', companyId).eq('party_id', id).is('vat_number', null)
    }

    const r = (summary ?? {}) as Partial<Record<'inserted' | 'superseded' | 'refreshed', number>>
    return NextResponse.json({
      data: { found: true, orgNumber: p.org_number, inserted: r.inserted ?? 0, superseded: r.superseded ?? 0, refreshed: r.refreshed ?? 0, facts: lookup.facts },
    })
  },
  { requireWrite: true },
)
