import { Resend } from 'resend'
import type { DomainStatus } from 'resend'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanySendingDomain, CompanySendingDomainStatus } from '@/types'
import { normalizeDomainName, normalizeSenderLocalPart } from '@/lib/email/domain-name'

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

function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')
  return new Resend(apiKey)
}

export type SendingDomainResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

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

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new URL(value).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/**
 * Domains a tenant may never claim as a sending domain: public mailbox
 * providers, the platform's own sender domain (RESEND_FROM_EMAIL), the
 * shared inbound domain, and the app host (plus subdomains of each).
 * Returns a Swedish error message, or null when claimable.
 */
export function validateClaimableSendingDomain(domain: string): string | null {
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return 'Publika e-postdomäner (t.ex. Gmail, Outlook) kan inte användas. Ange en domän som bolaget äger.'
  }

  const reserved: string[] = []
  const fromEmail = process.env.RESEND_FROM_EMAIL
  const fromDomain = fromEmail ? normalizeDomainName(fromEmail) : null
  if (fromDomain) reserved.push(fromDomain)
  const inbound = process.env.RESEND_INBOUND_DOMAIN?.toLowerCase()
  if (inbound) reserved.push(inbound)
  const appHost = hostnameOf(process.env.NEXT_PUBLIC_APP_URL)
  if (appHost) reserved.push(appHost)

  for (const r of reserved) {
    if (domain === r || domain.endsWith(`.${r}`)) {
      return 'Den här domänen är reserverad och kan inte användas som avsändardomän.'
    }
  }
  return null
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
    return {
      ok: false,
      status: 500,
      error: insertError?.message ?? 'Kunde inte spara domänen.',
    }
  }

  const rollback = async () => {
    await supabase
      .from('company_sending_domains')
      .delete()
      .eq('id', inserted.id)
      .eq('company_id', companyId)
  }

  try {
    const resend = getResend()

    // Sending only: receiving stays disabled so the DNS list is DKIM/SPF
    // only and the company's existing MX (their real mailbox) is untouched.
    const created = await resend.domains.create({
      name: domain,
      region: 'eu-west-1',
      capabilities: { sending: 'enabled', receiving: 'disabled' },
    })

    if (created.error || !created.data) {
      await rollback()
      // No adoption path on purpose (see module comment): an existing name
      // is a conflict the operator resolves, never something a tenant binds.
      const conflict = /exist/i.test(created.error?.message ?? '')
      return conflict
        ? {
            ok: false,
            status: 409,
            error:
              'Domänen finns redan hos e-postleverantören och kan inte läggas till automatiskt. Kontakta supporten.',
          }
        : {
            ok: false,
            status: 502,
            error: `Kunde inte registrera domänen hos e-postleverantören: ${created.error?.message ?? 'okänt fel'}`,
          }
    }

    const resendDomainId = created.data.id

    // get() rather than the create response: it returns the same shape with
    // the full DNS record list and the per-record status the UI renders.
    const fetched = await resend.domains.get(resendDomainId)
    if (fetched.error || !fetched.data) {
      await resend.domains.remove(resendDomainId).catch(() => undefined)
      await rollback()
      return {
        ok: false,
        status: 502,
        error: `Kunde inte hämta DNS-poster: ${fetched.error?.message ?? 'okänt fel'}`,
      }
    }

    // A freshly created domain has no DNS yet, so it is never verified here;
    // mapping the status anyway keeps the helper honest about what Resend
    // said rather than hardcoding 'pending'.
    const status = mapResendSendingStatus(fetched.data.status)
    const { data: updated, error: updateError } = await writer
      .from('company_sending_domains')
      .update({
        resend_domain_id: resendDomainId,
        dns_records: fetched.data.records,
        status,
        verified_at: status === 'verified' ? new Date().toISOString() : null,
        last_checked_at: new Date().toISOString(),
      })
      .eq('id', inserted.id)
      .eq('company_id', companyId)
      .select('*')
      .single()

    if (updateError || !updated) {
      await resend.domains.remove(resendDomainId).catch(() => undefined)
      await rollback()
      return { ok: false, status: 500, error: updateError?.message ?? 'Kunde inte spara DNS-poster.' }
    }

    return { ok: true, data: updated as CompanySendingDomain }
  } catch (err) {
    await rollback()
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Domänregistreringen misslyckades.',
    }
  }
}

/**
 * Re-check verification with Resend and persist the outcome. verify() kicks
 * off Resend's DNS check; get() reads the (possibly updated) status and the
 * per-record state shown in the UI.
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

  try {
    const resend = getResend()
    await resend.domains.verify(row.resend_domain_id)
    const fetched = await resend.domains.get(row.resend_domain_id)
    if (fetched.error || !fetched.data) {
      return {
        ok: false,
        status: 502,
        error: `Kunde inte kontrollera domänen: ${fetched.error?.message ?? 'okänt fel'}`,
      }
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
      return { ok: false, status: 500, error: updateError?.message ?? 'Kunde inte spara status.' }
    }
    return { ok: true, data: updated as CompanySendingDomain }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Kontrollen misslyckades.',
    }
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

  if (row.resend_domain_id) {
    try {
      const resend = getResend()
      const fetched = await resend.domains.get(row.resend_domain_id)
      if (fetched.error && fetched.error.statusCode !== 404) {
        return {
          ok: false,
          status: 502,
          error: `Kunde inte kontrollera domänen hos e-postleverantören: ${fetched.error.message}`,
        }
      }
      if (
        fetched.data &&
        isSendingOnlyProfile(fetched.data.capabilities) &&
        !validateClaimableSendingDomain(normalizeDomainName(fetched.data.name) ?? fetched.data.name)
      ) {
        const removed = await resend.domains.remove(row.resend_domain_id)
        if (removed.error && removed.error.statusCode !== 404) {
          return {
            ok: false,
            status: 502,
            error: `Kunde inte ta bort domänen hos e-postleverantören: ${removed.error.message}`,
          }
        }
      }
    } catch (err) {
      return {
        ok: false,
        status: 502,
        error: err instanceof Error ? err.message : 'Borttagningen misslyckades.',
      }
    }
  }

  const { error } = await supabase
    .from('company_sending_domains')
    .delete()
    .eq('id', row.id)
    .eq('company_id', companyId)

  if (error) return { ok: false, status: 500, error: error.message }
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
    .select('id, verified_at')
    .eq('resend_domain_id', event.id)
    .maybeSingle()

  if (lookupError) return 'error'
  if (!row) return 'no_match'
  const current = row as { id: string; verified_at: string | null }

  const status = mapResendSendingStatus(event.status as DomainStatus)

  if (status === 'verified') {
    let sendingConfirmed = false
    try {
      const fetched = await getResend().domains.get(event.id)
      sendingConfirmed = !fetched.error && fetched.data?.capabilities?.sending === 'enabled'
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
