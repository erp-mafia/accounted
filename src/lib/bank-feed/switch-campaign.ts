/**
 * The switch campaign: every company whose bank feed still runs through
 * Enable Banking connects the bank again through Open Payments before a
 * deadline, and the product tells them, nudges them and lets a byrå nudge its
 * clients. This module is the one place that knows what the campaign is and
 * where a company stands in it; the worklist row, the notice line, the mails,
 * the byrå column and the counter all read from here.
 *
 *   - OPENPAYMENTS_SWITCH_DEADLINE (an ISO date) switches the campaign on;
 *     unset or malformed means off, everywhere, at once. Read on every call so
 *     a redeploy with a new value needs no restart.
 *   - OPENPAYMENTS_SWITCH_MAILS=true lets the reminder cron and the byrå
 *     action send mail. Without it the campaign is visible in the product
 *     and nothing leaves by mail.
 *   - A company's state is COMPUTED from its bank_connections rows, never
 *     stored: 'pending' when an active Enable Banking row at a bank Open
 *     Payments reaches has no Open Payments sibling yet, 'uncovered' when the
 *     only such rows are at banks Open Payments does not reach (file import
 *     is their path), 'done' otherwise. The dialog's switch supersedes the
 *     Enable Banking row (status revoked, superseded_by set), so a finished
 *     switch drops out of 'pending' without any write of ours.
 *   - The campaign applies only where the door is open (./door.ts): a company
 *     the pilot does not admit cannot act on a nudge, so it gets none.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { aggregatorOf } from '@/lib/bank-sync/aggregator'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getCompanyIdsWithCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { chunk } from '@/lib/utils'
import { bankCoveredByOpenPayments, UNCOVERED_BANK_NEEDLES } from './bank-coverage'
import { matchBankByName } from './bank-match'
import { getBankFeedConnect } from './connect'
import { bankFeedPilotAdmits, openBankFeedDoor, startingGrants, type BankFeedEnv } from './door'

export const SWITCH_DEADLINE_ENV = 'OPENPAYMENTS_SWITCH_DEADLINE'
export const SWITCH_MAILS_ENV = 'OPENPAYMENTS_SWITCH_MAILS'

/** Inside this many days of the deadline the worklist row moves to the top and the reminders start. */
export const SWITCH_URGENT_DAYS = 14
/** The days before the deadline on which the cron mails a reminder (once each). */
export const SWITCH_REMINDER_DAYS = [14, 7, 3, 1] as const

export type SwitchCampaign = { on: false; deadline: null } | { on: true; deadline: string }

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** The campaign as the environment declares it: on with its deadline, or off. */
export function switchCampaign(env: BankFeedEnv = process.env): SwitchCampaign {
  const raw = env[SWITCH_DEADLINE_ENV]?.trim()
  if (!raw || !ISO_DATE.test(raw)) return { on: false, deadline: null }
  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return { on: false, deadline: null }
  return { on: true, deadline: raw }
}

/** Whether the campaign may send mail at all (the cron and the byrå action both ask). */
export function switchMailsEnabled(env: BankFeedEnv = process.env): boolean {
  return env[SWITCH_MAILS_ENV]?.trim().toLowerCase() === 'true'
}

/** Whole Swedish calendar days from today to the deadline; 0 on the day, negative after. */
export function switchDaysLeft(deadline: string, now: Date = new Date()): number {
  return daysBetweenIso(todayIsoStockholm(now), deadline)
}

/**
 * The Enable Banking sunset: the campaign is on and its deadline has passed
 * (Stockholm calendar day). From that day the Enable Banking feed is over for
 * every company at once: the cron plans no Enable Banking connection, the
 * health probe stays home, the consent mails stop, and a sync asked for by a
 * person or an agent is refused with ENABLE_BANKING_SUNSET instead of a
 * provider call. Nothing changes on the deadline day itself (days_left 0) or
 * before it. Read from the environment on every call, like the campaign.
 */
export function enableBankingSunset(env: BankFeedEnv = process.env, now: Date = new Date()): boolean {
  const campaign = switchCampaign(env)
  return campaign.on && switchDaysLeft(campaign.deadline, now) < 0
}

/**
 * What a refused sync says (ENABLE_BANKING_SUNSET): the same sentence the
 * structured error registry carries as message_sv, pinned equal by test.
 */
export const ENABLE_BANKING_SUNSET_MESSAGE =
  'Den gamla bankkopplingen har upphört. Byt till ny koppling för att fortsätta hämta transaktioner.'

// The uncovered-bank list lives in ./bank-coverage (dependency-free, read in the browser too).
export { UNCOVERED_BANK_NEEDLES, bankCoveredByOpenPayments } from './bank-coverage'

/** The bank_connections columns the state is computed from. */
export const SWITCH_ROW_COLUMNS = 'id, company_id, bank_name, provider, aggregator, status, superseded_by'
/** Rows that still count as a connection: Enable Banking active ones, Open Payments ones in any live state. */
export const SWITCH_LIVE_STATUSES = ['active', 'pending_selection', 'expired', 'error'] as const

export interface SwitchConnectionRow {
  id: string
  company_id?: string
  bank_name: string | null
  provider?: string | null
  aggregator?: string | null
  status: string
  superseded_by?: string | null
}

export interface SwitchConnection {
  connection_id: string
  bank_name: string
}

export type SwitchState = 'done' | 'pending' | 'uncovered'

export interface CompanySwitchState {
  state: SwitchState
  /** Active Enable Banking rows at banks Open Payments reaches, without an Open Payments sibling: the ones to switch. */
  pending: SwitchConnection[]
  /** Active Enable Banking rows at banks Open Payments does not reach: file import is their path. */
  uncovered: SwitchConnection[]
  /** Live Open Payments connections (a switch made, or a bank connected anew). */
  open_payments: number
  /** The campaign deadline (ISO date). */
  deadline: string
  /** Whole days left to the deadline; 0 on the day, negative after. */
  days_left: number
  /** The deadline has passed: the Enable Banking feed has stopped. */
  passed: boolean
  /** Inside SWITCH_URGENT_DAYS of the deadline, or past it. */
  urgent: boolean
}

function liveEnableBanking(row: SwitchConnectionRow): boolean {
  return aggregatorOf(row) === 'enable_banking' && row.status === 'active' && !row.superseded_by
}

function liveOpenPayments(row: SwitchConnectionRow): boolean {
  return aggregatorOf(row) === 'open_payments' && (SWITCH_LIVE_STATUSES as readonly string[]).includes(row.status) && !row.superseded_by
}

/** Where one company stands, from its live bank_connections rows (pure: the tests and every reader share it). */
export function switchStateFrom(rows: readonly SwitchConnectionRow[], deadline: string, now: Date = new Date()): CompanySwitchState {
  const openPayments = rows.filter(liveOpenPayments).map((row) => ({ name: row.bank_name ?? '' })).filter((b) => b.name.trim().length > 0)
  const pending: SwitchConnection[] = []
  const uncovered: SwitchConnection[] = []
  for (const row of rows) {
    if (!liveEnableBanking(row)) continue
    const connection = { connection_id: row.id, bank_name: row.bank_name ?? '' }
    if (!bankCoveredByOpenPayments(row.bank_name)) {
      uncovered.push(connection)
      continue
    }
    if (matchBankByName(row.bank_name, openPayments)) continue
    pending.push(connection)
  }
  const daysLeft = switchDaysLeft(deadline, now)
  const passed = daysLeft < 0
  return {
    state: pending.length > 0 ? 'pending' : uncovered.length > 0 ? 'uncovered' : 'done',
    pending,
    uncovered,
    open_payments: rows.filter(liveOpenPayments).length,
    deadline,
    days_left: daysLeft,
    passed,
    urgent: passed || daysLeft <= SWITCH_URGENT_DAYS,
  }
}

export interface SwitchStateOptions {
  now?: Date
  env?: BankFeedEnv
}

/**
 * Where the company stands, or null when the campaign does not apply to it:
 * the campaign is off, or the door is closed (no connector, not in the pilot,
 * no paid plan). One read of bank_connections.
 */
export async function switchStateFor(
  ctx: { supabase: SupabaseClient; companyId: string },
  options: SwitchStateOptions = {},
): Promise<CompanySwitchState | null> {
  const campaign = switchCampaign(options.env)
  if (!campaign.on) return null
  const door = await openBankFeedDoor(ctx)
  if (!door.ok) return null
  const { data, error } = await ctx.supabase
    .from('bank_connections')
    .select(SWITCH_ROW_COLUMNS)
    .eq('company_id', ctx.companyId)
    .in('status', [...SWITCH_LIVE_STATUSES])
    .is('superseded_by', null)
  if (error) throw error
  return switchStateFrom((data ?? []) as SwitchConnectionRow[], campaign.deadline, options.now)
}

/**
 * The companies among `companyIds` the door admits, asked as a batch: the
 * pilot list answers alone when it names companies, and one capability read
 * covers every company when it says `*` (the door's grants, startingGrants).
 */
export async function admittedCompanyIds(supabase: SupabaseClient, companyIds: readonly string[], env: BankFeedEnv = process.env): Promise<Set<string>> {
  const ids = [...new Set(companyIds)]
  if (ids.length === 0 || !getBankFeedConnect()) return new Set()
  const admitted = new Set<string>()
  const needCapability: string[] = []
  for (const id of ids) {
    const answer = bankFeedPilotAdmits(id, env)
    if (answer === 'yes') admitted.add(id)
    else if (answer === 'with_capability') needCapability.push(id)
  }
  if (needCapability.length > 0) {
    const entitled = await getCompanyIdsWithCapability(supabase, needCapability, CAPABILITY.bank_sync, startingGrants(env))
    for (const id of entitled) admitted.add(id)
  }
  return admitted
}

/** Max ids per PostgREST .in() filter (mirrors lib/clients IN_CLAUSE_CHUNK). */
const IN_CLAUSE_CHUNK = 150

/**
 * Where several companies stand, in a handful of reads: the live rows of all
 * of them (every company with a live row when `companyIds` is null, which
 * only a service-role client can ask), then the door for the batch. A company
 * the door does not admit is left out; a listed company without rows is
 * 'done' with nothing to switch.
 */
export async function switchStatesForCompanies(
  supabase: SupabaseClient,
  companyIds: readonly string[] | null,
  options: SwitchStateOptions = {},
): Promise<Map<string, CompanySwitchState>> {
  const campaign = switchCampaign(options.env)
  if (!campaign.on) return new Map()
  const rows: SwitchConnectionRow[] = []
  const read = (ids: readonly string[] | null) =>
    fetchAllRows<SwitchConnectionRow>(({ from, to }) => {
      let query = supabase
        .from('bank_connections')
        .select(SWITCH_ROW_COLUMNS)
        .in('status', [...SWITCH_LIVE_STATUSES])
        .is('superseded_by', null)
      if (ids) query = query.in('company_id', [...ids])
      return query.order('id', { ascending: true }).range(from, to)
    })
  if (companyIds === null) {
    rows.push(...(await read(null)))
  } else {
    for (const ids of chunk([...new Set(companyIds)], IN_CLAUSE_CHUNK)) {
      rows.push(...(await read(ids)))
    }
  }
  const byCompany = new Map<string, SwitchConnectionRow[]>()
  for (const row of rows) {
    if (!row.company_id) continue
    const list = byCompany.get(row.company_id)
    if (list) list.push(row)
    else byCompany.set(row.company_id, [row])
  }
  const candidates = companyIds === null ? [...byCompany.keys()] : [...new Set(companyIds)]
  const admitted = await admittedCompanyIds(supabase, candidates, options.env)
  const result = new Map<string, CompanySwitchState>()
  for (const id of candidates) {
    if (!admitted.has(id)) continue
    result.set(id, switchStateFrom(byCompany.get(id) ?? [], campaign.deadline, options.now))
  }
  return result
}

// The deep link lives in ./switch-link (dependency-free, read in the browser too).
export { SWITCH_DEEP_LINK_PARAM, switchDeepLink, switchLinkFor } from './switch-link'

// ---------------------------------------------------------------------------
// The counter: bank_switch_progress() totals across companies (service role)
// ---------------------------------------------------------------------------

export interface BankSwitchProgressBank {
  bank: string
  pending: number
  uncovered: number
  switched: number
}

export interface BankSwitchProgressTotals {
  companies: { pending: number; uncovered: number; done: number }
  connections: { pending: number; uncovered: number; switched: number }
  banks: BankSwitchProgressBank[]
}

/**
 * Totals across every company, from the bank_switch_progress RPC (service
 * role only). The RPC takes the uncovered-bank list from here so the SQL and
 * the TypeScript never disagree on which banks are covered. The pilot is not
 * applied: the counter is about what is left on Enable Banking, wherever.
 */
export async function bankSwitchProgressTotals(service: SupabaseClient): Promise<BankSwitchProgressTotals> {
  const { data, error } = await service.rpc('bank_switch_progress', { p_uncovered: [...UNCOVERED_BANK_NEEDLES] })
  if (error) throw error
  const raw = (data ?? {}) as Partial<BankSwitchProgressTotals>
  return {
    companies: { pending: 0, uncovered: 0, done: 0, ...(raw.companies ?? {}) },
    connections: { pending: 0, uncovered: 0, switched: 0, ...(raw.connections ?? {}) },
    banks: Array.isArray(raw.banks) ? raw.banks : [],
  }
}

export interface BankSwitchProgress {
  campaign: { on: boolean; deadline: string | null; days_left: number | null; passed: boolean }
  /** The active company's state; null when the campaign does not apply to it. */
  company: CompanySwitchState | null
  /** Cross-company totals; null unless the caller may see them and a service client was given. */
  totals: BankSwitchProgressTotals | null
}

/**
 * The counter for the active company: the campaign, where this company
 * stands, and (with a service-role client) the totals across companies.
 */
export async function getBankSwitchProgress(
  ctx: { supabase: SupabaseClient; companyId: string },
  options: SwitchStateOptions & { totalsClient?: SupabaseClient | null } = {},
): Promise<BankSwitchProgress> {
  const campaign = switchCampaign(options.env)
  const now = options.now ?? new Date()
  const daysLeft = campaign.on ? switchDaysLeft(campaign.deadline, now) : null
  const company = campaign.on ? await switchStateFor(ctx, options) : null
  const totals = campaign.on && options.totalsClient ? await bankSwitchProgressTotals(options.totalsClient) : null
  return {
    campaign: { on: campaign.on, deadline: campaign.deadline, days_left: daysLeft, passed: daysLeft !== null && daysLeft < 0 },
    company,
    totals,
  }
}
