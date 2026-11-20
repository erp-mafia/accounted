import { getResendClient } from '@/lib/email/resend-client'
import type { DomainStatus } from 'resend'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanySendingDomain, CompanySendingDomainStatus } from '@/types'
import {
  isReservedSenderDomain,
  normalizeDomainName,
  normalizeSenderLocalPart,
} from '@/lib/email/domain-name'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { createLogger } from '@/lib/logger'

const log = createLogger('email-sending-domains')

/**
 * Per-company outbound sending domains (opt-in): the Resend side of the
 * feature. Claim registers the domain in the platform's Resend account with
 * the SENDING capability only; the company publishes DKIM/SPF; once Resend
 * reports verified, resolveInvoiceSender() (core) starts using it.
 *
 * Mirrors the inbox extension's receiving-only custom domains, with one
 * deliberate difference: NO orphan adoption. The same Resend account holds
 * the platform's own outbound domain(s); binding a tenant row to an existing
 * sending domain would hand them production sending infrastructure. A name
 * that already exists in Resend is a 409, not an adoption.
 */

export type SendingDomainResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; code?: string }

/**
 * The shared Resend account has no domain left on its plan (crm#1288). Stable
 * code (structured-errors registry): the settings page keys its explanation on
 * it, and the operators' alert carries it.
 */
export const SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT = 'SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT'

/**
 * Every other Resend failure, by operation (structured-errors registry). The
 * customer gets the registry's Swedish sentence under the code; Resend's own
 * name, status and text are logged for us and never returned.
 */
export const SENDING_DOMAIN_CLAIM_PROVIDER_ERROR = 'SENDING_DOMAIN_CLAIM_PROVIDER_ERROR'
export const SENDING_DOMAIN_VERIFY_PROVIDER_ERROR = 'SENDING_DOMAIN_VERIFY_PROVIDER_ERROR'
export const SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING = 'SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING'
export const SENDING_DOMAIN_REMOVE_PROVIDER_ERROR = 'SENDING_DOMAIN_REMOVE_PROVIDER_ERROR'

type SendingDomainProviderCode =
  | typeof SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT
  | typeof SENDING_DOMAIN_CLAIM_PROVIDER_ERROR
  | typeof SENDING_DOMAIN_VERIFY_PROVIDER_ERROR
  | typeof SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING
  | typeof SENDING_DOMAIN_REMOVE_PROVIDER_ERROR

/** Resend's documented error body: { name, message, statusCode }. */
interface ResendErrorShape {
  name?: string
  message?: string
  statusCode?: number | null
}

/**
 * What Resend said (or what the SDK threw), for the log. Never for the
 * response: its text is English, names provider internals, and once told a
 * customer about our plan's domain count (crm#1288).
 */
function describeProviderError(error: unknown): {
  providerError: string | null
  providerStatus: number | null
  providerMessage: string | null
} {
  if (error instanceof Error) {
    return { providerError: error.name, providerStatus: null, providerMessage: error.message }
  }
  const shape = (error ?? null) as ResendErrorShape | null
  return {
    providerError: shape?.name ?? null,
    providerStatus: shape?.statusCode ?? null,
    providerMessage: shape?.message ?? null,
  }
}

/**
 * A Resend failure as the customer sees it: the registry's sentence and status
 * under its code. The provider's own error is logged with the operation and
 * company; `alert` marks the ones the operators must act on.
 */
function providerFailure(
  code: SendingDomainProviderCode,
  logMessage: string,
  context: { operation: string; companyId: string; alert?: true },
  providerError: unknown,
): { ok: false; status: number; error: string; code: string } {
  log.error(logMessage, { ...context, ...describeProviderError(providerError), code })
  const entry = getErrorEntry(code)
  return {
    ok: false,
    status: entry?.httpStatus ?? 502,
    code,
    error: entry?.message_sv ?? 'E-postleverantören svarade inte som väntat. Försök igen om en stund.',
  }
}

export type DomainCreateRefusal = 'already_registered' | 'plan_limit' | 'other'

/**
 * Why Resend refused POST /domains, read from its documented error shape
 * (resend.com/docs/api-reference/errors).
 *
 * - already_registered: the name is already held. Documented as a 403
 *   validation_error "The example.com domain has been registered already"
 *   (knowledge-base/domain-already-registered); "exist" is the wording this
 *   check matched before and stays matched.
 * - plan_limit: every domain the plan includes is in use (Pro: 10). Resend
 *   answers a plan cap with a 403 validation_error (its inbox cap is
 *   documented with exactly that shape), and the only other 403
 *   validation_error POST /domains documents is already_registered above. The
 *   cap's own wording is not documented, so it is recognised by that shape,
 *   never by its text.
 * - other: anything else (rate limit, outage, a request Resend found invalid).
 */
export function classifyDomainCreateError(error: ResendErrorShape | null | undefined): DomainCreateRefusal {
  const message = error?.message ?? ''
  if (/exist|registered already/i.test(message)) return 'already_registered'
  if (error?.statusCode === 403 && error.name === 'validation_error') return 'plan_limit'
  return 'other'
}

// Public mailbox providers a company can never own. DNS verification is the
// real ownership gate: this list only fails fast with a clear message.
const PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.se',
  'live.com',
  'live.se',
  'msn.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'yahoo.com',
  'ymail.com',
  'protonmail.com',
  'proton.me',
  'fastmail.com',
  'gmx.com',
  'telia.com',
  'comhem.se',
  'spray.se',
  'passagen.se',
])

/**
 * Domains a tenant may never claim as a sending domain: public mailbox
 * providers, and the platform's reserved domains (RESEND_FROM_EMAIL domain,
 * shared inbound domain, app host, plus subdomains; see
 * isReservedSenderDomain, which resolveInvoiceSender enforces again at send
 * time). Returns a Swedish error message, or null when claimable.
 */
export function validateClaimableSendingDomain(domain: string): string | null {
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return 'Publika e-postdomäner (t.ex. Gmail, Outlook) kan inte användas. Ange en domän som bolaget äger.'
  }
  if (isReservedSenderDomain(domain)) {
    return 'Den här domänen är reserverad och kan inte användas som avsändardomän.'
  }
  return null
}

/**
 * Resend's view of a domain must be the domain our row claims. A tenant can
 * delete and re-insert its pending row (same id, different domain) while a
 * claim is mid-flight, so every verification-state write re-checks the name
 * instead of trusting the row id alone.
 */
function resendNameMatchesRow(resendName: string | undefined, rowDomain: string): boolean {
  if (!resendName) return false
  return (normalizeDomainName(resendName) ?? resendName.toLowerCase()) === rowDomain.toLowerCase()
}

// `temporary_failure` is a runtime status the Resend API can still return but
// which the SDK's DomainStatus type dropped: accept it explicitly.
export function mapResendSendingStatus(
  status: DomainStatus | 'temporary_failure',
): CompanySendingDomainStatus {
  switch (status) {
    case 'verified':
      return 'verified'
    // A previously verified domain failed a DNS re-check; Resend keeps it
    // active while it retries (~72h). Keep sending rather than silently
    // flipping every invoice back to the platform sender on a DNS blip.
    case 'temporary_failure':
      return 'verified'
    case 'failed':
    case 'partially_failed':
      return 'failed'
    default:
      return 'pending' // 'pending' | 'not_started' | 'partially_verified'
  }
}

/**
 * Only domains this feature created (sending-only) may be touched in Resend.
 * The platform's own sender domain and the inbox feature's receiving-only
 * domains live in the same account.
 */
export function isSendingOnlyProfile(
  capabilities: { sending?: string; receiving?: string } | null | undefined,
): boolean {
  return capabilities?.sending === 'enabled' && capabilities?.receiving !== 'enabled'
}

export async function getSendingDomain(
  supabase: SupabaseClient,
  companyId: string,
): Promise<CompanySendingDomain | null> {
  const { data, error } = await supabase
    .from('company_sending_domains')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load sending domain: ${error.message}`)
  return (data as CompanySendingDomain | null) ?? null
}

/**
 * Claim a sending domain for the company: insert the row, register the
 * domain in Resend with the sending capability, store the DNS records the
 * user must publish. The DB insert goes first so the unique indexes
 * (lower(domain), company_id) serialize concurrent claims before we ever
 * talk to Resend; every failure after that rolls the row back.
 *
 * Two clients on purpose: `supabase` is the caller's RLS client (proves
 * owner/admin membership on the insert and the rollback delete); `writer` is
 * a service-role client for the verification state (resend_domain_id,
 * dns_records, status), which the tenant guard trigger
 * (20260822130000) refuses from tenant JWTs. Every writer query still filters
 * on company_id: defense in depth, never the only check.
 */
export async function claimSendingDomain(
  supabase: SupabaseClient,
  writer: SupabaseClient,
  companyId: string,
  rawDomain: string,
): Promise<SendingDomainResult<CompanySendingDomain>> {
  const domain = normalizeDomainName(rawDomain)
  if (!domain) {
    return { ok: false, status: 400, error: 'Ogiltig domän. Ange t.ex. dittbolag.se.' }
  }
  const blocked = validateClaimableSendingDomain(domain)
  if (blocked) return { ok: false, status: 400, error: blocked }

  const { data: inserted, error: insertError } = await supabase
    .from('company_sending_domains')
    .insert({ company_id: companyId, domain, status: 'pending' })
    .select('*')
    .single()

  if (insertError || !inserted) {
    if (insertError?.code === '23505') {
      const message = insertError.message.includes('idx_company_sending_domains_company')
        ? 'Bolaget har redan en avsändardomän. Ta bort den innan du lägger till en ny.'
        : 'Domänen är redan registrerad.'
      return { ok: false, status: 409, error: message }
    }
    log.error('sending-domain claim could not insert the row', {
      operation: 'sending-domain.claim',
      companyId,
      dbError: insertError?.message ?? null,
    })
    return { ok: false, status: 500, error: 'Kunde inte spara domänen. Försök igen om en stund.' }
  }

  // Set once Resend has created the domain. From then on a rollback removes
  // it too: left behind, it holds one of the shared account's plan slots with
  // no row pointing at it (crm#1288).
  let resendDomainId: string | null = null
  const rollback = async () => {
    if (resendDomainId) await removeCreatedResendDomain(resendDomainId, companyId, domain)
    await supabase
      .from('company_sending_domains')
      .delete()
      .eq('id', inserted.id)
      .eq('company_id', companyId)
  }
  const claimContext = { operation: 'sending-domain.claim', companyId }

  try {
    const resend = getResendClient()

    // Sending only: receiving stays disabled so the DNS list is DKIM/SPF
    // only and the company's existing MX (their real mailbox) is untouched.
    const created = await resend.domains.create({
      name: domain,
      region: 'eu-west-1',
      capabilities: { sending: 'enabled', receiving: 'disabled' },
    })

    if (created.error || !created.data) {
      await rollback()
      const refusal = classifyDomainCreateError(created.error)
      // No adoption path on purpose (see module comment): an existing name
      // is a conflict the operator resolves, never something a tenant binds.
      if (refusal === 'already_registered') {
        return {
          ok: false,
          status: 409,
          error:
            'Domänen finns redan hos e-postleverantören och kan inte läggas till automatiskt. Kontakta supporten.',
        }
      }
      if (refusal === 'plan_limit') {
        // Every company's domain lives in the one platform account, so this
        // refuses every claim until the plan grows or domains are removed:
        // the operators have to act, the customer cannot.
        return providerFailure(
          SENDING_DOMAIN_CLAIM_PROVIDER_LIMIT,
          'sending-domain claim refused: the Resend account has used every domain its plan includes',
          { ...claimContext, alert: true },
          created.error,
        )
      }
      return providerFailure(
        SENDING_DOMAIN_CLAIM_PROVIDER_ERROR,
        'sending-domain claim refused by Resend',
        claimContext,
        created.error,
      )
    }

    const createdId = created.data.id
    resendDomainId = createdId

    // get() rather than the create response: it returns the same shape with
    // the full DNS record list and the per-record status the UI renders.
    const fetched = await resend.domains.get(createdId)
    if (fetched.error || !fetched.data) {
      await rollback()
      return providerFailure(
        SENDING_DOMAIN_CLAIM_PROVIDER_ERROR,
        'sending-domain claim could not read the DNS records of the domain it created',
        claimContext,
        fetched.error,
      )
    }

    // A freshly created domain has no DNS yet, so it is never verified here;
    // mapping the status anyway keeps the helper honest about what Resend
    // said rather than hardcoding 'pending'.
    const status = mapResendSendingStatus(fetched.data.status)
    // Bind the Resend domain only to the row we inserted, still carrying the
    // domain we registered and not yet bound: a concurrent tenant
    // delete + re-insert under the same id (different domain) matches zero
    // rows, which .single() reports as an error and we roll back below.
    const { data: updated, error: updateError } = await writer
      .from('company_sending_domains')
      .update({
        resend_domain_id: createdId,
        dns_records: fetched.data.records,
        status,
        verified_at: status === 'verified' ? new Date().toISOString() : null,
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', inserted.id)
      .eq('company_id', companyId)
      .eq('domain', domain)
      .is('resend_domain_id', null)
      .select('*')
      .single()

    if (updateError || !updated) {
      await rollback()
      log.error('sending-domain claim could not store the DNS records', {
        ...claimContext,
        dbError: updateError?.message ?? null,
      })
      return { ok: false, status: 500, error: 'Kunde inte spara domänen. Försök igen om en stund.' }
    }

    return { ok: true, data: updated as CompanySendingDomain }
  } catch (err) {
    // A throw (network, SDK, configuration) at any step: the domain Resend
    // may already have created goes too, not only the row.
    await rollback()
    return providerFailure(SENDING_DOMAIN_CLAIM_PROVIDER_ERROR, 'sending-domain claim failed', claimContext, err)
  }
}

/**
 * Removes the Resend domain a claim created moments ago, after a later step
 * of that claim failed. Resend reports a refused removal as `{ error }`, not
 * a throw, so both are checked (a 404 means it is already gone). When it
 * cannot be removed the domain is orphaned in the shared account: an
 * alert-flagged log names it for an operator to remove by hand.
 */
async function removeCreatedResendDomain(resendDomainId: string, companyId: string, domain: string): Promise<void> {
  let failure: unknown
  try {
    const removed = await getResendClient().domains.remove(resendDomainId)
    if (!removed.error || removed.error.statusCode === 404) return
    failure = removed.error
  } catch (err) {
    failure = err
  }
  log.error('sending-domain claim rollback could not remove the Resend domain it created; remove it by hand', {
    operation: 'sending-domain.claim.rollback',
    companyId,
    domain,
    resendDomainId,
    ...describeProviderError(failure),
    alert: true,
  })
}

/**
 * Resend statuses with no DNS check running and none passed: the only ones a
 * check should (re)start for. A pending check keeps running on Resend's side.
 */
function needsVerificationRun(status: DomainStatus | 'temporary_failure'): boolean {
  return status === 'not_started' || status === 'failed' || status === 'partially_failed'
}

/**
 * Re-check verification with Resend and persist the outcome. Resend's state
 * is read first: verify() starts an asynchronous DNS check, and a get() right
 * after it reads that check as pending, so verifying on every check kept the
 * stored status at pending even with correct DNS (crm#1044). verify() runs
 * only when no check is running or the last one failed.
 */
export async function checkSendingDomainVerification(
  supabase: SupabaseClient,
  writer: SupabaseClient,
  companyId: string,
): Promise<SendingDomainResult<CompanySendingDomain>> {
  const row = await getSendingDomain(supabase, companyId)
  if (!row) return { ok: false, status: 404, error: 'Ingen avsändardomän är registrerad.' }
  if (!row.resend_domain_id) {
    return {
      ok: false,
      status: 409,
      error: 'Domänen saknar koppling till e-postleverantören. Ta bort den och lägg till den igen.',
    }
  }

  const verifyContext = { operation: 'sending-domain.verify', companyId }
  try {
    const resend = getResendClient()
    let fetched = await resend.domains.get(row.resend_domain_id)
    if (fetched.data && needsVerificationRun(fetched.data.status)) {
      await resend.domains.verify(row.resend_domain_id)
      fetched = await resend.domains.get(row.resend_domain_id)
    }
    if (fetched.error || !fetched.data) {
      // 404: the domain was removed on Resend's side (by hand, to free a plan
      // slot). Checking again never helps; claiming it again does.
      if (fetched.error?.statusCode === 404) {
        return providerFailure(
          SENDING_DOMAIN_VERIFY_PROVIDER_DOMAIN_MISSING,
          'sending-domain check: Resend no longer has the domain',
          verifyContext,
          fetched.error,
        )
      }
      return providerFailure(
        SENDING_DOMAIN_VERIFY_PROVIDER_ERROR,
        'sending-domain check failed at Resend',
        verifyContext,
        fetched.error,
      )
    }

    // A domain without the sending capability can never carry outbound
    // mail: fail loudly instead of ever flipping such a row to verified.
    if (fetched.data.capabilities?.sending !== 'enabled') {
      return {
        ok: false,
        status: 409,
        error:
          'Domänen är inte konfigurerad för utskick hos e-postleverantören. Ta bort den och lägg till den igen.',
      }
    }
    if (!resendNameMatchesRow(fetched.data.name, row.domain)) {
      return {
        ok: false,
        status: 409,
        error: 'Domänen stämmer inte med e-postleverantörens registrering. Ta bort den och lägg till den igen.',
      }
    }

    const status = mapResendSendingStatus(fetched.data.status)
    const { data: updated, error: updateError } = await writer
      .from('company_sending_domains')
      .update({
        status,
        dns_records: fetched.data.records,
        last_checked_at: new Date().toISOString(),
        verified_at: status === 'verified' ? (row.verified_at ?? new Date().toISOString()) : row.verified_at,
      })
      .eq('id', row.id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (updateError || !updated) {
      log.error('sending-domain check could not store the status', {
        ...verifyContext,
        dbError: updateError?.message ?? null,
      })
      return { ok: false, status: 500, error: 'Kunde inte spara status. Försök igen om en stund.' }
    }
    return { ok: true, data: updated as CompanySendingDomain }
  } catch (err) {
    return providerFailure(SENDING_DOMAIN_VERIFY_PROVIDER_ERROR, 'sending-domain check failed', verifyContext, err)
  }
}

export interface SendingDomainSettingsPatch {
  sender_local_part?: string
  sender_name?: string | null
  enabled?: boolean
}

/** Update the From address local part, display name, or the enabled toggle. */
export async function updateSendingDomainSettings(
  supabase: SupabaseClient,
  companyId: string,
  patch: SendingDomainSettingsPatch,
): Promise<SendingDomainResult<CompanySendingDomain>> {
  const row = await getSendingDomain(supabase, companyId)
  if (!row) return { ok: false, status: 404, error: 'Ingen avsändardomän är registrerad.' }

  // Literal payload (keys visible to the schema guard); undefined values are
  // dropped by JSON serialization, so an omitted field is left untouched
  // while an explicit null clears sender_name.
  let senderLocalPart: string | undefined
  if (patch.sender_local_part !== undefined) {
    const local = normalizeSenderLocalPart(patch.sender_local_part)
    if (!local) {
      return {
        ok: false,
        status: 400,
        error: 'Ogiltig avsändaradress. Använd små bokstäver, siffror, punkt, bindestreck eller understreck.',
      }
    }
    senderLocalPart = local
  }
  let senderName: string | null | undefined
  if (patch.sender_name !== undefined) {
    const name = patch.sender_name === null ? null : patch.sender_name.replace(/[\r\n<>]/g, '').trim()
    if (name !== null && (name.length === 0 || name.length > 120)) {
      return { ok: false, status: 400, error: 'Avsändarnamnet måste vara 1 till 120 tecken.' }
    }
    senderName = name
  }
  if (senderLocalPart === undefined && senderName === undefined && patch.enabled === undefined) {
    return { ok: true, data: row }
  }

  const { data: updated, error } = await supabase
    .from('company_sending_domains')
    .update({
      sender_local_part: senderLocalPart,
      sender_name: senderName,
      enabled: patch.enabled,
    })
    .eq('id', row.id)
    .eq('company_id', companyId)
    .select('*')
    .single()

  if (error || !updated) {
    return { ok: false, status: 500, error: error?.message ?? 'Kunde inte spara inställningen.' }
  }
  return { ok: true, data: updated as CompanySendingDomain }
}

/**
 * Remove the sending domain: delete it from Resend first, then the row.
 * Only Resend domains this feature created (sending-only profile) are ever
 * removed; anything else (a legacy row somehow bound to the platform sender
 * or to an inbox domain) just drops the DB row and leaves Resend alone.
 */
export async function removeSendingDomain(
  supabase: SupabaseClient,
  companyId: string,
): Promise<SendingDomainResult<{ removed: true }>> {
  const row = await getSendingDomain(supabase, companyId)
  if (!row) return { ok: false, status: 404, error: 'Ingen avsändardomän är registrerad.' }

  // Every refusal below keeps the row, so the customer can simply try again:
  // dropping it while the Resend domain stays would orphan a plan slot.
  const removeContext = { operation: 'sending-domain.remove', companyId }
  if (row.resend_domain_id) {
    try {
      const resend = getResendClient()
      const fetched = await resend.domains.get(row.resend_domain_id)
      if (fetched.error && fetched.error.statusCode !== 404) {
        return providerFailure(
          SENDING_DOMAIN_REMOVE_PROVIDER_ERROR,
          'sending-domain removal could not read the domain at Resend',
          removeContext,
          fetched.error,
        )
      }
      if (
        fetched.data &&
        isSendingOnlyProfile(fetched.data.capabilities) &&
        !validateClaimableSendingDomain(normalizeDomainName(fetched.data.name) ?? fetched.data.name)
      ) {
        const removed = await resend.domains.remove(row.resend_domain_id)
        if (removed.error && removed.error.statusCode !== 404) {
          return providerFailure(
            SENDING_DOMAIN_REMOVE_PROVIDER_ERROR,
            'sending-domain removal refused by Resend',
            removeContext,
            removed.error,
          )
        }
      }
    } catch (err) {
      return providerFailure(SENDING_DOMAIN_REMOVE_PROVIDER_ERROR, 'sending-domain removal failed', removeContext, err)
    }
  }

  const { error } = await supabase
    .from('company_sending_domains')
    .delete()
    .eq('id', row.id)
    .eq('company_id', companyId)

  if (error) {
    log.error('sending-domain removal could not delete the row', { ...removeContext, dbError: error.message })
    return { ok: false, status: 500, error: 'Kunde inte ta bort domänen. Försök igen om en stund.' }
  }
  return { ok: true, data: { removed: true } }
}

/**
 * Outcome of applying a domain webhook event. The route maps `error` to an
 * HTTP 500 so Resend (Svix) retries; `no_match` is acknowledged with 200
 * because the event belongs to a domain this table does not track (platform
 * sender, inbox domains) and retrying would never change that.
 */
export type WebhookApplyOutcome = 'applied' | 'no_match' | 'error'

/**
 * Applies a Resend `domain.updated` webhook event so verification flips
 * without the user pressing "Kontrollera igen".
 *
 * The event's status carries no capability breakdown, so before flipping a
 * row to verified the sending capability is confirmed with Resend; on a
 * failed lookup the stored status is kept (the manual check remains).
 */
export async function applySendingDomainStatusFromWebhook(
  supabase: SupabaseClient,
  event: { id: string; status: string; records?: unknown },
): Promise<WebhookApplyOutcome> {
  const { data: row, error: lookupError } = await supabase
    .from('company_sending_domains')
    .select('id, domain, verified_at')
    .eq('resend_domain_id', event.id)
    .maybeSingle()

  if (lookupError) return 'error'
  if (!row) return 'no_match'
  const current = row as { id: string; domain: string; verified_at: string | null }

  const status = mapResendSendingStatus(event.status as DomainStatus)

  if (status === 'verified') {
    // Confirm with Resend that the domain can send AND is still the domain
    // the row claims before flipping to verified (see resendNameMatchesRow).
    let sendingConfirmed = false
    try {
      const fetched = await getResendClient().domains.get(event.id)
      sendingConfirmed =
        !fetched.error &&
        fetched.data?.capabilities?.sending === 'enabled' &&
        resendNameMatchesRow(fetched.data?.name, current.domain)
    } catch {
      sendingConfirmed = false
    }
    if (!sendingConfirmed) {
      // Literal payload: an undefined dns_records is dropped by JSON
      // serialization, so the stored records survive an event without any.
      const { error } = await supabase
        .from('company_sending_domains')
        .update({
          dns_records: event.records,
          last_checked_at: new Date().toISOString(),
        })
        .eq('id', current.id)
      return error ? 'error' : 'applied'
    }
  }

  const { error } = await supabase
    .from('company_sending_domains')
    .update({
      status,
      dns_records: event.records,
      last_checked_at: new Date().toISOString(),
      verified_at:
        status === 'verified' ? (current.verified_at ?? new Date().toISOString()) : current.verified_at,
    })
    .eq('id', current.id)

  return error ? 'error' : 'applied'
}
