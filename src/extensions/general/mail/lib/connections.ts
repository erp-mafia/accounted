/**
 * Reading and maintaining mailbox grants.
 *
 * Every function here uses the service-role client: `mail_connections` has RLS
 * enabled with no policies precisely so a live refresh token can never be
 * selected by a browser session.
 */
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import { MailTokenKeyError, decryptToken, encryptToken, shouldReseal } from './crypto'
import {
  MailTokenRefreshError,
  getGoogleOAuthEnv,
  lacksGmailScope,
  refreshAccessToken,
  revokeGoogleToken,
  type GoogleRevocationOutcome,
} from './google-oauth'

const log = createLogger('mail-connections')

/**
 * The error code of a grant that cannot read Gmail: a person unticked the
 * Gmail box on Google's consent screen. Only reconnecting, with the box left
 * ticked, heals it. Also the `?mail=` code the OAuth callback answers with.
 */
export const SCOPE_MISSING = 'scope_missing'

function grantLacksMailScope(row: { provider: string; scopes?: string[] | null }): boolean {
  return row.provider === 'gmail' && lacksGmailScope(row.scopes)
}

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
    .select('id, provider, email_address, scope_label, status, scopes, last_searched_at, last_error_code')
    .eq('company_id', companyId)
    .order('created_at', { ascending: true })

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => {
    // A grant without the Gmail scope is shown as what it is, needing a
    // reconnect, even before a search has parked it. Derived here and never
    // written: a GET changes nothing, and the next search makes the row say
    // the same thing (listActiveConnections).
    const scopeMissing =
      row.status === 'active' &&
      grantLacksMailScope({ provider: row.provider as string, scopes: row.scopes as string[] | null })
    return {
      id: row.id as string,
      provider: row.provider as 'gmail' | 'microsoft',
      emailAddress: row.email_address as string,
      scopeLabel: (row.scope_label as string | null) ?? null,
      status: scopeMissing ? 'needs_reconsent' : (row.status as MailConnectionSummary['status']),
      lastSearchedAt: (row.last_searched_at as string | null) ?? null,
      lastErrorCode: scopeMissing ? SCOPE_MISSING : ((row.last_error_code as string | null) ?? null),
    }
  })
}

/**
 * The connections a search may use.
 *
 * A row can be `active` and still unable to read mail: while the consent
 * request also asked for `openid email`, a person could untick Gmail on
 * Google's consent screen and approve the rest, and that grant was saved
 * (the callback now refuses one). Searching it fails on every press with a
 * refusal that looks like a Gmail outage. So such a row is parked here as
 * needs_reconsent with `scope_missing`, the state the settings page shows as
 * needing a reconnect, and left out, exactly like a grant Google has revoked
 * (getAccessToken). The write only lands on the row as it was read
 * (updated_at), so a person reconnecting at that moment is never parked by a
 * stale read.
 */
export async function listActiveConnections(
  supabase: SupabaseClient,
  companyId: string,
): Promise<MailConnectionRow[]> {
  const { data } = await supabase
    .from('mail_connections')
    .select(
      'id, company_id, provider, email_address, encrypted_refresh_token, encrypted_access_token, access_token_expires_at, scope_label, status, scopes, updated_at',
    )
    .eq('company_id', companyId)
    .eq('status', 'active')
  const rows = (data ?? []) as Array<MailConnectionRow & { scopes?: string[] | null; updated_at?: string }>

  const usable: MailConnectionRow[] = []
  for (const row of rows) {
    if (!grantLacksMailScope(row)) {
      usable.push(row)
      continue
    }
    await markNeedsReconsent(supabase, row.id, SCOPE_MISSING, row.updated_at)
    log.info('parked a mailbox whose grant cannot read Gmail', { connectionId: row.id, companyId })
  }
  return usable
}

/**
 * Upsert on (company, provider, address) so reconnecting the same mailbox
 * refreshes the grant instead of creating a twin that gets searched twice.
 *
 * Every save is audited, a first connect and a re-grant alike: which mailbox
 * started feeding underlag into the books, when, and who granted it, is the
 * other half of the disconnect entry (BFNAR 2013:2 kap 8). Written by hand
 * for the reason given in disconnect(): safe columns only, never a token.
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
  },
): Promise<void> {
  // Lowercased here rather than by an expression index, so the upsert's
  // ON CONFLICT target matches the index exactly (Postgres 42P10 otherwise).
  const emailAddress = params.emailAddress.trim().toLowerCase()
  const { data, error } = await supabase
    .from('mail_connections')
    .upsert(
      {
        company_id: params.companyId,
        provider: params.provider,
        email_address: emailAddress,
        connected_by: params.userId,
        encrypted_refresh_token: encryptToken(params.refreshToken),
        encrypted_access_token: encryptToken(params.accessToken),
        access_token_expires_at: params.expiresAt.toISOString(),
        scopes: params.scopes,
        status: 'active',
        last_error_code: null,
        last_error_at: null,
      },
      { onConflict: 'company_id,provider,email_address' },
    )
    .select('id')
    .single()
  if (error) throw new Error(`Failed to save mail connection: ${error.message}`)

  const { error: auditError } = await supabase.from('audit_log').insert({
    user_id: params.userId,
    company_id: params.companyId,
    action: 'INSERT',
    table_name: 'mail_connections',
    record_id: (data as { id: string }).id,
    description: `Brevlåda ansluten: ${emailAddress} (${params.provider})`,
    old_state: null,
    new_state: { email_address: emailAddress, provider: params.provider, scopes: params.scopes },
  })
  // The grant is saved either way: a missing note is surfaced loudly rather
  // than undoing a connection the person just approved at Google.
  if (auditError) {
    log.error('mailbox connected but the audit entry failed to write', {
      companyId: params.companyId,
      error: auditError.message,
    })
  }
}

async function markNeedsReconsent(
  supabase: SupabaseClient,
  connectionId: string,
  code: string,
  /** Only park the row if it has not changed since it was read. */
  readAt?: string,
): Promise<void> {
  const update = supabase
    .from('mail_connections')
    .update({ status: 'needs_reconsent', last_error_code: code, last_error_at: new Date().toISOString() })
    .eq('id', connectionId)
  await (readAt ? update.eq('updated_at', readAt) : update)
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
    await resealRefreshToken(supabase, connection, refreshToken)
    return refreshed.accessToken
  } catch (error) {
    if (error instanceof MailTokenRefreshError && error.permanent) {
      await markNeedsReconsent(supabase, connection.id, 'invalid_grant')
    }
    if (error instanceof MailTokenKeyError) {
      // A configuration error, not a dead grant: the row is left as it is so
      // restoring the key brings it back, and it is loud because every
      // search of this mailbox fails until then.
      log.error('a mailbox grant cannot be read: its encryption key is missing or malformed', {
        connectionId: connection.id,
        error: error.message,
      })
    }
    return null
  }
}

/**
 * Re-seal a legacy refresh token with the dedicated key, once, when reading
 * it anyway: the stored grants move to MAIL_TOKEN_ENCRYPTION_KEY as they are
 * used, without a migration that would need both keys in one place. Only the
 * ciphertext as it was read is replaced, so a reconnect in between wins. Best
 * effort: a failed write leaves a legacy token that still reads.
 */
async function resealRefreshToken(
  supabase: SupabaseClient,
  connection: MailConnectionRow,
  refreshToken: string,
): Promise<void> {
  if (!shouldReseal(connection.encrypted_refresh_token)) return
  try {
    const { error } = await supabase
      .from('mail_connections')
      .update({ encrypted_refresh_token: encryptToken(refreshToken) })
      .eq('id', connection.id)
      .eq('encrypted_refresh_token', connection.encrypted_refresh_token)
    if (error) log.warn('could not re-seal a mailbox grant', { connectionId: connection.id, error: error.message })
  } catch (error) {
    log.warn('could not re-seal a mailbox grant', {
      connectionId: connection.id,
      error: error instanceof Error ? error.name : 'unknown',
    })
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

/** As much of a stored grant as revoking it needs. */
export interface StoredGrant {
  id: string
  provider: string
  email_address: string
  encrypted_refresh_token: string
}

/**
 * What happened at the provider when our copy of a grant was destroyed.
 * Recorded in the audit entry, so it names an outcome and never a token.
 *
 *   revoked, already_invalid, failed   Google's answer (GoogleRevocationOutcome)
 *   shared    not asked: another active connection reads the same mailbox, and
 *             ending the app's access to that account would end that one too
 *   no_token  nothing stored to revoke with
 */
export type GrantRevocation = GoogleRevocationOutcome | 'shared' | 'no_token'

/**
 * Revoke a stored grant at the provider, before our copy of it goes.
 *
 * Deleting the row destroys only our copy: the grant itself stays live at
 * Google, listed under the person's third-party access, until someone revokes
 * it. Best effort by contract, it never throws, and the caller removes the row
 * whatever this returns, because destroying our copy is the part we control.
 *
 * A mailbox connected for two companies is one Google grant (one account, one
 * OAuth client), so while another active connection reads the same address
 * the grant is left alone: revoking it for one company would disconnect the
 * other at Google, silently, on its next search.
 */
export async function revokeStoredGrant(
  supabase: SupabaseClient,
  grant: StoredGrant,
): Promise<GrantRevocation> {
  if (!grant.encrypted_refresh_token) return 'no_token'
  if (grant.provider !== 'gmail') {
    log.warn('no revocation call exists for this provider', { connectionId: grant.id, provider: grant.provider })
    return 'failed'
  }

  const { count, error } = await supabase
    .from('mail_connections')
    .select('id', { count: 'exact', head: true })
    .eq('provider', grant.provider)
    .eq('email_address', grant.email_address)
    .eq('status', 'active')
    .neq('id', grant.id)
  if (error) {
    // Unknown is not "not shared": revoking on a guess could cut off another
    // company's mailbox, and our copy is destroyed either way.
    log.warn('could not tell whether a mailbox grant is shared, so it was not revoked', {
      connectionId: grant.id,
      error: error.message,
    })
    return 'failed'
  }
  if ((count ?? 0) > 0) return 'shared'

  let token: string
  try {
    token = decryptToken(grant.encrypted_refresh_token)
  } catch {
    log.warn('could not decrypt a mailbox grant to revoke it', { connectionId: grant.id })
    return 'failed'
  }
  const result = await revokeGoogleToken(token)
  if (result.outcome === 'failed') {
    log.warn('google did not confirm revoking a mailbox grant', {
      connectionId: grant.id,
      status: result.status,
      error: result.error,
    })
  }
  return result.outcome
}

/**
 * Every grant one person connected, in every company: exactly the rows the
 * account erasure RPC shreds (erase_user_personal_data matches connected_by).
 * Read before the RPC runs, because afterwards there is no token left to
 * revoke with.
 */
export async function listGrantsConnectedBy(
  supabase: SupabaseClient,
  userId: string,
): Promise<StoredGrant[]> {
  const { data, error } = await supabase
    .from('mail_connections')
    .select('id, provider, email_address, encrypted_refresh_token')
    .eq('connected_by', userId)
    .neq('encrypted_refresh_token', '')
  if (error) throw new Error(`Failed to read mailbox grants: ${error.message}`)
  return (data ?? []) as StoredGrant[]
}

/** Every mailbox connection a company holds, in any state. */
export async function listConnectionIds(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  const { data, error } = await supabase.from('mail_connections').select('id').eq('company_id', companyId)
  if (error) throw new Error(`Failed to read mail connections: ${error.message}`)
  return ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
}

/**
 * Who connected a mailbox of this company, or null when the company has no
 * such connection. `connectedBy` is null once that person's account has been
 * erased.
 */
export async function findConnectionOwner(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
): Promise<{ connectedBy: string | null } | null> {
  const { data, error } = await supabase
    .from('mail_connections')
    .select('connected_by')
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Failed to read mail connection: ${error.message}`)
  if (!data) return null
  return { connectedBy: (data as { connected_by: string | null }).connected_by }
}

export async function disconnect(
  supabase: SupabaseClient,
  companyId: string,
  connectionId: string,
  userId: string,
): Promise<void> {
  // Read the row before it goes: the audit entry names the mailbox that
  // stopped being searched, and the token is what Google needs to revoke.
  const { data: existing } = await supabase
    .from('mail_connections')
    .select('id, email_address, provider, encrypted_refresh_token')
    .eq('id', connectionId)
    .eq('company_id', companyId)
    .maybeSingle()
  const row = existing as StoredGrant | null

  // Revoked while the token still exists: once the row is deleted nothing
  // here could ever end the grant at Google. A Google that is slow or down
  // never keeps a person from disconnecting, since the delete runs whatever
  // the answer was.
  const revocation = row ? await revokeStoredGrant(supabase, row) : null

  // Hard delete: the point of disconnecting is that the token is gone. Receipts
  // already approved stay, because they belong to the bookkeeping now.
  const { error: deleteError } = await supabase
    .from('mail_connections')
    .delete()
    .eq('id', connectionId)
    .eq('company_id', companyId)
  // A failed delete must not leave an audit entry claiming the mailbox was
  // disconnected when the row is still here. If Google already revoked the
  // grant, the next search parks the row as needs_reconsent (invalid_grant).
  if (deleteError) {
    if (revocation === 'revoked') {
      log.warn('mailbox grant revoked at google but the row could not be deleted', { connectionId, companyId })
    }
    throw new Error(deleteError.message)
  }
  if (!row) return

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
    // Whether the provider confirmed the grant is gone, as an outcome only.
    new_state: { provider_revocation: revocation },
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
