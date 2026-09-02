/**
 * Peppol receiving: register a company's participant identifier at the
 * contracted Access Point so other parties can send e-invoices to it.
 *
 * Provider-neutral: the transport does the SMP work, this module keeps the
 * company-side record (`peppol_registrations`) truthful about it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import {
  isPeppolTransportError,
  type PeppolBusinessCard,
  type PeppolDocumentTypeRegistration,
  type PeppolParticipant,
  type PeppolTransport,
} from '@/lib/invoices/peppol-transport'
import type { CompanySettings } from '@/types'

export const PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID =
  'urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2::CreditNote##urn:cen.eu:en16931:2017#compliant#urn:fdc:peppol.eu:2017:poacc:billing:3.0::2.1'

/** What a receiving company advertises: BIS Billing 3 invoices and credit notes. */
export const PEPPOL_RECEIVING_DOCUMENT_TYPES: PeppolDocumentTypeRegistration[] = [
  { processId: PEPPOL_BIS_BILLING_PROFILE_ID, documentTypeId: PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID },
  { processId: PEPPOL_BIS_BILLING_PROFILE_ID, documentTypeId: PEPPOL_BIS_BILLING_CREDIT_NOTE_DOCUMENT_TYPE_ID },
]

export type PeppolRegistrationStatus = 'pending' | 'registered' | 'failed' | 'deregistered'

export interface PeppolRegistrationRow {
  id: string
  company_id: string
  user_id: string | null
  provider: string
  provider_account_reference: string | null
  participant_scheme: string
  participant_identifier: string
  status: PeppolRegistrationStatus
  business_card: Record<string, unknown>
  document_types: unknown[]
  registered_at: string | null
  deregistered_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export type PeppolParticipantPreparation =
  | { ok: true; participant: PeppolParticipant; businessCard: PeppolBusinessCard }
  | {
      ok: false
      code:
        | 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED'
        | 'PEPPOL_REGISTRATION_PERSONAL_NUMBER'
        | 'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED'
    }

type ParticipantSettings = Pick<
  CompanySettings,
  'org_number' | 'company_name' | 'vat_number' | 'city' | 'country'
>

/**
 * Derive the participant (scheme 0007 + organisation number) and the Peppol
 * Directory business card from the company settings. Personnummer-based
 * identifiers are refused: publishing one would put personal identity data in
 * a public directory; they need a separately configured 0088 GLN.
 */
export function preparePeppolParticipant(settings: ParticipantSettings): PeppolParticipantPreparation {
  const digits = (settings.org_number ?? '').replace(/\D/g, '')
  const orgNumber = digits.length === 12 && digits.startsWith('16') ? digits.slice(2) : digits
  if (orgNumber.length !== 10) return { ok: false, code: 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED' }
  // Same rule as the BIS Billing generator: an organisation number has its
  // third digit >= 2; a personnummer has a month (01-12) there.
  if (Number(orgNumber[2]) < 2) return { ok: false, code: 'PEPPOL_REGISTRATION_PERSONAL_NUMBER' }
  const companyName = settings.company_name?.trim()
  if (!companyName) return { ok: false, code: 'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED' }

  return {
    ok: true,
    participant: { scheme: '0007', identifier: orgNumber },
    businessCard: {
      companyName,
      countryCode: (settings.country || 'SE').toUpperCase().slice(0, 2),
      geographicalInformation: settings.city?.trim() || null,
      vatNumber: settings.vat_number?.replace(/\s/g, '') || null,
      orgNumber,
    },
  }
}

const LIVE_STATUSES: PeppolRegistrationStatus[] = ['pending', 'registered']

/**
 * How many companies may publish a receiving identifier through our provider
 * account. The Qvalia partner contract is priced per tenant (10 to start), so
 * the product refuses the eleventh instead of silently exceeding the contract.
 * Unset or invalid means no cap (self-hosted with an own provider account).
 */
export function getPeppolReceivingCap(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env.PEPPOL_RECEIVING_MAX_REGISTRATIONS?.trim()
  if (!raw) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

export async function countLivePeppolRegistrations(args: {
  supabase: SupabaseClient
  provider: string
}): Promise<number> {
  const { count, error } = await args.supabase
    .from('peppol_registrations')
    .select('id', { count: 'exact', head: true })
    .eq('provider', args.provider)
    .in('status', LIVE_STATUSES)
  if (error) throw new Error(`Failed to count Peppol registrations: ${error.message}`)
  return count ?? 0
}

/** The live registration for a company at a provider, else the most recent history row. */
export async function getPeppolRegistration(args: {
  supabase: SupabaseClient
  companyId: string
  provider: string
}): Promise<PeppolRegistrationRow | null> {
  const { data, error } = await args.supabase
    .from('peppol_registrations')
    .select('*')
    .eq('company_id', args.companyId)
    .eq('provider', args.provider)
    .order('updated_at', { ascending: false })
    .limit(10)
  if (error) throw new Error(`Failed to read Peppol registration: ${error.message}`)
  const rows = (data ?? []) as PeppolRegistrationRow[]
  return rows.find((row) => LIVE_STATUSES.includes(row.status)) ?? rows[0] ?? null
}

export type RegisterPeppolResult =
  | { ok: true; registration: PeppolRegistrationRow }
  | {
      ok: false
      code:
        | 'PEPPOL_REGISTRATION_ORG_NUMBER_REQUIRED'
        | 'PEPPOL_REGISTRATION_PERSONAL_NUMBER'
        | 'PEPPOL_REGISTRATION_COMPANY_NAME_REQUIRED'
        | 'PEPPOL_RECEIVING_UNSUPPORTED'
        | 'PEPPOL_REGISTRATION_CAP_REACHED'
    }
  | { ok: false; code: 'PEPPOL_REGISTRATION_FAILED'; detail: string | null }

/**
 * Publish the company's identifier through the transport and record the
 * outcome. The row is written as `pending` before the network call and
 * finalized after it, so a crash mid-way leaves a visible pending row rather
 * than a silent gap.
 */
export async function registerCompanyForPeppolReceiving(args: {
  service: SupabaseClient
  companyId: string
  userId: string
  transport: PeppolTransport
  settings: ParticipantSettings
}): Promise<RegisterPeppolResult> {
  const { service, companyId, userId, transport } = args
  if (!transport.registerRecipient) return { ok: false, code: 'PEPPOL_RECEIVING_UNSUPPORTED' }
  const prepared = preparePeppolParticipant(args.settings)
  if (!prepared.ok) return { ok: false, code: prepared.code }

  const existing = await getPeppolRegistration({ supabase: service, companyId, provider: transport.provider })
  const live = existing && LIVE_STATUSES.includes(existing.status) ? existing : null

  let rowId: string
  if (live) {
    rowId = live.id
  } else {
    const cap = getPeppolReceivingCap()
    if (cap !== null) {
      const liveCount = await countLivePeppolRegistrations({ supabase: service, provider: transport.provider })
      if (liveCount >= cap) return { ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' }
    }
    const { data, error } = await service
      .from('peppol_registrations')
      .insert({
        company_id: companyId,
        user_id: userId,
        provider: transport.provider,
        participant_scheme: prepared.participant.scheme,
        participant_identifier: prepared.participant.identifier,
        status: 'pending',
        business_card: prepared.businessCard,
        document_types: PEPPOL_RECEIVING_DOCUMENT_TYPES,
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`Failed to create Peppol registration: ${error?.message ?? 'no row'}`)
    rowId = (data as { id: string }).id
  }

  try {
    const result = await transport.registerRecipient({
      participant: prepared.participant,
      businessCard: prepared.businessCard,
      documentTypes: PEPPOL_RECEIVING_DOCUMENT_TYPES,
      tenantReference: companyId,
    })
    const { data, error } = await service
      .from('peppol_registrations')
      .update({
        status: 'registered',
        registered_at: new Date().toISOString(),
        deregistered_at: null,
        provider_account_reference: result.providerAccountReference,
        participant_scheme: prepared.participant.scheme,
        participant_identifier: prepared.participant.identifier,
        business_card: prepared.businessCard,
        document_types: PEPPOL_RECEIVING_DOCUMENT_TYPES,
        last_error: null,
      })
      .eq('id', rowId)
      .select('*')
      .single()
    if (error || !data) throw new Error(`Failed to finalize Peppol registration: ${error?.message ?? 'no row'}`)
    return { ok: true, registration: data as PeppolRegistrationRow }
  } catch (err) {
    const detail = isPeppolTransportError(err)
      ? [err.message, err.detail].filter(Boolean).join(': ').slice(0, 500)
      : err instanceof Error ? err.message.slice(0, 500) : 'unknown error'
    await service
      .from('peppol_registrations')
      .update({ status: 'failed', last_error: detail })
      .eq('id', rowId)
    return { ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail: isPeppolTransportError(err) ? err.detail : null }
  }
}

export type DeregisterPeppolResult =
  | { ok: true; registration: PeppolRegistrationRow }
  | { ok: false; code: 'PEPPOL_RECEIVING_UNSUPPORTED' | 'PEPPOL_REGISTRATION_NOT_FOUND' }
  | { ok: false; code: 'PEPPOL_REGISTRATION_FAILED'; detail: string | null }

export async function deregisterCompanyFromPeppolReceiving(args: {
  service: SupabaseClient
  companyId: string
  transport: PeppolTransport
}): Promise<DeregisterPeppolResult> {
  const { service, companyId, transport } = args
  if (!transport.unregisterRecipient) return { ok: false, code: 'PEPPOL_RECEIVING_UNSUPPORTED' }
  const existing = await getPeppolRegistration({ supabase: service, companyId, provider: transport.provider })
  if (!existing || !LIVE_STATUSES.includes(existing.status)) {
    return { ok: false, code: 'PEPPOL_REGISTRATION_NOT_FOUND' }
  }

  try {
    await transport.unregisterRecipient({
      scheme: existing.participant_scheme,
      identifier: existing.participant_identifier,
    })
  } catch (err) {
    const detail = isPeppolTransportError(err) ? err.detail : null
    await service
      .from('peppol_registrations')
      .update({ last_error: err instanceof Error ? err.message.slice(0, 500) : 'unknown error' })
      .eq('id', existing.id)
    return { ok: false, code: 'PEPPOL_REGISTRATION_FAILED', detail }
  }

  const { data, error } = await service
    .from('peppol_registrations')
    .update({ status: 'deregistered', deregistered_at: new Date().toISOString(), last_error: null })
    .eq('id', existing.id)
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to record Peppol deregistration: ${error?.message ?? 'no row'}`)
  return { ok: true, registration: data as PeppolRegistrationRow }
}
