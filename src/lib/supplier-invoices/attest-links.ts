/**
 * The attest mail's Godkänn / Neka link: when an invoice that needs attest is
 * registered, each attester gets a mail with a link to /attest/<token>, where
 * they see the invoice (its PDF and amount) and decide without logging in.
 *
 * The token is a credential, treated like the signatory link's
 * (lib/bank-feed/invites.ts): 32 random bytes, sha256-hashed at rest, valid
 * 7 days, one per attester per invoice, consumed by the decision. A rejection
 * by anyone ends the round and consumes every open link of the invoice
 * (attest-service.ts). The decision is recorded as the attester's, with
 * source 'email_link', through the same service as the dashboard.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { generateInviteToken, hashInviteToken, isValidInviteTokenFormat } from '@/lib/bank-feed/invites'

export const ATTEST_LINK_TTL_DAYS = 7

export interface AttestLinkRow {
  id: string
  company_id: string
  supplier_invoice_id: string
  attester_user_id: string
  expires_at: string
  mail_sent_at: string | null
  consumed_at: string | null
  created_at: string
}

const LINK_COLUMNS = 'id, company_id, supplier_invoice_id, attester_user_id, expires_at, mail_sent_at, consumed_at, created_at'

export { isValidInviteTokenFormat as isValidAttestTokenFormat }

/** The page an attester opens: `<base>/attest/<token>`, with the decision the mail's button chose. */
export function attestLinkUrl(baseUrl: string, token: string, decision?: 'approve' | 'reject'): string {
  const url = `${baseUrl.replace(/\/+$/, '')}/attest/${token}`
  return decision ? `${url}?beslut=${decision === 'approve' ? 'godkann' : 'neka'}` : url
}

export function attestLinkExpiresAt(now: number = Date.now()): string {
  return new Date(now + ATTEST_LINK_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

export interface MintedAttestLink {
  link_id: string
  /** The clear token. Only the URL and the mail carry it; never store or log it. */
  token: string
  expires_at: string
}

/**
 * A new link for one attester on one invoice. An open link of the same pair
 * is consumed first: the database keeps one open link per pair, and the
 * newest mail is the one that works.
 */
export async function mintAttestLink(
  service: SupabaseClient,
  input: { companyId: string; invoiceId: string; attesterUserId: string; now?: number },
): Promise<MintedAttestLink> {
  const now = input.now ?? Date.now()
  const { error: supersedeError } = await service
    .from('supplier_invoice_attest_links')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('company_id', input.companyId)
    .eq('supplier_invoice_id', input.invoiceId)
    .eq('attester_user_id', input.attesterUserId)
    .is('consumed_at', null)
  if (supersedeError) throw supersedeError
  const { token, hash } = generateInviteToken()
  const expiresAt = attestLinkExpiresAt(now)
  const { data, error } = await service
    .from('supplier_invoice_attest_links')
    .insert({
      company_id: input.companyId,
      supplier_invoice_id: input.invoiceId,
      attester_user_id: input.attesterUserId,
      token_hash: hash,
      expires_at: expiresAt,
    })
    .select('id')
    .single()
  if (error || !data) throw error ?? new Error('Attest link not stored')
  return { link_id: (data as { id: string }).id, token, expires_at: expiresAt }
}

export type ResolveAttestLinkResult =
  | { ok: true; link: AttestLinkRow }
  | { ok: false; reason: 'invalid_format' | 'not_found' | 'expired' | 'consumed' }

/**
 * Resolve a clear token from the public surface (service-role client; the
 * token is the only guard: strict hash equality, then expiry and use). Never
 * log the token.
 */
export async function resolveAttestLink(
  service: SupabaseClient,
  token: string,
  options: { now?: number } = {},
): Promise<ResolveAttestLinkResult> {
  if (!isValidInviteTokenFormat(token)) return { ok: false, reason: 'invalid_format' }
  const { data, error } = await service
    .from('supplier_invoice_attest_links')
    .select(LINK_COLUMNS)
    .eq('token_hash', hashInviteToken(token))
    .maybeSingle()
  if (error) throw error
  const link = (data as AttestLinkRow | null) ?? null
  if (!link) return { ok: false, reason: 'not_found' }
  const now = options.now ?? Date.now()
  if (new Date(link.expires_at).getTime() <= now) return { ok: false, reason: 'expired' }
  if (link.consumed_at) return { ok: false, reason: 'consumed' }
  return { ok: true, link }
}

/** The decision is made: the link has done its work. */
export async function consumeAttestLink(service: SupabaseClient, linkId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service
    .from('supplier_invoice_attest_links')
    .update({ consumed_at: new Date(now).toISOString() })
    .eq('id', linkId)
    .is('consumed_at', null)
  if (error) throw error
}

/** The link went out by mail: the row records when. */
export async function markAttestLinkMailed(service: SupabaseClient, linkId: string, now: number = Date.now()): Promise<void> {
  const { error } = await service
    .from('supplier_invoice_attest_links')
    .update({ mail_sent_at: new Date(now).toISOString() })
    .eq('id', linkId)
  if (error) throw error
}
