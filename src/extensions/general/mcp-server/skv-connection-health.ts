import type { SupabaseClient } from '@supabase/supabase-js'
import { findCompanyTokenUser, hasOmbudReadAccess } from '@/extensions/general/skatteverket/lib/resolve-auth'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { isSkatteverketEnabled } from '@/lib/skatteverket/enabled'
import { isSkvSessionRefreshable } from '@/lib/skatteverket/session-lifetime'

/**
 * Can THIS caller file (momsdeklaration, AGI) right now? Filing runs on the
 * caller's own BankID session, never on the company connection another
 * member made, so the answer can differ from `status`.
 */
export interface SkvFilingReadiness {
  ready: boolean
  /** The caller's own session: live, present but dead, or never connected. */
  own_session: 'active' | 'expired' | 'none'
  /** Why the caller cannot file and what to do next; absent when ready. */
  message?: string
}

export interface SkvConnectionHealth {
  status: 'active' | 'needs_reconsent'
  source: 'user' | 'system'
  connected_at?: string | null
  message?: string
  /** Present when the caller is known: what the filing tools will do for them. */
  filing?: SkvFilingReadiness
}

export const SKV_NEEDS_RECONSENT_MESSAGE =
  'Skatteverket-sessionen har gått ut. Skatteverkets personliga inloggning räcker i ungefär tio timmar, så detta är normalt. Be användaren ansluta igen med BankID under Inställningar → Kopplingar → Skatteverket; bara en person kan göra det, så försök inte med Skatteverket-verktyg förrän användaren bekräftat.'

/**
 * Is the company's Skatteverket connection usable right now? One answer for
 * every tool that reports it: gnubok_get_agent_briefing and
 * gnubok_connect_skatteverket used to disagree, the connect tool saying
 * connected: true for a token row flagged needs_reconsent (feedback seq
 * 604946), so an agent that asked the tool built for the question got the
 * wrong answer.
 *
 * `status` describes the company's connection, the one reads run on. With
 * `userId`, `filing` adds what the filing tools will do for that caller: the
 * briefing said active (another member's session) while validate and submit
 * refused on the caller's own long-expired one (crm#1263).
 *
 * null = no connection at all (or the integration is off). Best-effort: a
 * lookup failure also answers null, never a thrown tool call.
 *
 * The system-before-user priority mirrors resolveReadAuth
 * (skatteverket/lib/resolve-auth.ts) through the same hasOmbudReadAccess;
 * not reused whole because callers need token metadata (createdAt, reconsent
 * status) that resolveReadAuth deliberately collapses into an auth result.
 */
export async function getSkvConnectionHealth(
  supabase: SupabaseClient,
  companyId: string,
  userId?: string,
): Promise<SkvConnectionHealth | null> {
  try {
    if (!isSkatteverketEnabled()) return null
    let health: SkvConnectionHealth
    if (await hasOmbudReadAccess(companyId)) {
      health = { status: 'active', source: 'system' }
    } else {
      const token = await findCompanyTokenUser(supabase, companyId)
      if (!token) return null
      health = token.needsReconsent
        ? {
            status: 'needs_reconsent',
            source: 'user',
            connected_at: token.createdAt,
            message: SKV_NEEDS_RECONSENT_MESSAGE,
          }
        : { status: 'active', source: 'user', connected_at: token.createdAt }
    }
    if (userId) {
      const filing = await getSkvFilingReadiness(supabase, companyId, userId)
      if (filing) health.filing = filing
    }
    return health
  } catch {
    return null
  }
}

interface FilingTokenRow {
  user_id: string
  status: string | null
  expires_at: string | null
  refresh_count: number | null
  has_refresh_token: boolean
}

/**
 * The caller's own session can still serve a Skatteverket call: not flagged
 * needs_reconsent (terminal until a new BankID consent), and either the
 * access token is still valid or the refresh token can still renew it (the
 * shared 65-minute rule in lib/skatteverket/session-lifetime.ts).
 */
function ownSessionIsLive(row: FilingTokenRow, now: number): boolean {
  if (row.status === 'needs_reconsent') return false
  const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : NaN
  if (Number.isFinite(expiresAt) && expiresAt > now) return true
  return isSkvSessionRefreshable(
    { expiresAt: row.expires_at, hasRefreshToken: row.has_refresh_token, refreshCount: row.refresh_count },
    now,
  )
}

/**
 * Whether the filing tools will work for this caller, and if not, the next
 * step. Filing uses only the caller's own token row (skvRequest in
 * gnubok_vat_declaration_validate/_submit, the approver's row at commit), so
 * another member's session is named, never used.
 *
 * "Another member's session" is the same pick as `status`: a row not flagged
 * needs_reconsent (findCompanyTokenUser's pool), most recent first, so the
 * message never contradicts the status line beside it.
 *
 * Read on the service role whichever client the door holds, as MCP reads it,
 * so every door gives the same answer. A session inside its refresh window
 * is decided by whether a refresh token is stored, and end-user roles have no
 * grant on that column (migration 20260929173432); profiles is self-only, so
 * another member's name is hidden from them too. The session client of the
 * wiki's context view and the in-app chat was refused on the token read, the
 * whole answer came back null, and those doors showed a briefing without the
 * filing line the agent got. Confined to `companyId`, which the door resolved
 * for the caller. Only the presence and the member's name leave this
 * function, never a token.
 *
 * Best-effort: null when the rows cannot be read.
 */
export async function getSkvFilingReadiness(
  _supabase: SupabaseClient,
  companyId: string,
  userId: string,
  now: number = Date.now(),
): Promise<SkvFilingReadiness | null> {
  try {
    const db = createServiceClientNoCookies()
    const { data, error } = await db
      .from('skatteverket_tokens')
      .select('user_id, status, expires_at, refresh_count, refresh_token')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false })
    if (error) return null
    const rows: FilingTokenRow[] = (
      (data ?? []) as Array<{
        user_id: string | null
        status: string | null
        expires_at: string | null
        refresh_count: number | null
        refresh_token: string | null
      }>
    ).flatMap((row) =>
      typeof row.user_id === 'string'
        ? [{
            user_id: row.user_id,
            status: row.status,
            expires_at: row.expires_at,
            refresh_count: row.refresh_count,
            // Only presence matters; the ciphertext goes no further.
            has_refresh_token: row.refresh_token != null,
          }]
        : [],
    )

    const own = rows.find((row) => row.user_id === userId)
    if (own && ownSessionIsLive(own, now)) return { ready: true, own_session: 'active' }

    const ownSession = own ? 'expired' : 'none'
    const other = rows.find((row) => row.user_id !== userId && row.status !== 'needs_reconsent')
    const holderName = other ? await memberName(db, other.user_id) : null
    return {
      ready: false,
      own_session: ownSession,
      message: filingMessage(ownSession, other ? { name: holderName } : null),
    }
  } catch {
    return null
  }
}

/** The member's preferred name (profiles.full_name); null when unknown. */
async function memberName(supabase: SupabaseClient, memberId: string): Promise<string | null> {
  try {
    const { data } = await supabase.from('profiles').select('full_name').eq('id', memberId).maybeSingle()
    const name = ((data as { full_name: string | null } | null)?.full_name ?? '').trim()
    return name || null
  } catch {
    return null
  }
}

/**
 * Why a Skatteverket READ found no live session, and the next step: the
 * refusal of gnubok_vat_declaration_status and gnubok_agi_status, which
 * answered Skatteverket's bare "Sessionen har gått ut" (167 times in 30
 * days) with no next step. A read runs on the caller's own BankID login
 * when they have one, else on the newest other member's (resolveUserReadAuth
 * picks with findCompanyTokenUser, as here), the AGI receipt read included
 * (crm#1263). So the message says "your own" only when it was, and names the
 * member otherwise.
 */
export async function skvReadSessionMessage(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<string> {
  const next =
    ' Next step: give the user the connect_url from gnubok_connect_skatteverket so they sign in with BankID. Do not retry until the user confirms.'
  // A lookup failure answers null too, so that branch never claims nobody connected.
  const token = await findCompanyTokenUser(supabase, companyId, { preferUserId: userId })
  if (!token) {
    return `No live Skatteverket session serves this company's reads: no member's BankID login is connected, or it could not be read.${next}`
  }
  const lapsed = 'and its session is no longer valid (personal logins expire by design, so this is normal)'
  if (token.userId === userId) {
    return `This read uses your own Skatteverket BankID login for this company, ${lapsed}.${next}`
  }
  const name = await memberName(supabase, token.userId)
  return (
    `This read uses the company's Skatteverket connection made by ${name ? `${name}, another member of the company` : 'another member of the company'}, ` +
    `${lapsed}. Any member's own BankID login serves the company's reads.${next}`
  )
}

function filingMessage(own: 'expired' | 'none', holder: { name: string | null } | null): string {
  const ownPart =
    own === 'expired'
      ? 'Your own Skatteverket BankID login for this company has expired (a personal login lasts about an hour, so this is normal).'
      : 'You have not connected your own Skatteverket BankID login for this company.'
  const holderPart = holder
    ? ` The company's active connection belongs to ${holder.name ? `${holder.name}, another member of the company` : 'another member of the company'}: it serves reads such as skattekonto and declaration status, but it is that person's own authorisation and is never used to validate or file for you.`
    : ''
  const alternative = holder ? `, or ask ${holder.name ?? 'that member'} to file from their own Accounted login` : ''
  return (
    `${ownPart}${holderPart} Momsdeklaration and AGI are validated and filed on the filer's own BankID login. ` +
    `Next step: give the user the connect_url from gnubok_connect_skatteverket so they sign in with BankID themselves${alternative}. ` +
    'Do not call the filing tools again until the user confirms.'
  )
}
