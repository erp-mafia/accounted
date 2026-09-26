import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import {
  canRetryPeppolRegistration,
  deregisterCompanyFromPeppolReceiving,
  isStalePeppolPending,
  type PeppolRegistrationRow,
  type PeppolTransportVerdict,
} from '@/lib/invoices/peppol-registration'
import { getPeppolRegistrationStatus, registerPeppolParticipant } from '@/lib/invoices/peppol-settings-service'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

// The connector transport waits up to 60 s for the hosted access point; the
// platform default would cut the registration off mid-call and leave a
// pending row behind.
export const maxDuration = 90

/**
 * Minimized row for the settings page. `last_error` stays server-side: it is
 * raw provider prose for ops; the page translates `last_error_code` instead.
 */
function registrationPayload(row: PeppolRegistrationRow | null) {
  if (!row) return null
  return {
    id: row.id,
    provider: row.provider,
    participant_scheme: row.participant_scheme,
    participant_identifier: row.participant_identifier,
    status: row.status,
    registered_at: row.registered_at,
    deregistered_at: row.deregistered_at,
    last_error_code: row.last_error_code,
    stale_pending: isStalePeppolPending(row),
    // Decided here, next to the registry: the page never guesses whether a
    // stored code is worth retrying.
    can_retry: canRetryPeppolRegistration(row),
    updated_at: row.updated_at,
  }
}

/** Response context for a transport verdict: the hosted detail and code travel in `details`, the pair also goes to the log. */
function verdictContext(details: { reason: string | null; code: string | null }, requestId: string | undefined) {
  return {
    requestId,
    reason: [details.code, details.reason].filter(Boolean).join(': ') || undefined,
    details: { reason: details.reason, code: details.code },
  }
}

function isTransportVerdictCode(code: string): boolean {
  return code === 'PEPPOL_REGISTRATION_REJECTED' || code === 'PEPPOL_REGISTRATION_FAILED'
}

function isTransportVerdict(result: { ok: false; code: string }): result is PeppolTransportVerdict {
  return isTransportVerdictCode(result.code)
}

function resolveTransport(): { transport: PeppolTransport; provider: string } | null {
  const availability = getPeppolTransportAvailability()
  if (!availability.available) return null
  const transport = getPeppolTransport(availability.provider)
  return transport ? { transport, provider: availability.provider } : null
}

/** GET /api/settings/peppol: receiving status for the active company (lib/invoices/peppol-settings-service.ts). */
export const GET = withRouteContext(
  'settings.peppol.get',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const outcome = await getPeppolRegistrationStatus(
      { supabase, companyId, userId: user.id, log },
      { service: createServiceClient() },
    )
    if (!outcome.ok) return privateNoStore(sessionFailureResponse(outcome, log, requestId))
    if (outcome.dryRun) return privateNoStore(NextResponse.json({ data: outcome.preview }))
    return privateNoStore(NextResponse.json({
      data: { ...outcome.data, registration: registrationPayload(outcome.data.registration) },
    }))
  },
)

/**
 * POST /api/settings/peppol: publish the company's Peppol identifier for
 * receiving. The gates live in lib/invoices/peppol-settings-service.ts,
 * shared with the v1 operation peppol.register.
 */
export const POST = withRouteContext(
  'settings.peppol.register',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const outcome = await registerPeppolParticipant(
      { supabase, companyId, userId: user.id, log },
      { service: createServiceClient() },
    )
    if (!outcome.ok) {
      if (outcome.error) return privateNoStore(errorResponse(outcome.error, log, { requestId }))
      if (isTransportVerdictCode(outcome.code)) {
        const details = outcome.details as { reason: string | null; code: string | null }
        return privateNoStore(errorResponseFromCode(outcome.code, log, verdictContext(details, requestId)))
      }
      return privateNoStore(errorResponseFromCode(outcome.code, log, { requestId }))
    }
    if (outcome.dryRun) return privateNoStore(NextResponse.json({ data: outcome.preview }))
    return privateNoStore(NextResponse.json({
      data: { registration: registrationPayload(outcome.data.registration) },
    }, { status: 201 }))
  },
  { requireWrite: true },
)

/** DELETE /api/settings/peppol: withdraw the identifier from the Access Point. */
export const DELETE = withRouteContext(
  'settings.peppol.deregister',
  async (_request, { companyId, log, requestId }) => {
    const resolved = resolveTransport()
    if (!resolved) {
      return privateNoStore(errorResponseFromCode('PEPPOL_TRANSPORT_UNAVAILABLE', log, { requestId }))
    }
    try {
      const result = await deregisterCompanyFromPeppolReceiving({
        service: createServiceClient(),
        companyId,
        transport: resolved.transport,
      })
      if (!result.ok) {
        return privateNoStore(errorResponseFromCode(
          result.code,
          log,
          isTransportVerdict(result) ? verdictContext({ reason: result.detail, code: result.reason }, requestId) : { requestId },
        ))
      }
      return privateNoStore(NextResponse.json({
        data: { registration: registrationPayload(result.registration) },
      }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
  { requireWrite: true },
)
