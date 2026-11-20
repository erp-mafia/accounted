import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateQuery } from '@/lib/api/validate'
import { CompanySearchQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import { createScbClient } from '@/lib/parties/scb/client'
import { isScbConfigured, scbConfigFromEnv } from '@/lib/parties/scb/config'
import { ScbApiError } from '@/lib/parties/scb/transport'
import { COMPANY_SUGGEST_MAX } from '@/lib/company-lookup/types'
import { toCompanySuggestion } from '@/lib/company-lookup/scb-suggestion'
import { offerableSearchHits, ownPersonalNumberHash } from '@/lib/company-lookup/own-firm'

/**
 * GET /api/company/search?q=: companies whose registered name starts with
 * (or, failing that, contains) the query, for the search-as-you-type picker
 * on the onboarding orgnr step. Reads SCB's företagsregister, which is
 * free, so the client may call it per debounced keystroke; the paid TIC
 * lookup runs once, on the pick, exactly as for a typed orgnr.
 *
 * A sole trader's firm is listed only when it is the caller's own: its org
 * number is the owner's personnummer, so a name match is no proof of whose
 * firm it is (crm#1456). See offerableSearchHits. Everyone else's firm stays
 * out of the response, number and all.
 *
 * No company context: the caller is in the middle of creating one.
 * requireAuth() (not a raw getUser()) keeps MFA AAL2 enforced on hosted.
 */
export async function GET(request: Request) {
  const { user, supabase, error: authError } = await requireAuth()
  if (authError) return authError

  const requestId = `req_${crypto.randomUUID()}`
  const log = createLogger('company.search', { requestId })

  const validated = validateQuery(request, CompanySearchQuerySchema, { log, operation: 'company.search' })
  if (!validated.success) return validated.response
  const q = validated.data.q

  // Digits are an orgnr: that path is the TIC lookup, not a register scan.
  if (/^[\d\s-]+$/.test(q)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { requestId, reason: 'q must be a company name, not a number' })
  }
  if (!isScbConfigured()) return errorResponseFromCode('SCB_NOT_CONFIGURED', log, { requestId })

  try {
    const [result, ownHash] = await Promise.all([
      createScbClient(scbConfigFromEnv()).searchByName(q, { includeSoleTraders: true }),
      ownPersonalNumberHash(supabase, user.id),
    ])
    const candidates = offerableSearchHits(
      result.candidates.map(toCompanySuggestion),
      (s) => ({ orgNumber: s.orgNumber, legalForm: s.legalEntityType }),
      ownHash,
    )
    const suggestions = candidates.slice(0, COMPANY_SUGGEST_MAX)
    return NextResponse.json({
      data: { suggestions, truncated: result.truncated || candidates.length > COMPANY_SUGGEST_MAX },
    })
  } catch (err) {
    log.warn('scb search failed', {
      status: err instanceof ScbApiError ? err.status : undefined,
      message: err instanceof Error ? err.message : String(err),
    })
    return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
  }
}
