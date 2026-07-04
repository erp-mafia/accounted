import { Resend } from 'resend'
import type { Domain, DomainStatus } from 'resend'
import { domainToASCII } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CompanyInboundDomain, CompanyInboundDomainStatus } from '@/types'

function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')
  return new Resend(apiKey)
}

export type CustomDomainResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string }

// Public mailbox providers a company can never own. DNS verification is the
// real ownership gate: this list only exists to fail fast with a clear
// message instead of a claim that can never verify.
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

// Accepts what users actually paste ("Faktura.Hansbolag.SE.", a full URL, or
// an email address) and reduces it to a lowercased, punycoded hostname.
// Returns null when no valid hostname can be extracted.
export function normalizeInboundDomain(raw: string): string | null {
  let value = String(raw ?? '').trim().toLowerCase()
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // strip scheme
  value = value.split('/')[0].split('?')[0]
  const atIndex = value.lastIndexOf('@')
  if (atIndex !== -1) value = value.slice(atIndex + 1)
  value = value.replace(/^\.+|\.+$/g, '')
  if (!value) return null

  // IDN → punycode (blåbär.se → xn--blbr-noab.se). Returns '' when the input
  // is not a valid domain.
  const ascii = domainToASCII(value)
  if (!ascii) return null

  return isValidHostname(ascii) ? ascii : null
}

function isValidHostname(domain: string): boolean {
  if (domain.length < 4 || domain.length > 253) return false
  const labels = domain.split('.')
  if (labels.length < 2) return false
  if (!labels.every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return false
  // TLD must contain a letter: rejects IP addresses and all-numeric TLDs.
  return /[a-z]/.test(labels[labels.length - 1])
}

// Returns a Swedish error message when the domain must not be claimed, or
// null when it is claimable. Blocks public mailbox providers, the shared
// inbound domain (and its subdomains), and the app's own domain.
export function validateClaimableDomain(domain: string): string | null {
  if (PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return 'Publika e-postdomäner (t.ex. Gmail, Outlook) kan inte användas. Ange en domän som bolaget äger.'
  }

  const reserved: string[] = []
  const shared = process.env.RESEND_INBOUND_DOMAIN?.toLowerCase()
  if (shared) reserved.push(shared)
  try {
    const appHost = new URL(process.env.NEXT_PUBLIC_APP_URL ?? '').hostname.toLowerCase()
    if (appHost) reserved.push(appHost)
  } catch {
    // No parseable app URL: nothing extra to reserve.
  }

  for (const r of reserved) {
    if (domain === r || domain.endsWith(`.${r}`)) {
      return 'Den här domänen är reserverad och kan inte användas som egen domän.'
    }
  }
  return null
}

// `temporary_failure` is a runtime status the Resend API can still return but
// which the SDK's DomainStatus type dropped in 6.16.0: accept it explicitly.
export function mapResendDomainStatus(
  status: DomainStatus | 'temporary_failure',
): CompanyInboundDomainStatus {
  switch (status) {
    case 'verified':
      return 'verified'
    // temporary_failure = a previously verified domain failed a DNS re-check;
    // Resend keeps the domain active while it retries (~72h). Keep routing
    // rather than silently dropping the customer's invoices on a DNS blip.
    case 'temporary_failure':
      return 'verified'
    case 'failed':
      return 'failed'
    default:
      return 'pending' // 'pending' | 'not_started'
  }
}

// Status to persist when a claim first registers OR adopts a domain in Resend.
// A freshly-created domain has no DNS yet, so it is always unverified. An
// ADOPTED orphan (left by a crashed earlier claim, or freed by a deleted
// company whose Resend domain was never cleaned up) may still report 'verified'
// from a previous owner: NEVER inherit that. Force the new claimant to re-prove
// DNS control via checkCustomDomainVerification() before any mail routes;
// otherwise a different tenant could re-claim a freed domain and silently
// inherit routing for mail the original owner's MX still delegates to Resend.
// Kept pure so the security rule is unit-testable.
export function resolveClaimedDomainStatus(
  wasAdopted: boolean,
  resendStatus: DomainStatus | 'temporary_failure',
): CompanyInboundDomainStatus {
  return wasAdopted ? 'pending' : mapResendDomainStatus(resendStatus)
}

// Only domains this feature created (receiving-only) may ever be adopted,
// verified, or deleted from Resend here. The same Resend account also holds
// the platform's OUTBOUND domains (e.g. the invoiceservice@ sender): adopting
// one binds a tenant row to production sending infrastructure, and removing
// one would kill outbound mail for every customer.
export function isReceivingOnlyProfile(
  capabilities: { sending?: string; receiving?: string } | null | undefined
): boolean {
  return capabilities?.receiving === 'enabled' && capabilities?.sending === 'disabled'
}

export async function getCustomDomain(
  supabase: SupabaseClient,
  companyId: string
): Promise<CompanyInboundDomain | null> {
  const { data, error } = await supabase
    .from('company_inbound_domains')
    .select('*')
    .eq('company_id', companyId)
    .maybeSingle()

  if (error) throw new Error(`Failed to load custom domain: ${error.message}`)
  return (data as CompanyInboundDomain | null) ?? null
}

// A claim that crashed between the Resend create and the row update leaves an
// orphan domain in our Resend account. On the next claim attempt the create
// fails ("already exists"): adopt the existing Resend domain instead of
// dead-ending the user. Safe because removeCustomDomain() never deletes the
// DB row while the domain still exists in Resend, so an adoptable domain can
// never belong to another live company_inbound_domains row.
async function findExistingResendDomain(resend: Resend, domain: string): Promise<Domain | null> {
  let after: string | undefined
  for (let page = 0; page < 10; page++) {
    const { data, error } = await resend.domains.list(
      after ? { limit: 100, after } : { limit: 100 }
    )
    if (error || !data) return null
    // `domain` is already normalized (lowercased, punycoded): run Resend's
    // name through the same normalization so an IDN stored in unicode form
    // still matches.
    const hit = data.data.find((d) => (normalizeInboundDomain(d.name) ?? d.name.toLowerCase()) === domain)
    if (hit) return hit
    if (!data.has_more || data.data.length === 0) return null
    after = data.data[data.data.length - 1].id
  }
  return null
}

// Claim a custom inbound domain for the company: insert the row, register the
// domain in our Resend account with the receiving capability, and store the
// DNS records the user must publish. The DB insert goes first so the unique
// indexes ((lower(domain)) and (company_id)) serialize concurrent claims
// before we ever talk to Resend.
export async function claimCustomDomain(
  supabase: SupabaseClient,
  companyId: string,
  rawDomain: string
): Promise<CustomDomainResult<CompanyInboundDomain>> {
  const domain = normalizeInboundDomain(rawDomain)
  if (!domain) {
    return { ok: false, status: 400, error: 'Ogiltig domän. Ange t.ex. faktura.dittbolag.se.' }
  }
  const blocked = validateClaimableDomain(domain)
  if (blocked) return { ok: false, status: 400, error: blocked }

  const { data: inserted, error: insertError } = await supabase
    .from('company_inbound_domains')
    .insert({ company_id: companyId, domain, status: 'pending' })
    .select('*')
    .single()

  if (insertError || !inserted) {
    if (insertError?.code === '23505') {
      const message = insertError.message.includes('idx_company_inbound_domains_company')
        ? 'Bolaget har redan en egen domän. Ta bort den innan du lägger till en ny.'
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
      .from('company_inbound_domains')
      .delete()
      .eq('id', inserted.id)
      .eq('company_id', companyId)
  }

  try {
    const resend = getResend()

    // Receiving only: we never send from the customer's domain, and skipping
    // the sending capability keeps the DNS record list minimal.
    let resendDomainId: string
    let wasAdopted = false
    const created = await resend.domains.create({
      name: domain,
      region: 'eu-west-1',
      capabilities: { receiving: 'enabled', sending: 'disabled' },
    })

    if (created.error || !created.data) {
      const adopted = await findExistingResendDomain(resend, domain)
      if (!adopted) {
        await rollback()
        return {
          ok: false,
          status: 502,
          error: `Kunde inte registrera domänen hos e-postleverantören: ${created.error?.message ?? 'okänt fel'}`,
        }
      }
      // Never adopt a domain this feature didn't create: e.g. the platform's
      // own outbound (sending) domains, which live in the same Resend account.
      if (!isReceivingOnlyProfile(adopted.capabilities)) {
        await rollback()
        return {
          ok: false,
          status: 409,
          error:
            'Domänen används redan för e-postutskick i plattformen och kan inte användas som inkorgsdomän. Använd en underdomän i stället.',
        }
      }
      resendDomainId = adopted.id
      wasAdopted = true
    } else {
      resendDomainId = created.data.id
    }

    // get() rather than the create response: on the adoption path we have no
    // records yet, and get() returns the same shape either way.
    const fetched = await resend.domains.get(resendDomainId)
    if (fetched.error || !fetched.data) {
      await rollback()
      return {
        ok: false,
        status: 502,
        error: `Kunde inte hämta DNS-poster: ${fetched.error?.message ?? 'okänt fel'}`,
      }
    }

    // Adopted orphans never inherit 'verified': see resolveClaimedDomainStatus.
    const status = resolveClaimedDomainStatus(wasAdopted, fetched.data.status)
    const { data: updated, error: updateError } = await supabase
      .from('company_inbound_domains')
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
      await rollback()
      return { ok: false, status: 500, error: updateError?.message ?? 'Kunde inte spara DNS-poster.' }
    }

    return { ok: true, data: updated as CompanyInboundDomain }
  } catch (err) {
    await rollback()
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Domänregistreringen misslyckades.',
    }
  }
}

// Re-check verification with Resend and persist the outcome. verify() kicks
// off Resend's DNS check; get() reads the (possibly updated) status and the
// per-record state shown in the UI.
export async function checkCustomDomainVerification(
  supabase: SupabaseClient,
  companyId: string
): Promise<CustomDomainResult<CompanyInboundDomain>> {
  const row = await getCustomDomain(supabase, companyId)
  if (!row) return { ok: false, status: 404, error: 'Ingen egen domän är registrerad.' }
  if (!row.resend_domain_id) {
    return { ok: false, status: 409, error: 'Domänen saknar koppling till e-postleverantören. Ta bort den och lägg till den igen.' }
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

    // A domain without the receiving capability can never take inbound mail:
    // Resend's 'verified' there only reflects sending records. Fail loudly
    // instead of ever flipping such a row to verified (guards legacy rows
    // bound to a sending domain before the adopt-profile check existed).
    if (fetched.data.capabilities?.receiving !== 'enabled') {
      return {
        ok: false,
        status: 409,
        error:
          'Domänen är inte konfigurerad för mottagning hos e-postleverantören. Ta bort den och använd en underdomän i stället.',
      }
    }

    const status = mapResendDomainStatus(fetched.data.status)
    const { data: updated, error: updateError } = await supabase
      .from('company_inbound_domains')
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
    return { ok: true, data: updated as CompanyInboundDomain }
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: err instanceof Error ? err.message : 'Kontrollen misslyckades.',
    }
  }
}

// Remove the custom domain: delete it from Resend first, then the row.
// Order matters: the row is only deleted once the domain is confirmed gone
// from Resend (or was never there). Deleting the row while a verified domain
// lingers in our Resend account would let a later claim adopt a domain whose
// MX still receives someone else's mail.
export async function removeCustomDomain(
  supabase: SupabaseClient,
  companyId: string
): Promise<CustomDomainResult<{ removed: true }>> {
  const row = await getCustomDomain(supabase, companyId)
  if (!row) return { ok: false, status: 404, error: 'Ingen egen domän är registrerad.' }

  if (row.resend_domain_id) {
    try {
      const resend = getResend()
      // Only delete Resend domains this feature created (receiving-only). A
      // row bound to anything else (pre-guard legacy, e.g. an outbound
      // sending domain) must never take production infrastructure down with
      // it: skip the Resend removal and just drop the row. Safe, because
      // the adopt path refuses non-receiving-only domains, so the leftover
      // Resend domain is not adoptable by another company.
      const fetched = await resend.domains.get(row.resend_domain_id)
      if (fetched.error && fetched.error.statusCode !== 404) {
        return {
          ok: false,
          status: 502,
          error: `Kunde inte kontrollera domänen hos e-postleverantören: ${fetched.error.message}`,
        }
      }
      if (fetched.data && isReceivingOnlyProfile(fetched.data.capabilities)) {
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

  const { error: deleteError } = await supabase
    .from('company_inbound_domains')
    .delete()
    .eq('id', row.id)
    .eq('company_id', companyId)

  if (deleteError) return { ok: false, status: 500, error: deleteError.message }
  return { ok: true, data: { removed: true } }
}

// Webhook-side lookup: given the recipient domains of an inbound email,
// return the owning company for the first verified match (recipient order
// preserved). Catch-all by design: any local part on a verified domain
// routes to the company, so a supplier typing fakturor@ instead of faktura@
// still lands instead of silently vanishing (Resend has already accepted the
// message at SMTP; there is no bounce path).
export async function findCompanyForRecipientDomains(
  supabase: SupabaseClient,
  recipientDomains: string[]
): Promise<{ companyId: string; domain: string } | null> {
  const unique = [...new Set(recipientDomains.map((d) => d.toLowerCase()))]
  if (unique.length === 0) return null

  const { data, error } = await supabase
    .from('company_inbound_domains')
    .select('company_id, domain')
    .in('domain', unique)
    .eq('status', 'verified')

  if (error || !data || data.length === 0) return null

  const byDomain = new Map(
    (data as Array<{ company_id: string; domain: string }>).map((r) => [r.domain.toLowerCase(), r])
  )
  for (const d of unique) {
    const hit = byDomain.get(d)
    if (hit) return { companyId: hit.company_id, domain: hit.domain }
  }
  return null
}

// Applies a Resend `domain.updated` webhook event so verification flips
// without the user pressing "Kontrollera igen". No-op when the domain id is
// unknown (e.g. the account's sending domains). Returns whether a row matched.
export async function applyDomainStatusFromWebhook(
  supabase: SupabaseClient,
  event: { id: string; status: string; records?: unknown }
): Promise<boolean> {
  const { data: row } = await supabase
    .from('company_inbound_domains')
    .select('id, verified_at')
    .eq('resend_domain_id', event.id)
    .maybeSingle()

  if (!row) return false

  const status = mapResendDomainStatus(event.status as DomainStatus)

  // The event's 'verified' is the domain's mixed sending/receiving status:
  // it carries no capability breakdown, so it can reflect sending-only
  // records. Mirror checkCustomDomainVerification: confirm the receiving
  // capability with Resend before ever flipping a row to verified. On a
  // failed lookup or a sending-only profile, keep the stored status (the
  // manual "Kontrollera igen" path remains available): fail closed, never
  // route inbound mail off an unproven capability.
  if (status === 'verified') {
    let receivingConfirmed = false
    try {
      const fetched = await getResend().domains.get(event.id)
      receivingConfirmed =
        !fetched.error && fetched.data?.capabilities?.receiving === 'enabled'
    } catch {
      receivingConfirmed = false
    }
    if (!receivingConfirmed) {
      const { error } = await supabase
        .from('company_inbound_domains')
        .update({
          ...(event.records !== undefined ? { dns_records: event.records } : {}),
          last_checked_at: new Date().toISOString(),
        })
        .eq('id', (row as { id: string }).id)
      return !error
    }
  }
  const { error } = await supabase
    .from('company_inbound_domains')
    .update({
      status,
      ...(event.records !== undefined ? { dns_records: event.records } : {}),
      last_checked_at: new Date().toISOString(),
      verified_at:
        status === 'verified'
          ? ((row as { verified_at: string | null }).verified_at ?? new Date().toISOString())
          : (row as { verified_at: string | null }).verified_at,
    })
    .eq('id', (row as { id: string }).id)

  return !error
}
