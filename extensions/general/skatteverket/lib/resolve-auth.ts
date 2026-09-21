import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import {
  isSkvSessionBeyondRecovery,
  isTerminalReconsentState,
} from '@/lib/skatteverket/session-lifetime'
import { getSkatteverketEnvironment, type SkvAuth } from './api-client'
import { getSystemAuthMode, isSystemAuthConfigured } from './system-auth/config'
import {
  getConnection,
  type SkvBehorighet,
  type SkvEnvironment,
} from './connection-store'

const log = createLogger('skatteverket-resolve-auth')

/**
 * Auth resolution for READ paths (skattekonto sync, kvittens polling, moms
 * inlamnat/beslutat checks, the skattekonto page's connected check).
 *
 * Preference order:
 *   1. System credentials, when SKATTEVERKET_SYSTEM_AUTH_MODE=on, the system
 *      flow is configured, and the company's connection row shows the
 *      required behorighet as granted for the current environment.
 *   2. A user token connected to the company. Token rows are per
 *      (user_id, company_id), so a company can hold one row per member who
 *      ran the BankID consent. The caller's own row is preferred when it
 *      exists; otherwise the most recently issued active row for the company
 *      is used. That is what lets member B read data member A connected
 *      (issue #1673): the fetched skattekonto/declaration data belongs to
 *      the company, not to the person who happened to press "Anslut".
 *
 * Who may read: any member of the company. Membership is enforced upstream
 * (the extension dispatcher resolves ctx.companyId from the caller's own
 * memberships, and the token table's SELECT policy is company-scoped), so no
 * extra role check is added here. Reads never move the row: refresh writes
 * go back to the token owner's row (auth.userId is the owner, not the
 * caller).
 *
 * Write paths (moms utkast/las, AGI submit/spara/granskningsunderlag) stay
 * hard-wired to user mode with the CALLER's own token: the personal flow
 * needs no ombud grant and the BankID signing step is personal by nature.
 * Connect/disconnect likewise only touch the caller's own row.
 *
 * Retiring user-token reads later (the full ombud switch) is a policy change
 * inside this function only.
 */

export function currentSkvEnvironment(): SkvEnvironment {
  return getSkatteverketEnvironment() === 'prod' ? 'production' : 'test'
}

export type ResolvedReadAuth =
  | {
      ok: true
      auth: SkvAuth
      source: 'system' | 'user'
      /** The token-owning user (notification recipient); null in pure system mode. */
      tokenUserId: string | null
    }
  | { ok: false; reason: 'no_token' | 'needs_reconsent' }

/** True when the company's connection row has the behorighet granted. */
export async function hasVerifiedGrant(
  companyId: string,
  behorighet: SkvBehorighet
): Promise<boolean> {
  const connection = await getConnection(companyId, currentSkvEnvironment())
  if (!connection) return false
  const grant =
    behorighet === 'lasombud' ? connection.lasombud_status : connection.moms_ombud_status
  return grant === 'granted' && ['verified', 'partial'].includes(connection.status)
}

export async function resolveReadAuth(
  supabase: SupabaseClient,
  companyId: string,
  opts: { requires: SkvBehorighet; userId?: string }
): Promise<ResolvedReadAuth> {
  if (getSystemAuthMode() === 'on' && isSystemAuthConfigured()) {
    if (await hasVerifiedGrant(companyId, opts.requires)) {
      return {
        ok: true,
        auth: { mode: 'system' },
        source: 'system',
        tokenUserId:
          opts.userId ?? (await findCompanyTokenUser(supabase, companyId))?.userId ?? null,
      }
    }
  }

  // The caller's own token wins when it exists; any other member's active
  // token serves otherwise. Passing userId no longer short-circuits to "the
  // caller's row or nothing": a member who never connected used to resolve
  // to their own missing row and see NOT_CONNECTED for a company that is
  // connected (#1673).
  const token = await findCompanyTokenUser(supabase, companyId, { preferUserId: opts.userId })
  if (!token) return { ok: false, reason: 'no_token' }
  if (token.needsReconsent) return { ok: false, reason: 'needs_reconsent' }

  return {
    ok: true,
    auth: { mode: 'user', supabase, userId: token.userId, companyId },
    source: 'user',
    tokenUserId: token.userId,
  }
}

export interface CompanyTokenUser {
  userId: string
  needsReconsent: boolean
  /**
   * When the serving row was issued (last consent or refresh; storeTokens is
   * DELETE + INSERT). Personal SKV sessions live ~65 minutes from this time,
   * so consumers (the agent briefing) can reason about likely expiry.
   */
  createdAt: string | null
  /**
   * The hourly session is spent and cannot be refreshed: a fresh BankID
   * consent is the only way back. Computed from the stored expiry rather than
   * read off a health flag, because ordinary expiry is not a health fault and
   * never latches one (#2567). Consumers that used to read needsReconsent for
   * "can we talk to SKV right now" must read this.
   */
  sessionBeyondRecovery: boolean
}

/**
 * Pick the token row that should serve a read for this company.
 *
 * Deterministic order:
 *   1. active rows before needs_reconsent rows (a dead row must not shadow a
 *      live one connected by another member)
 *   2. within the same status, the preferred user's own row first
 *   3. then the most recently issued row (storeTokens is DELETE + INSERT, so
 *      created_at is the last consent or refresh)
 *
 * Reads all of the company's rows (one per connected member; a handful at
 * most) instead of `.maybeSingle()`, which errors on the second row and used
 * to turn "two members connected" into "nobody connected" for everyone.
 *
 * Returns null when the company has no token row at all. The token table's
 * SELECT policy is company-scoped, so a user-session client only ever sees
 * rows for companies the caller belongs to.
 */
export async function findCompanyTokenUser(
  supabase: SupabaseClient,
  companyId: string,
  opts: { preferUserId?: string } = {}
): Promise<CompanyTokenUser | null> {
  const { data, error } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, status, created_at, expires_at, refresh_count, last_error_code')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })

  if (error) {
    log.warn('failed to look up company token rows', { companyId, error: error.message })
    return null
  }

  type TokenRow = {
    user_id: string
    status: string | null
    created_at: string | null
    expires_at: string | null
    refresh_count: number | null
    last_error_code: string | null
  }
  const rows = ((data ?? []) as Array<Partial<TokenRow>>).filter(
    (row): row is TokenRow => typeof row.user_id === 'string'
  )
  if (rows.length === 0) return null

  // A row latched with ordinary session expiry before #2567 is not a dead
  // row: it ranks with the active ones, exactly as it will once its owner
  // consents again.
  const active = rows.filter(row => !isTerminalReconsentState(row.status, row.last_error_code))
  const pool = active.length > 0 ? active : rows
  const own = opts.preferUserId ? pool.find(row => row.user_id === opts.preferUserId) : undefined
  const pick = own ?? pool[0]

  return {
    userId: pick.user_id,
    needsReconsent: isTerminalReconsentState(pick.status, pick.last_error_code),
    createdAt: pick.created_at ?? null,
    sessionBeyondRecovery: isSkvSessionBeyondRecovery({
      expiresAt: pick.expires_at,
      refreshCount: pick.refresh_count,
    }),
  }
}
