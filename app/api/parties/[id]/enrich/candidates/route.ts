import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { PartySearchRegistryQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createScbClient, type ScbSearchResult } from '@/lib/parties/scb/client'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { ScbApiError } from '@/lib/parties/scb/transport'
import { needsModelReading, planRegistryQueries, type RegistryCandidatesResult } from '@/lib/parties/registry-search'
import { readCounterpartName, aiNameAvailable, type AiNameReading } from '@/lib/parties/ai-name'

/**
 * GET /api/parties/[id]/enrich/candidates?q=: SCB companies whose name
 * matches, for the picker shown when a party has no org number. Without q
 * the server plans the search itself from the party's name and voucher
 * texts: the Swedish legal person named in the text first, the cleaned head
 * last, and no SCB call at all when the text names a foreign company, which
 * the register cannot hold. Never chooses; the user does, and the choice
 * lands through POST .../enrich.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'parties.enrich.candidates',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
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

    const explicit = validated.data.q?.trim()
    let queries: string[]
    let foreign: RegistryCandidatesResult['foreign'] = null
    let aiRead: RegistryCandidatesResult['aiRead'] = null
    if (explicit) {
      queries = [explicit]
    } else {
      const { data: facts, error: factsError } = await supabase
        .from('party_facts')
        .select('field, value')
        .eq('company_id', companyId)
        .eq('party_id', id)
        .in('field', ['voucher_text', 'ai_name'])
        .is('superseded_at', null)
      if (factsError) throw new Error(`party_facts lookup failed: ${factsError.message}`)
      const rows = (facts ?? []) as Array<{ field: string; value: unknown }>
      const voucherTexts = rows
        .filter((f) => f.field === 'voucher_text')
        .flatMap((f) => (Array.isArray(f.value) ? f.value.filter((v): v is string => typeof v === 'string') : []))
      let plan = planRegistryQueries({ legalName: p.legal_name, displayName: p.display_name, voucherTexts })

      // A bank memo the rules could not anchor: the model reads it once,
      // the reading is kept as a fact with source 'model', and the search
      // runs on the reading. A rebuilt queue does not repeat the call.
      if (needsModelReading(plan) && aiNameAvailable()) {
        const cached = rows.find((f) => f.field === 'ai_name')?.value as Partial<AiNameReading> | undefined
        let reading: AiNameReading | null =
          cached && typeof cached === 'object' && 'name' in cached
            ? { name: cached.name ?? null, country: cached.country ?? null, vatNumber: cached.vatNumber ?? null, confidence: cached.confidence ?? 'low', model: cached.model ?? '' }
            : null
        if (!reading) {
          reading = await readCounterpartName([p.display_name, ...voucherTexts])
          if (reading) {
            const { error: recordError } = await supabase.rpc('record_party_facts', {
              p_company_id: companyId,
              p_user_id: user.id,
              p_party_id: id,
              p_source: 'model',
              p_facts: [{ field: 'ai_name', value: reading, reference: { model: reading.model, texts: voucherTexts.length } }],
              p_fetched_at: new Date().toISOString(),
            })
            if (recordError) log.warn('record_party_facts (model reading) failed', { partyId: id, message: recordError.message })
          }
        }
        if (reading?.name) {
          aiRead = { name: reading.name, country: reading.country }
          const readPlan = planRegistryQueries({ legalName: reading.name, displayName: p.display_name, voucherTexts: [] })
          plan =
            reading.country && reading.country !== 'SE' && !readPlan.candidates.some((c) => c.source === 'legal_form' && !c.foreign)
              ? { queries: [], foreign: { name: reading.name, country: reading.country }, candidates: readPlan.candidates }
              : readPlan
        }
      }
      queries = plan.queries
      foreign = plan.foreign
    }

    if (queries.length === 0) {
      const empty: RegistryCandidatesResult = {
        query: foreign?.name ?? p.display_name,
        mode: 'starts_with',
        total: 0,
        truncated: false,
        candidates: [],
        queries: [],
        foreign,
        aiRead,
      }
      return NextResponse.json({ data: empty })
    }

    try {
      const client = createScbClient(scbConfigFromEnv())
      let last: ScbSearchResult | null = null
      for (const q of queries) {
        last = await client.searchByName(q)
        if (last.candidates.length > 0 || last.truncated) break
      }
      const result: RegistryCandidatesResult = { ...(last as ScbSearchResult), queries, foreign, aiRead }
      return NextResponse.json({ data: result })
    } catch (err) {
      log.warn('scb search failed', { partyId: id, status: err instanceof ScbApiError ? err.status : undefined, message: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
    }
  },
)
