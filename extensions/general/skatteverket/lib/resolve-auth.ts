import type { SupabaseClient } from '@supabase/supabase-js'
import { getSkatteverketEnvironment, type SkvAuth } from './api-client'
import { getSystemAuthMode, isSystemAuthConfigured } from './system-auth/config'
import {
  getConnection,
  type SkvBehorighet,
  type SkvEnvironment,
} from './connection-store'

/**
 * Auth resolution for background READ paths (skattekonto sync, kvittens
 * polling, moms inlamnat/beslutat checks).
 *
 * Preference order:
 *   1. System credentials, when SKATTEVERKET_SYSTEM_AUTH_MODE=on, the system
 *      flow is configured, and the company's connection row shows the
 *      required behorighet as granted for the current environment.
 *   2. The company's user token (the pre-hybrid behavior), looked up by
 *      company_id like the kvittens cron always did.
 *
 * Write paths (moms utkast/las, AGI submit/spara/granskningsunderlag) stay
 * hard-wired to user mode: the personal flow needs no ombud grant and the
 * BankID signing step is personal by nature.
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
        tokenUserId: opts.userId ?? (await lookupTokenUser(supabase, companyId))?.userId ?? null,
      }
    }
  }

  if (opts.userId) {
    return {
      ok: true,
      auth: { mode: 'user', supabase, userId: opts.userId },
      source: 'user',
      tokenUserId: opts.userId,
    }
  }

  const token = await lookupTokenUser(supabase, companyId)
  if (!token) return { ok: false, reason: 'no_token' }
  if (token.needsReconsent) return { ok: false, reason: 'needs_reconsent' }

  return {
    ok: true,
    auth: { mode: 'user', supabase, userId: token.userId },
    source: 'user',
    tokenUserId: token.userId,
  }
}

async function lookupTokenUser(
  supabase: SupabaseClient,
  companyId: string
): Promise<{ userId: string; needsReconsent: boolean } | null> {
  // The token table is user-scoped (one BankID identity per user) but
  // carries company_id: match on company so a multi-company operator's
  // token is only used for the company that owns the work.
  const { data } = await supabase
    .from('skatteverket_tokens')
    .select('user_id, status')
    .eq('company_id', companyId)
    .maybeSingle()
  if (!data?.user_id) return null
  return {
    userId: data.user_id as string,
    needsReconsent: data.status === 'needs_reconsent',
  }
}
