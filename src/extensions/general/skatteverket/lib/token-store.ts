import { openAesGcm, sealAesGcm, sha256Key } from '@/lib/crypto/aes-gcm'
import { type SupabaseClient } from '@supabase/supabase-js'
import { createServiceRoleClient } from '@/lib/supabase/service-client'
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
  _serviceClient = createServiceRoleClient(url, key)
  return _serviceClient
}

function getEncryptionKey(): Buffer {
  const key = process.env.SKATTEVERKET_TOKEN_ENCRYPTION_KEY
  if (!key) throw new Error('SKATTEVERKET_TOKEN_ENCRYPTION_KEY is required')
  return sha256Key(key)
}

function encrypt(plaintext: string): string {
  return sealAesGcm(getEncryptionKey(), plaintext).toString('base64url')
}

function decrypt(ciphertext: string): string {
  return openAesGcm(getEncryptionKey(), Buffer.from(ciphertext, 'base64url'))
}

/**
 * Store (replace) Skatteverket tokens for a user + company pair.
 * Both access_token and refresh_token are encrypted at rest.
 *
 * Connections are per (user_id, company_id): the OAuth token is the person's
 * BankID session, but which company it is wired to is an explicit product
 * choice, and a multi-company operator holds one row per company. The
 * DELETE + INSERT (instead of UPSERT) predates the UNIQUE constraint and is
 * safe because OAuth callbacks and refreshes for a given pair are coalesced.
 *
 * Answers the new row's id: every store makes a new row, so the id names
 * this stored token (StoredTokenVersion).
 */
export async function storeTokens(
  _supabase: SupabaseClient,
  userId: string,
  tokens: SkatteverketTokens,
  companyId: string,
): Promise<string> {
  const encryptedAccess = encrypt(tokens.access_token)
  const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : null
  const db = getServiceClient()

  const { error: deleteError } = await db
    .from('skatteverket_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('company_id', companyId)
  if (deleteError) throw new Error(`Failed to clear existing tokens: ${deleteError.message}`)

  const id = crypto.randomUUID()
  const { error: insertError } = await db.from('skatteverket_tokens').insert({
    id,
    user_id: userId,
    company_id: companyId,
    access_token: encryptedAccess,
    refresh_token: encryptedRefresh,
    expires_at: new Date(tokens.expires_at).toISOString(),
    refresh_count: tokens.refresh_count,
    scope: tokens.scope,
  })
  if (insertError) throw new Error(`Failed to store tokens: ${insertError.message}`)
  return id
}

/**
 * Which stored token a verdict was reached on. storeTokens replaces the row
 * (delete, then insert) on every BankID consent and every refresh, so the
 * row's id names one stored token; refresh_count is kept beside it.
 */
export interface StoredTokenVersion {
  rowId: string
  refreshCount: number
}

/** Tokens as stored: decrypted, with the row they were read from. */
export interface StoredSkatteverketTokens extends SkatteverketTokens {
  /** The row's id (see StoredTokenVersion). */
  row_id: string
  /** When the row was stored, epoch ms: when its tokens were issued, give or take the store. */
  stored_at: number
}

/**
 * Retrieve and decrypt Skatteverket tokens for a user.
 * Returns null if no tokens are stored.
 */
export async function getTokens(
  _supabase: SupabaseClient,
  userId: string,
  companyId: string
): Promise<StoredSkatteverketTokens | null> {
  const db = getServiceClient()
  const { data, error } = await db
    .from('skatteverket_tokens')
    .select('id, access_token, refresh_token, expires_at, refresh_count, scope, created_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle()

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
      row_id: data.id,
      stored_at: new Date(data.created_at).getTime(),
    }
  } catch (err) {
    log.error('decryption failed for stored tokens', {
      userId,
      companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    const corrupted = new SkatteverketAuthError(
      'Tokens kunde inte läsas. Anslut igen med BankID.',
      'TOKEN_CORRUPTED'
    )
    // The verdict is about this row only: a flag must not land on a row
    // stored after it (markNeedsReconsent compares on the version).
    corrupted.tokenRow = { userId, version: { rowId: data.id, refreshCount: data.refresh_count ?? 0 } }
    throw corrupted
  }
}

/**
 * Delete stored tokens (disconnect from Skatteverket). `onlyRowId` deletes
 * that stored token and nothing stored after it: a verdict about one token
 * (Skatteverket answering it is revoked) must not delete the token another
 * process stored meanwhile. A failed delete throws: the token is still
 * there, and the caller must not report it gone.
 */
export async function deleteTokens(
  _supabase: SupabaseClient,
  userId: string,
  companyId: string,
  onlyRowId?: string,
): Promise<void> {
  const db = getServiceClient()
  const rows = db
    .from('skatteverket_tokens')
    .delete()
    .eq('user_id', userId)
    .eq('company_id', companyId)
  const { error } = await (onlyRowId === undefined ? rows : rows.eq('id', onlyRowId))
  if (error) throw new Error(`Failed to delete Skatteverket tokens: ${error.message}`)
}

/**
 * Terminal auth-error codes: the stored token can never recover on its own:
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
 *
 * `decidedOn` (SkatteverketAuthError.tokenRow.version) makes the write a
 * compare-and-set: only the stored token the verdict was reached on is
 * flagged, by its row id and refresh_count. Without it, a job that lost a
 * refresh race flagged the row the winner had just stored, and a live
 * connection asked its user for a new BankID login. The refresh_count alone
 * was not enough: it restarts at 0 on every consent, so a new consent landing
 * after a verdict about the old one's first token matched. Every store makes
 * a new row, so a row replaced meanwhile no longer matches and is left alone.
 */
export async function markNeedsReconsent(
  _supabase: SupabaseClient,
  userId: string,
  companyId: string,
  errorCode: string,
  decidedOn?: StoredTokenVersion,
): Promise<void> {
  const db = getServiceClient()
  const flag = db
    .from('skatteverket_tokens')
    .update({
      status: 'needs_reconsent',
      last_error_code: errorCode,
      last_error_at: new Date().toISOString(),
    })
    .eq('user_id', userId)
    .eq('company_id', companyId)
  const { error } = await (decidedOn === undefined
    ? flag
    : flag.eq('id', decidedOn.rowId).eq('refresh_count', decidedOn.refreshCount))
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
  companyId: string,
): Promise<{ status: string; last_error_code: string | null; last_error_at: string | null } | null> {
  const db = getServiceClient()
  const { data, error } = await db
    .from('skatteverket_tokens')
    .select('status, last_error_code, last_error_at')
    .eq('user_id', userId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !data) return null
  return {
    status: (data.status as string | null) ?? 'active',
    last_error_code: (data.last_error_code as string | null) ?? null,
    last_error_at: (data.last_error_at as string | null) ?? null,
  }
}
