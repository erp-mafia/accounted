import crypto from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import type { SkatteverketTokens } from '../types'
import { SkatteverketAuthError } from './api-client'

const log = createLogger('skatteverket-token-store')

/**
 * Encrypted token storage for Skatteverket OAuth2 tokens.
 *
 * Uses AES-256-GCM with a dedicated encryption key (not the Supabase service
 * role key) to encrypt tokens at rest in the skatteverket_tokens table.
 *
 * Pattern mirrors lib/auth/oauth-codes.ts but adapted for persistent storage.
 *
 * All DB operations route through a service-role client. The original RLS
 * design (auth.uid() = user_id) is correct, but at least one deployed
 * environment is missing the INSERT/UPDATE/DELETE policies and the
 * UNIQUE(user_id) constraint, so user-session writes get rejected. The
 * service-role client bypasses RLS, and the calling handlers (the OAuth
 * callback in particular) verify the user identity via cookies before
 * passing user_id here, so the access-control invariant is upheld at the
 * application layer.
 */

let _serviceClient: SupabaseClient | null = null
function getServiceClient(): SupabaseClient {
  if (_serviceClient) return _serviceClient
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('skatteverket token-store requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  _serviceClient = createClient(url, key, { auth: { persistSession: false } })
  return _serviceClient
}

const ALGORITHM = 'aes-256-gcm'

function getEncryptionKey(): Buffer {
  const key = process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY
  if (!key) throw new Error('SKATTEVERKET_TOKEN_ENCRYPTION_KEY is required')
  return crypto.createHash('sha256').update(key).digest()
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, encrypted]).toString('base64url')
}

function decrypt(ciphertext: string): string {
  const key = getEncryptionKey()
  const combined = Buffer.from(ciphertext, 'base64url')
  const iv = combined.subarray(0, 12)
  const tag = combined.subarray(12, 28)
  const encrypted = combined.subarray(28)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
}

/**
 * Store (replace) Skatteverket tokens for a user.
 * Both access_token and refresh_token are encrypted at rest.
 *
 * Implemented as DELETE + INSERT instead of UPSERT because some environments
 * are missing the UNIQUE(user_id) constraint that ON CONFLICT requires. The
 * delete-then-insert pattern is safe because OAuth callbacks for a given user
 * are not concurrent (the user can only sign in with BankID once at a time).
 */
export async function storeTokens(
  _supabase: SupabaseClient,
  userId: string,
  tokens: SkatteverketTokens,
  companyId?: string,
): Promise<void> {
  const encryptedAccess = encrypt(tokens.access_token)
  const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null
  const db = getServiceClient()

  // The multi-tenant refactor (migration 20260330130000) put a NOT NULL
  // company_id on every table. Tokens are conceptually user-scoped (one
  // BankID identity), but the schema requires a company_id. The OAuth
  // callback passes one explicitly. Token-refresh flows (called from
  // skvRequest) don't pass one, so before we DELETE the existing row we
  // remember its company_id and reuse it on INSERT.
  let resolvedCompanyId = companyId
  if (!resolvedCompanyId) {
    const { data: existing, error: selectError } = await db
      .from('skatteverket_tokens')
      .select('company_id')
      .eq('user_id', userId)
      .maybeSingle()
    // Throw before the destructive DELETE: a transient read failure here
    // would otherwise wipe the existing row and then fail the INSERT on the
    // NOT NULL company_id, leaving the user with no token at all.
    if (selectError) {
      throw new Error(`Failed to read existing token row: ${selectError.message}`)
    }
    if (existing?.company_id) resolvedCompanyId = existing.company_id
  }

  const { error: deleteError } = await db
    .from('skatteverket_tokens')
    .delete()
    .eq('user_id', userId)
  if (deleteError) throw new Error(`Failed to clear existing tokens: ${deleteError.message}`)

  const row: Record<string, unknown> = {
    user_id: userId,
    access_token: encryptedAccess,
    refresh_token: encryptedRefresh,
    expires_at: new Date(tokens.expires_at).toISOString(),
    refresh_count: tokens.refresh_count,
    scope: tokens.scope,
  }
  if (resolvedCompanyId) row.company_id = resolvedCompanyId

  const { error: insertError } = await db.from('skatteverket_tokens').insert(row)
  if (insertError) throw new Error(`Failed to store tokens: ${insertError.message}`)
}

/**
 * Retrieve and decrypt Skatteverket tokens for a user.
 * Returns null if no tokens are stored.
 */
export async function getTokens(
  _supabase: SupabaseClient,
  userId: string
): Promise<SkatteverketTokens | null> {
  const db = getServiceClient()
  const { data, error } = await db
    .from('skatteverket_tokens')
    .select('access_token, refresh_token, expires_at, refresh_count, scope')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null

  // Distinguish three states:
  //   1. No row → caller treats as NOT_CONNECTED (return null above)
  //   2. Decryption error → log + throw TOKEN_CORRUPTED so the caller can
  //      tell the user to reconnect. Previously returned null silently
  //      which masked the real problem (key rotation, tampering, or a
  //      schema-level bug) as "not connected".
  try {
    return {
      access_token: decrypt(data.access_token),
      refresh_token: data.refresh_token ? decrypt(data.refresh_token) : null,
      expires_at: new Date(data.expires_at).getTime(),
      refresh_count: data.refresh_count ?? 0,
      scope: data.scope,
    }
  } catch (err) {
    log.error('decryption failed for stored tokens', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    })
    throw new SkatteverketAuthError(
      'Tokens kunde inte läsas. Anslut igen med BankID.',
      'TOKEN_CORRUPTED'
    )
  }
}

/**
 * Delete stored tokens (disconnect from Skatteverket).
 */
export async function deleteTokens(
  _supabase: SupabaseClient,
  userId: string
): Promise<void> {
  const db = getServiceClient()
  await db
    .from('skatteverket_tokens')
    .delete()
    .eq('user_id', userId)
}

/**
 * Terminal auth-error codes: the stored token can never recover on its own —
 * only a fresh BankID consent fixes it. SESSION_EXPIRED qualifies because
 * SKV's `per`-flow refresh tokens live 65 minutes: once expired there is
 * nothing left to refresh with.
 */
export const RECONSENT_ERROR_CODES = [
  'SESSION_EXPIRED',
  'REFRESH_EXHAUSTED',
  'MISSING_SCOPE',
  'TOKEN_CORRUPTED',
] as const

/**
 * Flag a connection as needing re-consent so crons stop retrying it every
 * night and the UI can prompt proactively. storeTokens() (delete + insert)
 * resets the row to status 'active' on the next successful consent.
 * Best-effort: health bookkeeping must never mask the original auth error.
 */
export async function markNeedsReconsent(
  _supabase: SupabaseClient,
  userId: string,
  errorCode: string,
): Promise<void> {
  const db = getServiceClient()
  const { error } = await db
    .from('skatteverket_tokens')
    .update({
      status: 'needs_reconsent',
      last_error_code: errorCode,
      last_error_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
  if (error) {
    log.warn('failed to mark token row needs_reconsent', {
      userId,
      errorCode,
      error: error.message,
    })
  }
}

/**
 * Read the persisted connection health for a user's token row.
 * Returns null when no row exists (not connected).
 */
export async function getTokenHealth(
  _supabase: SupabaseClient,
  userId: string,
): Promise<{ status: string; last_error_code: string | null; last_error_at: string | null } | null> {
  const db = getServiceClient()
  const { data, error } = await db
    .from('skatteverket_tokens')
    .select('status, last_error_code, last_error_at')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data) return null
  return {
    status: (data.status as string | null) ?? 'active',
    last_error_code: (data.last_error_code as string | null) ?? null,
    last_error_at: (data.last_error_at as string | null) ?? null,
  }
}
