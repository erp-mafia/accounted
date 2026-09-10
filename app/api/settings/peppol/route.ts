import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { getPeppolAccess, getPeppolAccessSummary } from '@/lib/invoices/peppol-access'
import {
  canRetryPeppolRegistration,
  deregisterCompanyFromPeppolReceiving,
  describePeppolParticipantEligibility,
  getPeppolRegistration,
  isStalePeppolPending,
  registerCompanyForPeppolReceiving,
  type PeppolParticipantEligibility,
  type PeppolRegistrationRow,
  type PeppolTransportVerdict,
} from '@/lib/invoices/peppol-registration'
import {
  getPeppolTransport,
  getPeppolTransportAvailability,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import type { CompanySettings } from '@/types'

ensureInitialized()

// The connector transport waits up to 60 s for the hosted access point; the
// platform default would cut the registration off mid-call and leave a
// pending row behind.
export const maxDuration = 90

type ParticipantSettings = Pick<CompanySettings, 'org_number' | 'company_name' | 'vat_number' | 'city' | 'country'>

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
function verdictContext(result: PeppolTransportVerdict, requestId: string | undefined) {
  return {
    requestId,
    reason: [result.reason, result.detail].filter(Boolean).join(': ') || undefined,
    details: { reason: result.detail, code: result.reason },
  }
}

function isTransportVerdict(result: { ok: false; code: string }): result is PeppolTransportVerdict {
  return result.code === 'PEPPOL_REGISTRATION_REJECTED' || result.code === 'PEPPOL_REGISTRATION_FAILED'
}

function resolveTransport(): { transport: PeppolTransport; provider: string } | null {
  const availability = getPeppolTransportAvailability()
  if (!availability.available) return null
  const transport = getPeppolTransport(availability.provider)
  return transport ? { transport, provider: availability.provider } : null
}

/** GET /api/settings/peppol: receiving status for the active company. */
export const GET = withRouteContext(
  'settings.peppol.get',
  async (_request, { supabase, companyId, log, requestId }) => {
    const availability = getPeppolTransportAvailability()
    const resolved = resolveTransport()
    try {
      const registration = resolved
        ? await getPeppolRegistration({ supabase, companyId, provider: resolved.provider })
        : null
      // Eligibility is answered up front so a company that cannot be
      // registered (personnummer, missing org number) sees why before it
      // asks the operators for a receiving slot.
      const { data: settings, error: settingsError } = await supabase
        .from('company_settings')
        .select('org_number, company_name, vat_number, city, country')
        .eq('company_id', companyId)
        .maybeSingle()
      // A failed read is a server error, never "no organisation number":
      // that verdict would hide the receiving offer from an eligible company.
      if (settingsError) throw new Error(`Failed to read company settings: ${settingsError.message}`)
      const participant: PeppolParticipantEligibility = settings
        ? describePeppolParticipantEligibility(settings as unknown as ParticipantSettings)
        : { ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' }
      const access = await getPeppolAccessSummary({ supabase, service: createServiceClient(), companyId })
      return privateNoStore(NextResponse.json({
        data: {
          transport: availability,
          receiving_supported: !!resolved?.transport.registerRecipient,
          access,
          participant,
          registration: registrationPayload(registration),
        },
      }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
)

/** POST /api/settings/peppol: publish the company's Peppol identifier for receiving. */
export const POST = withRouteContext(
  'settings.peppol.register',
  async (_request, { supabase, companyId, user, log, requestId }) => {
    const resolved = resolveTransport()
    if (!resolved) {
      return privateNoStore(errorResponseFromCode('PEPPOL_TRANSPORT_UNAVAILABLE', log, { requestId }))
    }
    if (await isSandboxCompany(supabase, companyId)) {
      return privateNoStore(errorResponseFromCode('PEPPOL_SANDBOX_NOT_ALLOWED', log, { requestId }))
    }
    // Receiving consumes a contracted tenant slot: operators grant it per company.
    const access = await getPeppolAccess(createServiceClient(), companyId)
    if (!access || access.status !== 'enabled') {
      return privateNoStore(errorResponseFromCode('PEPPOL_ACCESS_REQUIRED', log, { requestId }))
    }
    if (!access.receive_enabled) {
      return privateNoStore(errorResponseFromCode('PEPPOL_RECEIVING_NOT_ENABLED', log, { requestId }))
    }

    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('org_number, company_name, vat_number, city, country')
      .eq('company_id', companyId)
      .single()
    if (settingsError || !settings) {
      return privateNoStore(errorResponseFromCode('INVOICE_SEND_COMPANY_SETTINGS_MISSING', log, { requestId }))
    }

    try {
      const result = await registerCompanyForPeppolReceiving({
        service: createServiceClient(),
        companyId,
        userId: user.id,
        transport: resolved.transport,
        settings: settings as unknown as ParticipantSettings,
      })
      if (!result.ok) {
        return privateNoStore(errorResponseFromCode(
          result.code,
          log,
          isTransportVerdict(result) ? verdictContext(result, requestId) : { requestId },
        ))
      }
      return privateNoStore(NextResponse.json({
        data: { registration: registrationPayload(result.registration) },
      }, { status: 201 }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
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
          isTransportVerdict(result) ? verdictContext(result, requestId) : { requestId },
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
