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

/**
 * GET /api/company/search?q=: companies whose registered name starts with
 * (or, failing that, contains) the query, for the search-as-you-type picker
 * on the onboarding orgnr step. Reads SCB's företagsregister, which is
 * free, so the client may call it per debounced keystroke; the paid TIC
 * lookup runs once, on the pick, exactly as for a typed orgnr.
 *
 * Sole traders are included: a person searching for their own firm is the
 * point of the step. Their org number is a personnummer, so the client
 * names the form and never prints it.
 *
 * No company context: the caller is in the middle of creating one.
 * requireAuth() (not a raw getUser()) keeps MFA AAL2 enforced on hosted.
 */
export async function GET(request: Request) {
  const { error: authError } = await requireAuth()
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
    const result = await createScbClient(scbConfigFromEnv()).searchByName(q, { includeSoleTraders: true })
    const suggestions = result.candidates.slice(0, COMPANY_SUGGEST_MAX).map(toCompanySuggestion)
    return NextResponse.json({
      data: { suggestions, truncated: result.truncated || result.candidates.length > COMPANY_SUGGEST_MAX },
    })
  } catch (err) {
    log.warn('scb search failed', {
      status: err instanceof ScbApiError ? err.status : undefined,
      message: err instanceof Error ? err.message : String(err),
    })
    return errorResponseFromCode('SCB_LOOKUP_FAILED', log, { requestId })
  }
}
