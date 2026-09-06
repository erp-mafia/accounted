/**
 * One-time link codes + phone-link lifecycle.
 *
 * The code proves control of an Accounted account (minted in an authenticated
 * settings panel) and sending it proves possession of the phone; the webhook
 * binds the two. Invite-token pattern (lib/auth/invite-tokens.ts): the raw
 * code exists only in the user's chat, the DB stores a hash. That hash is
 * HMAC-peppered, NOT a plain sha256: invite tokens are 256-bit random, but a
 * link code is one of 30^6 values behind a fixed 'AC-' prefix, and enumerating
 * that space offline takes about a second (the exact reason phone-crypto.ts
 * peppers the phone hash).
 *
 * All functions here take a SERVICE-ROLE client: whatsapp_link_codes has RLS
 * enabled with no policies, and link INSERTs are service-role only by design
 * (see migration 20260802090000).
 */

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { WhatsAppPhoneLink } from '@/types'
import { encryptPhone, hashPhone, hashSecret, maskPhone } from './phone-crypto'

/** Uppercased twin of generate_inbox_local_part's ambiguity-free alphabet
 *  (no I/L/O/U, no 0/1): codes survive being read aloud or retyped. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789'
export const CODE_PREFIX = 'AC-'
export const CODE_LENGTH = 6
export const CODE_TTL_MS = 10 * 60 * 1000
/** Codes a single account may mint inside the TTL window before it must wait.
 *  The panel mints one per visit; anything above this is a script. */
export const MAX_CODES_PER_TTL_WINDOW = 5

export function hashLinkCode(code: string): string {
  return hashSecret(code)
}

/** Thrown by mintLinkCode when the caller is minting far too fast. */
export class LinkCodeRateLimitError extends Error {
  readonly name = 'LinkCodeRateLimitError'
  constructor() {
    super('Too many link codes requested')
  }
}

/**
 * Normalize a chat message into a canonical code ('AC-7KP4QF') or null when
 * the text does not look like a code at all. Forgiving on formatting (trims,
 * uppercases, tolerates a missing hyphen), but a BARE 6-char body without the
 * AC prefix must contain at least one digit: otherwise ordinary greetings
 * built from alphabet letters ('hej hej' -> HEJHEJ) would read as codes and
 * earn a confusing M2 instead of the M1 greeting. The panel and the wa.me
 * prefill always carry the prefix, so prefixed codes are never rejected.
 */
export function normalizeLinkCode(text: string | null | undefined): string | null {
  if (!text) return null
  const compact = text.trim().toUpperCase().replace(/\s+/g, '')
  const match = compact.match(/^(AC-?)?([A-Z2-9]{6})$/)
  if (!match) return null
  const hasPrefix = match[1] != null
  const body = match[2]
  for (const ch of body) {
    if (!CODE_ALPHABET.includes(ch)) return null
  }
  if (!hasPrefix && !/[2-9]/.test(body)) return null
  return `${CODE_PREFIX}${body}`
}

export function looksLikeLinkCode(text: string | null | undefined): boolean {
  return normalizeLinkCode(text) !== null
}

export interface MintedCode {
  code: string
  expiresAt: string
}

/**
 * Mint a fresh code for the settings panel.
 *
 * Exactly one code per account is live at a time: minting burns the caller's
 * earlier unused codes, so the panel showing a code is the only code that
 * works. Minting is also capped per TTL window, because the route is an
 * authenticated unbounded INSERT otherwise.
 */
export async function mintLinkCode(
  serviceClient: SupabaseClient,
  userId: string,
): Promise<MintedCode> {
  const windowStart = new Date(Date.now() - CODE_TTL_MS).toISOString()
  const { count } = await serviceClient
    .from('whatsapp_link_codes')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('created_at', windowStart)
  if ((count ?? 0) >= MAX_CODES_PER_TTL_WINDOW) throw new LinkCodeRateLimitError()

  await serviceClient
    .from('whatsapp_link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('used_at', null)

  let body = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    body += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)]
  }
  const code = `${CODE_PREFIX}${body}`
  const expiresAt = new Date(Date.now() + CODE_TTL_MS).toISOString()

  const { error } = await serviceClient.from('whatsapp_link_codes').insert({
    user_id: userId,
    code_hash: hashLinkCode(code),
    expires_at: expiresAt,
  })
  if (error) throw new Error(`Failed to mint link code: ${error.message}`)

  return { code, expiresAt }
}

/**
 * Outcome of consuming a code:
 *  - { userId }: verified and claimed, single-use.
 *  - null: unknown, expired, already used, or lost the claim race. A verdict
 *    about the CODE, so the caller may say "bad code" (M2).
 *  - 'transient_error': the lookup or the claim could not be executed (DB
 *    error, statement timeout). No verdict at all: the code is untouched and
 *    still valid, so the caller must not answer M2 (#2062). Same tri-state
 *    idiom as resolveCompanyTarget in process-inbound.ts.
 */
export type LinkCodeConsumption = { userId: string } | null | 'transient_error'

/**
 * Verify + consume a code from an inbound chat message. Single-use is
 * enforced by the guarded UPDATE (used_at IS NULL): a concurrent redelivery
 * loses the race and gets null.
 */
export async function consumeLinkCode(
  serviceClient: SupabaseClient,
  rawText: string,
): Promise<LinkCodeConsumption> {
  const code = normalizeLinkCode(rawText)
  if (!code) return null

  const { data: row, error: lookupError } = await serviceClient
    .from('whatsapp_link_codes')
    .select('id, user_id, expires_at, used_at')
    .eq('code_hash', hashLinkCode(code))
    .maybeSingle()
  if (lookupError) return 'transient_error'

  if (!row || row.used_at) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null

  const { data: claimed, error: claimError } = await serviceClient
    .from('whatsapp_link_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', row.id)
    .is('used_at', null)
    .select('id')
    .maybeSingle()
  if (claimError) return 'transient_error'

  if (!claimed) return null
  return { userId: row.user_id }
}

export interface CreatedPhoneLink {
  link: WhatsAppPhoneLink
  conversationId: string | null
}

/**
 * Bind a verified phone to a user: revoke whatever active links stand in the
 * way of the two partial-unique indexes (same phone bound elsewhere, or the
 * user re-linking from a new phone), then insert the link + its conversation
 * row. Revocation-not-deletion keeps the trail auditable.
 */
export async function createPhoneLink(
  serviceClient: SupabaseClient,
  args: { userId: string; phone: string; profileName?: string | null },
): Promise<CreatedPhoneLink> {
  const phoneHash = hashPhone(args.phone)
  const now = new Date().toISOString()

  await serviceClient
    .from('whatsapp_phone_links')
    .update({ revoked_at: now })
    .eq('phone_hash', phoneHash)
    .is('revoked_at', null)
  await serviceClient
    .from('whatsapp_phone_links')
    .update({ revoked_at: now })
    .eq('user_id', args.userId)
    .is('revoked_at', null)

  const { data: link, error } = await serviceClient
    .from('whatsapp_phone_links')
    .insert({
      user_id: args.userId,
      phone_hash: phoneHash,
      phone_enc: encryptPhone(args.phone),
      phone_masked: maskPhone(args.phone),
      wa_profile_name: args.profileName?.slice(0, 200) ?? null,
      last_message_at: now,
    })
    .select('*')
    .single()
  if (error || !link) {
    throw new Error(`Failed to create phone link: ${error?.message ?? 'no row returned'}`)
  }

  const { data: conversation } = await serviceClient
    .from('whatsapp_conversations')
    .insert({
      phone_link_id: link.id,
      last_inbound_at: now,
      service_window_expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    })
    .select('id')
    .maybeSingle()

  return { link: link as WhatsAppPhoneLink, conversationId: conversation?.id ?? null }
}

/** Active (non-revoked) link for a phone hash, or null. */
export async function lookupActiveLink(
  serviceClient: SupabaseClient,
  phoneHash: string,
): Promise<WhatsAppPhoneLink | null> {
  const { data } = await serviceClient
    .from('whatsapp_phone_links')
    .select('*')
    .eq('phone_hash', phoneHash)
    .is('revoked_at', null)
    .maybeSingle()
  return (data as WhatsAppPhoneLink | null) ?? null
}
