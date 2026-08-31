import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { getPeppolAccess, getPeppolAccessSummary } from '@/lib/invoices/peppol-access'
import {
  deregisterCompanyFromPeppolReceiving,
  getPeppolRegistration,
  registerCompanyForPeppolReceiving,
  type PeppolRegistrationRow,
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
    last_error: row.last_error,
    updated_at: row.updated_at,
  }
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
      const access = await getPeppolAccessSummary({ supabase, service: createServiceClient(), companyId })
      return privateNoStore(NextResponse.json({
        data: {
          transport: availability,
          receiving_supported: !!resolved?.transport.registerRecipient,
          access,
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
        settings: settings as Pick<CompanySettings, 'org_number' | 'company_name' | 'vat_number' | 'city' | 'country'>,
      })
      if (!result.ok) {
        return privateNoStore(errorResponseFromCode(result.code, log, {
          requestId,
          ...('detail' in result && result.detail ? { details: { reason: result.detail } } : {}),
        }))
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
        return privateNoStore(errorResponseFromCode(result.code, log, {
          requestId,
          ...('detail' in result && result.detail ? { details: { reason: result.detail } } : {}),
        }))
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
