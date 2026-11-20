import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuth } from '@/lib/auth/require-auth'
import { validateBody } from '@/lib/api/validate'
import { isoDateSchema } from '@/lib/invariants/zod'
import { createServiceClient } from '@/lib/supabase/server'
import { createLogger } from '@/lib/logger'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ACCEPTED_DOCUMENTS, LEGAL_DOCUMENTS, type LegalDocumentKey } from '@/lib/legal/documents'
import { recordAcceptances, storeAnalyticsConsent } from '@/lib/legal/acceptance'
import { setCompanyDataChoice } from '@/lib/legal/data-choices-store'

const log = createLogger('api/legal/accept')

const AcceptSchema = z
  .object({
    documents: z
      .array(
        z.object({
          key: z.string().min(1).max(40),
          version: isoDateSchema,
        }),
      )
      .min(1)
      .max(10),
    /** Which button: 'accept_all' (everything on) or 'accept_documents' (the toggles as set). */
    method: z.enum(['accept_all', 'accept_documents']),
    analytics_consent: z.boolean(),
    /** The company that was open; required when content_contribution is sent. */
    company_id: z.string().uuid().optional(),
    content_contribution: z.boolean().optional(),
  })
  .strict()

/**
 * POST /api/legal/accept: the acceptance prompt's two buttons.
 *
 * Records that the signed-in person accepted every document in
 * ACCEPTED_DOCUMENTS at its current version (src/lib/legal/documents.ts),
 * stores their analytics choice, and, when an owner or admin turned it on,
 * the company's content contribution. A request naming an older version is
 * refused with 409: the prompt was opened before the documents changed, and
 * the person has to see the new ones first.
 *
 * Not wrapped in withRouteContext: a byrå consultant or a person between
 * companies has no company context and must still be able to accept.
 * requireAuth() is used directly so MFA (AAL2) is still enforced on hosted.
 * Browser-only on purpose (session-route-parity: ui-only): an agent or API
 * key never accepts terms or consents for a person.
 */
export async function POST(request: Request) {
  const auth = await requireAuth()
  if (auth.error) return auth.error
  const { user, supabase } = auth

  const parsed = await validateBody(request, AcceptSchema)
  if (!parsed.success) return parsed.response
  const body = parsed.data

  // 'accept_all' means what it says: analytics and contribution on.
  if (body.method === 'accept_all' && (!body.analytics_consent || body.content_contribution === false)) {
    return errorResponseFromCode('VALIDATION_ERROR', log, {
      reason: 'accept_all with a choice switched off',
      messageSv: 'Godkänn allt slår på alla val.',
      messageEn: 'Accept all switches every choice on.',
    })
  }

  // Every document at its current version, nothing else.
  const sent = new Map(body.documents.map((d) => [d.key, d.version]))
  const unknown = [...sent.keys()].filter((key) => !(ACCEPTED_DOCUMENTS as string[]).includes(key))
  if (unknown.length > 0) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { reason: `unknown document: ${unknown.join(', ')}` })
  }
  const stale = ACCEPTED_DOCUMENTS.filter((key) => sent.get(key) !== LEGAL_DOCUMENTS[key].acceptanceVersion)
  if (stale.length > 0) {
    return errorResponseFromCode('CONFLICT', log, {
      reason: `stale or missing document versions: ${stale.join(', ')}`,
      messageSv: 'Villkoren har uppdaterats. Ladda om sidan och läs den nya versionen.',
      messageEn: 'The terms have been updated. Reload the page and read the new version.',
      details: { stale },
    })
  }

  // The open company, as context for the acceptance and the one contribution can be set for.
  let companyId: string | null = null
  let canDecideForCompany = false
  if (body.company_id) {
    const { data: membership, error } = await supabase
      .from('company_members')
      .select('role')
      .eq('company_id', body.company_id)
      .eq('user_id', user.id)
      .maybeSingle()
    if (error) return errorResponse(error, log)
    if (!membership) return errorResponseFromCode('NOT_FOUND', log, { reason: 'not a member of company_id' })
    companyId = body.company_id
    const role = (membership as { role: string }).role
    canDecideForCompany = role === 'owner' || role === 'admin'
  }
  if (body.content_contribution !== undefined && !companyId) {
    return errorResponseFromCode('VALIDATION_ERROR', log, { reason: 'content_contribution needs company_id' })
  }
  if (body.content_contribution === true && !canDecideForCompany) {
    return errorResponseFromCode('FORBIDDEN', log, {
      reason: 'content_contribution by a non-admin',
      messageSv: 'Bara ägare och administratörer kan ändra företagets datadelning.',
      messageEn: "Only owners and admins can change the company's data sharing.",
    })
  }

  try {
    await recordAcceptances(supabase, {
      userId: user.id,
      companyId,
      method: body.method,
      documents: ACCEPTED_DOCUMENTS.map((key) => ({ key: key as LegalDocumentKey, version: sent.get(key)! })),
    })
    await storeAnalyticsConsent(supabase, user.id, body.analytics_consent)
    if (companyId && canDecideForCompany && body.content_contribution !== undefined) {
      const result = await setCompanyDataChoice(createServiceClient(), {
        companyId,
        choice: 'contribution',
        enabled: body.content_contribution,
        decidedBy: user.id,
        actorType: 'user',
      })
      if (!result.ok) return errorResponseFromCode('FORBIDDEN', log, { reason: result.code })
    }
  } catch (err) {
    return errorResponse(err, log)
  }

  return NextResponse.json({
    data: {
      accepted: ACCEPTED_DOCUMENTS,
      analytics_consent: body.analytics_consent,
      content_contribution: companyId && canDecideForCompany ? (body.content_contribution ?? null) : null,
    },
  })
}
