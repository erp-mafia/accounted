/**
 * Who may read their bank through Open Payments from this installation.
 *
 * Two questions, asked at every door that starts something new (a consent,
 * an account selection, a sync a person asks for):
 *
 *   1. Does the installation reach the account information provider at all?
 *      A connector key (lib/bank-feed/connect.ts): the Connect adapter on
 *      hosted and self-hosted alike.
 *   2. Is the company let in? OPENPAYMENTS_READING_COMPANY_IDS is the pilot
 *      switch and, unlike the payments one, it is OFF when unset or empty:
 *      Enable Banking stays the bank feed until a founder lists a company. A
 *      comma-separated list of company ids opens the door for exactly those
 *      companies, whatever their plan; `*` opens it for every company on a
 *      paid plan (CAPABILITY.bank_sync, the paid key of the bank services).
 *      Read on every call so a redeploy with a new value needs no restart.
 *
 * Polling, syncing on the cron and disconnecting a connection that already
 * exists never ask here: a consent a company signed must stay followable and
 * removable after it leaves the pilot, so those paths take the adapter from
 * getBankFeedConnect() directly.
 */

import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { OperationContext } from '@/lib/operations/types'
import { getBankFeedConnect, type BankFeedConnect } from './connect'

/** The environment as a plain map: process.env, or a test's object. */
export type BankFeedEnv = Readonly<Record<string, string | undefined>>

/** Why a company cannot read its bank through Open Payments right now. */
export type BankFeedUnavailableReason = 'no_connector' | 'not_in_pilot' | 'subscription'

export const BANK_FEED_UNAVAILABLE_REASONS = ['no_connector', 'not_in_pilot', 'subscription'] as const

export type BankFeedDoor =
  | { ok: true; connect: BankFeedConnect }
  | { ok: false; reason: BankFeedUnavailableReason }

/** The pilot switch, parsed: null = off, 'all' = every company on a paid plan, or the listed company ids. */
export type BankFeedPilot = null | 'all' | ReadonlySet<string>

export function bankFeedPilot(env: BankFeedEnv = process.env): BankFeedPilot {
  const raw = env.OPENPAYMENTS_READING_COMPANY_IDS?.trim()
  if (!raw) return null
  if (raw === '*') return 'all'
  const ids = raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  return ids.length ? new Set(ids) : null
}

/**
 * The adapter for a company that may read its bank through Open Payments, or
 * the reason it may not.
 */
export async function openBankFeedDoor(ctx: Pick<OperationContext, 'supabase' | 'companyId'>): Promise<BankFeedDoor> {
  const connect = getBankFeedConnect()
  if (!connect) return { ok: false, reason: 'no_connector' }
  const pilot = bankFeedPilot()
  if (!pilot) return { ok: false, reason: 'not_in_pilot' }
  if (pilot !== 'all') return pilot.has(ctx.companyId) ? { ok: true, connect } : { ok: false, reason: 'not_in_pilot' }
  if (await hasCapability(ctx.supabase, ctx.companyId, CAPABILITY.bank_sync)) return { ok: true, connect }
  return { ok: false, reason: 'subscription' }
}

/**
 * The pilot's answer for a company without the plan check: the cron asks the
 * capability for a whole batch at once (getCompanyIdsWithCapability) and
 * combines it with this.
 */
export function bankFeedPilotAdmits(companyId: string, env: BankFeedEnv = process.env): 'yes' | 'no' | 'with_capability' {
  const pilot = bankFeedPilot(env)
  if (!pilot) return 'no'
  if (pilot === 'all') return 'with_capability'
  return pilot.has(companyId) ? 'yes' : 'no'
}
