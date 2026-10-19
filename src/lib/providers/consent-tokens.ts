/**
 * The one door to provider_consent_tokens (accounted#58). The table holds the
 * tokens that open a customer's books at Fortnox, Visma, Bokio, Björn Lundén,
 * Briox or WINT. access_token and refresh_token are sealed at rest in the
 * shared AES-GCM layout (lib/crypto/aes-gcm.ts) under
 * PERSONNUMMER_ENCRYPTION_KEY, the key the provider migration payloads are
 * already sealed with (lib/providers/migration-payload.ts), with its own KDF
 * salt.
 *
 * A stored token is either `pct1:<base64url>` (sealed) or a legacy plaintext
 * value written before the seal. No provider token contains a colon (JWTs,
 * UUIDs and base64 never do), so the prefix tells them apart. Reads accept
 * both, writes always seal, and resolveConsent reseals a legacy row the first
 * time it serves one. scripts/checks/consent-token-access.mjs fails CI on a
 * token read or write of this table anywhere else.
 */
import { scryptSync } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openAesGcm, sealAesGcm } from '@/lib/crypto/aes-gcm'
import { queryInExecutionBudget } from '@/lib/http/execution-budget'
import { createLogger } from '@/lib/logger'

const log = createLogger('providers/consent-tokens')

const TABLE = 'provider_consent_tokens'
const SEALED_PREFIX = 'pct1:'

let cached: { secret: string; key: Buffer } | undefined
function key(): Buffer {
  const secret = process.env.PERSONNUMMER_ENCRYPTION_KEY
  if (!secret) throw new Error('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
  if (cached?.secret !== secret) cached = { secret, key: scryptSync(secret, 'accounted-provider-consent-tokens-v1', 32) }
  return cached.key
}

export function sealConsentToken(token: string): string {
  return SEALED_PREFIX + sealAesGcm(key(), token).toString('base64url')
}

/** The token a stored value holds. A legacy plaintext value is returned as is. */
export function openConsentToken(stored: string): string {
  if (!stored.startsWith(SEALED_PREFIX)) return stored
  return openAesGcm(key(), Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64url'))
}

const isPlaintext = (stored: unknown): boolean => typeof stored === 'string' && !stored.startsWith(SEALED_PREFIX)

/** A token row as stored, with access_token and refresh_token opened. */
export type ConsentTokenRow = Record<string, unknown>

interface TokenColumns {
  access_token?: string
  refresh_token?: string | null
}

function sealColumns<T extends TokenColumns>(row: T): T {
  const sealed = { ...row }
  if (typeof row.access_token === 'string') sealed.access_token = sealConsentToken(row.access_token)
  if (typeof row.refresh_token === 'string') sealed.refresh_token = sealConsentToken(row.refresh_token)
  return sealed
}

function openColumns(row: ConsentTokenRow): ConsentTokenRow {
  const opened = { ...row }
  if (typeof row.access_token === 'string') opened.access_token = openConsentToken(row.access_token)
  if (typeof row.refresh_token === 'string') opened.refresh_token = openConsentToken(row.refresh_token)
  return opened
}

/**
 * The consent's token row with its tokens opened, or no row (also on a read
 * error, which `error` carries). `plaintext` says the stored row still holds
 * a legacy unsealed token.
 */
export async function readConsentTokens(
  supabase: SupabaseClient,
  consentId: string,
): Promise<{ tokens?: ConsentTokenRow; plaintext: boolean; error: unknown }> {
  const { data, error } = await queryInExecutionBudget(
    supabase.from(TABLE).select('*').eq('consent_id', consentId).limit(1),
  )
  const stored = error ? undefined : (data as ConsentTokenRow[] | null)?.[0]
  return {
    tokens: stored && openColumns(stored),
    plaintext: !!stored && (isPlaintext(stored.access_token) || isPlaintext(stored.refresh_token)),
    error,
  }
}

/** Store a consent's tokens, sealed. Resolves to the PostgREST `{ error }`. */
export function saveConsentTokens(
  supabase: SupabaseClient,
  row: {
    consent_id: string
    provider: string
    access_token: string
    refresh_token?: string | null
    token_expires_at?: string | null
    provider_company_id?: string
  },
) {
  return supabase.from(TABLE).upsert(sealColumns(row))
}

/**
 * An update of the consent's token row with any new token sealed. The caller
 * chains its concurrency guard and projection onto the returned builder.
 */
export function updateConsentTokens(
  supabase: SupabaseClient,
  consentId: string,
  patch: TokenColumns & { token_expires_at?: string },
) {
  return supabase.from(TABLE).update(sealColumns(patch)).eq('consent_id', consentId)
}

/**
 * Seal a legacy plaintext row in place, guarded on its credential revision so
 * a concurrent rotation is never overwritten. The revision trigger moves the
 * revision because the stored bytes change; the result is the revision the
 * row has afterwards, or the one it had when nothing was written. Best effort:
 * a failure leaves the row as it was, readable, and is only logged.
 */
export async function resealConsentTokens(
  supabase: SupabaseClient,
  consentId: string,
  tokens: ConsentTokenRow,
): Promise<string | undefined> {
  const revision = typeof tokens.credential_revision === 'string' ? tokens.credential_revision : undefined
  if (!revision || typeof tokens.access_token !== 'string') return revision
  try {
    const { data, error } = await queryInExecutionBudget(
      updateConsentTokens(supabase, consentId, {
        access_token: tokens.access_token,
        ...(typeof tokens.refresh_token === 'string' ? { refresh_token: tokens.refresh_token } : {}),
      })
        .eq('credential_revision', revision)
        .select('consent_id, credential_revision'),
    )
    if (error) throw new Error(error.message)
    const saved = (data as { credential_revision?: unknown }[] | null)?.[0]?.credential_revision
    return typeof saved === 'string' ? saved : revision
  } catch (err) {
    log.warn('provider consent tokens left unsealed; the next read retries', {
      consentId,
      reason: err instanceof Error ? err.message : 'unknown',
    })
    return revision
  }
}
