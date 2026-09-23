import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { PartyRegistryLookupQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createScbClient } from '@/lib/parties/scb/client'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { ScbApiError } from '@/lib/parties/scb/transport'
import { displayNameFromRegistry } from '@/lib/parties/registry-name'
import { registryLookupKey, type RegistryLookup } from '@/lib/parties/registry-form-fill'
import { registrySummary } from '@/lib/parties/registry-summary'

/**
 * GET /api/parties/registry?org_number=: what SCB knows about a Swedish
 * legal person, for the customer and supplier forms while the row does not
 * exist yet. Reads only: no party, no facts, no row is written; provenance
 * lands through POST /api/parties/[id]/enrich once the row has a party.
 * Same client and same gates as that route: an environment without SCB
 * credentials answers 503 before anything else so the form can go quiet,
 * and a personnummer (a sole trader's org number) never reaches SCB.
 * Writers only: the lookup exists to create a row, which viewers cannot.
 */
export const GET = withRouteContext(
  'parties.registry.lookup',
  async (request, { log, requestId }) => {
    if (!isScbConfigured()) return errorResponseFromCode('SCB_NOT_CONFIGURED', log, { requestId })
    const validated = validateQuery(request, PartyRegistryLookupQuerySchema, { log, operation: 'parties.registry.lookup' })
    if (!validated.success) return validated.response

    const orgNumber = registryLookupKey(validated.data.org_number)
    if (!orgNumber) return errorResponseFromCode('SCB_NOT_A_LEGAL_PERSON', log, { requestId })

    let lookup
    try {
      lookup = await createScbClient(scbConfigFromEnv()).lookupByOrgNumber(orgNumber)
    } catch (err) {
      log.warn('scb lookup failed', { orgNumber, status: err instanceof ScbApiError ? err.status : undefined, message: err instanceof Error ? err.message : String(err) })
      return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
    }

    const registry = lookup.found ? registrySummary(lookup.facts.map((f) => ({ ...f, source: 'registry_scb' as const, fetchedAt: lookup.fetchedAt }))) : null
    if (!registry) {
      const missing: RegistryLookup = { found: false, orgNumber }
      return NextResponse.json({ data: missing })
    }
    const data: RegistryLookup = {
      found: true,
      orgNumber,
      name: registry.legal_name ? displayNameFromRegistry(registry.legal_name) : '',
      registry,
    }
    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
