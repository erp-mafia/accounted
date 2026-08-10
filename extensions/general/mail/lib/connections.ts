/**
 * Reading and maintaining mailbox grants.
 *
 * Every function here uses the service-role client: `mail_connections` has RLS
 * enabled with no policies precisely so a live refresh token can never be
 * selected by a browser session.
 */
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptToken, encryptToken } from './crypto'
import {
  MailTokenRefreshError,
  getGoogleOAuthEnv,
  refreshAccessToken,
} from './google-oauth'

const log = createLogger('mail-connections')

export interface MailConnectionRow {
  id: string
  company_id: string
  provider: 'gmail' | 'microsoft'
  email_address: string
  encrypted_refresh_token: string
  encrypted_access_token: string | null
  access_token_expires_at: string | null
  scope_label: string | null
  status: 'active' | 'needs_reconsent' | 'revoked'
}

/** Safe projection for anything that answers a browser. Never includes tokens. */
export interface MailConnectionSummary {
  id: string
  provider: 'gmail' | 'microsoft'
  emailAddress: string
  scopeLabel: string | null
  status: 'active' | 'needs_reconsent' | 'revoked'
  lastSearchedAt: string | null
  lastErrorCode: string | null
}

export async function listConnections(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MailConnectionSummary[]> {
  const { data } = await supabase
    .from('mail_connections')
    .select('id, provider, email_address, scope_label, status, last_searched_at, last_error_code')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: row.id as string,
    provider: row.provider as 'gmail' | 'microsoft',
    emailAddress: row.email_address as string,
    scopeLabel: (row.scope_label as string | null) ?? null,
    status: row.status as MailConnectionSummary['status'],
    lastSearchedAt: (row.last_searched_at as string | null) ?? null,
    lastErrorCode: (row.last_error_code as string | null) ?? null,
  }))
}

export async function listActiveConnections(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MailConnectionRow[]> {
  const { data } = await supabase
    .from('mail_connections')
    .select(
      'id, company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scope_label, status',
    )
    .eq('company_id', companyId)
    .eq('status', 'active')
  return (data ?? []) as MailConnectionRow[]
}

/**
 * Upsert on (company, provider, address) so reconnecting the same mailbox
 * refreshes the grant instead of creating a twin that gets searched twice.
 */
export async function saveConnection(
  supabase: SupabaseClient,
  params: {
    companyId: string
    userId: string
    provider: 'gmail' | 'microsoft'
    emailAddress: string
    refreshToken: string
    accessToken: string
    expiresAt: Date
    scopes: string[]
    backfillFrom: string | null
  },
): Promise<void> {
  const { error } = await supabase.from('mail_connections').upsert(
    {
      company_id: params.companyId,
      provider: params.provider,
      // Lowercased here rather than by an expression index, so the upsert's
      // ON CONFLICT target matches the index exactly (Postgres 42P10 otherwise).
      email_address: params.emailAddress.trim().toLowerCase(),
      connected_by: params.userId,
      encrypted_refresh_token: encryptToken(params.refreshToken),
      encrypted_access_token: encryptToken(params.accessToken),
      access_token_expires_at: params.expiresAt.toISOString(),
      scopes: params.scopes,
      backfill_from: params.backfillFrom,
      status: 'active',
      last_error_code: null,
      last_error_at: null,
    },
    { onConflict: 'company_id,provider,email_address' },
  )
  if (error) throw new Error(`Failed to save mail connection: ${error.message}`)
}

async function markNeedsReconsent(
  supabase: SupabaseClient,
  connectionId: string,
  code: string,
): Promise<void> {
  await supabase
    .from('mail_connections')
    .update({ status: 'needs_reconsent', last_error_code: code, last_error_at: new Date().toISOString() })
    .eq('id', connectionId)
}

/**
 * A usable access token for one connection, refreshing when it has expired.
 *
 * Returns null rather than throwing when the grant is dead: one revoked
 * mailbox must shrink the hunt, never abort it.
 */
export async function getAccessToken(
  supabase: SupabaseClient,
  connection: MailConnectionRow,
  origin: string,
): Promise<string | null> {
  const expiresAt = connection.access_token_expires_at
    ? new Date(connection.access_token_expires_at)
    : null
  // 60s of slack so a token cannot expire mid-request.
  if (connection.encrypted_access_token && expiresAt && expiresAt.getTime() - 60_000 > Date.now()) {
    try {
      return decryptToken(connection.encrypted_access_token)
    } catch {
      // Fall through to a refresh: an undecryptable token means the key
      // rotated, which a refresh repairs.
    }
  }

  try {
    const env = getGoogleOAuthEnv(origin)
    const refreshToken = decryptToken(connection.encrypted_refresh_token)
    const refreshed = await refreshAccessToken(env, refreshToken)
    await supabase
      .from('mail_connections')
      .update({
        encrypted_access_token: encryptToken(refreshed.accessToken),
        access_token_expires_at: refreshed.expiresAt.toISOString(),
      })
      .eq('id', connection.id)
    return refreshed.accessToken
  } catch (error) {
    if (error instanceof MailTokenRefreshError && error.permanent) {
      await markNeedsReconsent(supabase, connection.id, 'invalid_grant')
    }
    return null
  }
}

export async function touchSearched(
  supabase: SupabaseClient,
  connectionId: string,
): Promise<void> {
  await supabase
    .from('mail_connections')
    .update({ last_searched_at: new Date().toISOString() })
    .eq('id', connectionId)
}

export async function disconnect(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
  userId: string,
): Promise<void> {
  // Read the address before the row goes, so the audit entry can name the
  // mailbox that stopped being searched.
  const { data: existing } = await supabase
    .from('mail_connections')
    .select('email_address, provider')
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()

  // Hard delete: the point of disconnecting is that the token is gone. Receipts
  // already approved stay, because they belong to the bookkeeping now.
  const { error: deleteError } = await supabase
    .from('mail_connections')
    .delete()
    .eq('id', connectionId)
    .eq('company_id', companyId)
  // A failed delete must not leave an audit entry claiming the mailbox was
  // disconnected when the credential is still live.
  if (deleteError) throw new Error(deleteError.message)
  if (!existing) return

  const row = existing as { email_address: string; provider: string }

  // BFNAR 2013:2 kap 8 (behandlingshistorik): which mailboxes feed underlag into
  // the books is a control over how räkenskapsinformation is produced, so
  // switching one off has to be reconstructable years later.
  //
  // Written by hand rather than by the write_audit_log trigger the accounting
  // tables use. That trigger copies the whole row into audit_log, which here
  // would mean copying an encrypted refresh token into a second table and
  // keeping it after the point of the delete was to destroy it. The sibling
  // credential tables (shopify_connections) omit the trigger for the same
  // reason. Only the safe columns are recorded.
  const { error: auditError } = await supabase.from('audit_log').insert({
    user_id: userId,
    company_id: companyId,
    action: 'DELETE',
    table_name: 'mail_connections',
    record_id: connectionId,
    description: `Brevlåda frånkopplad: ${row.email_address} (${row.provider})`,
    old_state: { email_address: row.email_address, provider: row.provider },
    new_state: null,
  })
  // Deliberately not rolled back into one transaction. The two statements can
  // only diverge one way now: the credential is destroyed and the note about it
  // is missing. Recreating the credential to keep them in step would be worse
  // than a missing note, so the gap is surfaced loudly instead of hidden.
  if (auditError) {
    log.error('mailbox disconnected but the audit entry failed to write', {
      connectionId,
      companyId,
      error: auditError.message,
    })
  }
}
