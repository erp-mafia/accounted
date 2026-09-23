/**
 * Peppol receiving: register a company's participant identifier at the
 * contracted Access Point so other parties can send e-invoices to it.
 *
 * Provider-neutral: the transport does the SMP work, this module keeps the
 * company-side record (`peppol_registrations`) truthful about it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorEntry, hasErrorEntry } from '@/lib/errors/structured-errors'
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
  /** Raw text of the last failure, for logs and ops; never shown to users. */
  last_error: string | null
  /**
   * Stable code behind `last_error`, always an error-registry code: the
   * transport code when the registry knows it and it carries a verdict of
   * its own, else the verdict (PEPPOL_REGISTRATION_REJECTED or _FAILED). The
   * UI translates it and offers a retry only when the entry is retryable.
   */
  last_error_code: string | null
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

export type PeppolParticipantEligibility =
  | { ok: true; code: null }
  | { ok: false; code: Extract<PeppolParticipantPreparation, { ok: false }>['code'] }

/**
 * Read-side view of preparePeppolParticipant: can this company be registered
 * at all, and if not, why. The settings page asks before it offers receiving,
 * so a personnummer-based company learns the answer up front instead of after
 * the operators granted a slot.
 */
export function describePeppolParticipantEligibility(settings: ParticipantSettings): PeppolParticipantEligibility {
  const prepared = preparePeppolParticipant(settings)
  return prepared.ok ? { ok: true, code: null } : { ok: false, code: prepared.code }
}

const LIVE_STATUSES: PeppolRegistrationStatus[] = ['pending', 'registered']

/**
 * A pending row older than this is a crashed or timed-out attempt, not a call
 * in flight: the connector gives up after 60 s and the route after 90 s.
 */
export const PEPPOL_PENDING_STALE_MS = 5 * 60 * 1000

export function isStalePeppolPending(
  row: Pick<PeppolRegistrationRow, 'status' | 'updated_at'>,
  now: number = Date.now(),
): boolean {
  if (row.status !== 'pending') return false
  const updatedAt = Date.parse(row.updated_at)
  return Number.isFinite(updatedAt) && now - updatedAt > PEPPOL_PENDING_STALE_MS
}

/**
 * Hosted verdicts on the identifier itself (packages/connect-contract):
 * retrying the same registration cannot change them, whatever the envelope's
 * retryable flag says.
 */
const PERMANENT_TRANSPORT_CODES = new Set([
  'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
  'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN',
  'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
  'CONNECTOR_QUOTA_EXCEEDED',
  'PEPPOL_REGISTRATION_CAP_REACHED',
  'PEPPOL_RECEIVING_UNSUPPORTED',
])

/** Hosted codes that already exist as registration result codes: pass them through 1:1. */
type PassthroughCode = 'PEPPOL_REGISTRATION_CAP_REACHED' | 'PEPPOL_RECEIVING_UNSUPPORTED'
const PASSTHROUGH_TRANSPORT_CODES: ReadonlySet<string> = new Set<PassthroughCode>([
  'PEPPOL_REGISTRATION_CAP_REACHED',
  'PEPPOL_RECEIVING_UNSUPPORTED',
])

/**
 * Hosted answers that are transient whatever the envelope's retryable flag
 * says: the hosted side is busy, mid-flight, or misconfigured, not refusing.
 * A bare HTTP_404 belongs here too: every hosted 404 is a CONNECTOR_NOT_OWNED
 * envelope, so a bare one means the connector URL never reached the route.
 */
const TRANSIENT_TRANSPORT_CODES: ReadonlySet<string> = new Set([
  'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
  'CONNECTOR_RATE_LIMITED',
  'CONNECTOR_UPSTREAM_UNCONFIGURED',
  'CONNECTOR_LEDGER_FAILED',
  'CONNECTOR_UNREACHABLE',
  'HTTP_404',
])

/** The one transport answer meaning the hosted side does not hold the identifier for this key. */
const NOT_HELD_TRANSPORT_CODE = 'CONNECTOR_NOT_OWNED'

/**
 * What goes into last_error_code. The transport code is kept only when the
 * registry has text for it AND the code is a verdict of its own:
 * CONNECTOR_UPSTREAM_ERROR and HTTP_<n> are wrappers around whatever the
 * access point said (a permanent Qvalia refusal arrives as UPSTREAM_ERROR),
 * so storing them would show retry advice for a refusal. Everything else
 * stores the verdict itself.
 */
function persistedErrorCode(transportCode: string | null, verdict: string): string {
  if (!transportCode) return verdict
  if (transportCode === 'CONNECTOR_UPSTREAM_ERROR' || /^HTTP_\d+$/.test(transportCode)) return verdict
  return hasErrorEntry(transportCode) ? transportCode : verdict
}

/**
 * Whether "try again" can change anything: a failed attempt (failed, or
 * pending past the stale window) or a failed withdrawal on a live row, and a
 * stored code whose registry entry is retryable. An unknown or missing code
 * counts as retryable; a permanent verdict never offers the button.
 */
export function canRetryPeppolRegistration(
  row: Pick<PeppolRegistrationRow, 'status' | 'updated_at' | 'last_error_code'>,
  now: number = Date.now(),
): boolean {
  const failedAttempt = row.status === 'failed' || isStalePeppolPending(row, now)
  const failedWithdrawal = row.status === 'registered' && row.last_error_code !== null
  if (!failedAttempt && !failedWithdrawal) return false
  if (!row.last_error_code) return true
  const entry = getErrorEntry(row.last_error_code)
  return entry ? entry.retryable === true : true
}

interface TransportFailure {
  permanent: boolean
  /** The transport's stable code, null for non-transport errors (a DB write that failed). */
  transportCode: string | null
  /** The hosted detail text, for the API response's details.reason. */
  detail: string | null
  /** Composed raw text for last_error (logs and ops only). */
  raw: string
}

function describeTransportFailure(err: unknown): TransportFailure {
  if (isPeppolTransportError(err)) {
    const transportCode = err.code
    const transient = transportCode !== null && TRANSIENT_TRANSPORT_CODES.has(transportCode)
    return {
      permanent: !transient && (!err.retryable || (transportCode !== null && PERMANENT_TRANSPORT_CODES.has(transportCode))),
      transportCode,
      detail: err.detail,
      raw: [err.message, err.detail].filter(Boolean).join(': ').slice(0, 500),
    }
  }
  return {
    permanent: false,
    transportCode: null,
    detail: null,
    raw: err instanceof Error ? err.message.slice(0, 500) : 'unknown error',
  }
}

function isPassthroughCode(code: string | null): code is PassthroughCode {
  return code !== null && PASSTHROUGH_TRANSPORT_CODES.has(code)
}

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

/**
 * A failure the transport reported. `code` separates a verdict on the
 * identifier (REJECTED: retrying cannot help) from an operational problem
 * (FAILED: retry later). `detail` is the hosted detail text; `reason` is
 * what the transport actually said (its code) for the response details and
 * the log, which may differ from the registry code persisted on the row.
 */
export interface PeppolTransportVerdict {
  ok: false
  code: 'PEPPOL_REGISTRATION_REJECTED' | 'PEPPOL_REGISTRATION_FAILED'
  detail: string | null
  reason: string | null
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
  | PeppolTransportVerdict

/**
 * Publish the company's identifier through the transport and record the
 * outcome. The row is written as `pending` before the network call and
 * finalized after it, so a crash mid-way leaves a visible pending row rather
 * than a silent gap. A pending row older than PEPPOL_PENDING_STALE_MS is such
 * a leftover: it is retired as failed and a fresh attempt runs.
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
  const stale = live !== null && isStalePeppolPending(live)

  let rowId: string
  if (live && !stale) {
    rowId = live.id
  } else {
    // The cap is checked before anything is written, so a cap-reached answer
    // leaves a stale row exactly as it was. The stale row is still counted
    // as live by the index, but its slot is this company's own: it is not
    // held against the retry.
    const cap = getPeppolReceivingCap()
    if (cap !== null) {
      const liveCount = await countLivePeppolRegistrations({ supabase: service, provider: transport.provider })
      if (liveCount - (stale ? 1 : 0) >= cap) return { ok: false, code: 'PEPPOL_REGISTRATION_CAP_REACHED' }
    }
    if (live) {
      // The live-row unique index would block a new pending row, so the
      // stale one is closed first; it stays as history with the reason on it.
      const { error } = await service
        .from('peppol_registrations')
        .update({
          status: 'failed',
          last_error: 'Registration did not complete within 5 minutes; retired by a new attempt',
          last_error_code: 'PEPPOL_REGISTRATION_FAILED',
        })
        .eq('id', live.id)
      if (error) throw new Error(`Failed to retire stale Peppol registration: ${error.message}`)
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
    if ((error as { code?: string } | null)?.code === '23505') {
      // A concurrent attempt (a double click, two tabs) holds the live row:
      // the registration is in progress, not broken, and the other request
      // will finalize it.
      return {
        ok: false,
        code: 'PEPPOL_REGISTRATION_FAILED',
        detail: null,
        reason: 'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
      }
    }
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
        last_error_code: null,
      })
      .eq('id', rowId)
      .select('*')
      .single()
    if (error || !data) throw new Error(`Failed to finalize Peppol registration: ${error?.message ?? 'no row'}`)
    return { ok: true, registration: data as PeppolRegistrationRow }
  } catch (err) {
    const failure = describeTransportFailure(err)
    const code = isPassthroughCode(failure.transportCode)
      ? failure.transportCode
      : failure.permanent ? 'PEPPOL_REGISTRATION_REJECTED' : 'PEPPOL_REGISTRATION_FAILED'
    const reason = failure.transportCode ?? code
    await service
      .from('peppol_registrations')
      .update({ status: 'failed', last_error: failure.raw, last_error_code: persistedErrorCode(failure.transportCode, code) })
      .eq('id', rowId)
    if (isPassthroughCode(code)) return { ok: false, code }
    return { ok: false, code, detail: failure.detail, reason }
  }
}

export type DeregisterPeppolResult =
  | { ok: true; registration: PeppolRegistrationRow }
  | { ok: false; code: 'PEPPOL_RECEIVING_UNSUPPORTED' | 'PEPPOL_REGISTRATION_NOT_FOUND' }
  | PeppolTransportVerdict

async function finalizeDeregistered(
  service: SupabaseClient,
  rowId: string,
  lastError: { last_error: string | null; last_error_code: string | null },
): Promise<PeppolRegistrationRow> {
  const { data, error } = await service
    .from('peppol_registrations')
    .update({
      status: 'deregistered',
      deregistered_at: new Date().toISOString(),
      last_error: lastError.last_error,
      last_error_code: lastError.last_error_code,
    })
    .eq('id', rowId)
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to record Peppol deregistration: ${error?.message ?? 'no row'}`)
  return data as PeppolRegistrationRow
}

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
    const failure = describeTransportFailure(err)
    if (failure.transportCode === NOT_HELD_TRANSPORT_CODE) {
      // The hosted side does not hold the identifier (a stale pending row, or
      // one withdrawn out of band): the local row is all that is left, so it
      // is closed rather than kept live with a hidden error.
      const registration = await finalizeDeregistered(service, existing.id, {
        last_error: failure.raw,
        last_error_code: failure.transportCode,
      })
      return { ok: true, registration }
    }
    const code = failure.transportCode === 'PEPPOL_RECEIVING_UNSUPPORTED'
      ? 'PEPPOL_RECEIVING_UNSUPPORTED'
      : failure.permanent ? 'PEPPOL_REGISTRATION_REJECTED' : 'PEPPOL_REGISTRATION_FAILED'
    const reason = failure.transportCode ?? code
    await service
      .from('peppol_registrations')
      .update({ last_error: failure.raw, last_error_code: persistedErrorCode(failure.transportCode, code) })
      .eq('id', existing.id)
    if (code === 'PEPPOL_RECEIVING_UNSUPPORTED') return { ok: false, code }
    return { ok: false, code, detail: failure.detail, reason }
  }

  const registration = await finalizeDeregistered(service, existing.id, { last_error: null, last_error_code: null })
  return { ok: true, registration }
}
