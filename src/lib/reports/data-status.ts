import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { countMissingUnderlagInPeriod, MISSING_UNDERLAG_MIN_GROSS_SEK } from '@/lib/documents/missing-underlag'
import { getLatestSignoffs } from '@/lib/reconciliation/signoff-store'
import { bankAccountKey } from '@/lib/reconciliation/schemas'

const log = createLogger('report-data-status')

/**
 * How far a report's numbers can be trusted, returned next to the numbers.
 *
 * A report tool used to answer "what is our result?" with a bare figure even
 * when half the month's bank rows had no verifikat, the bank feed had not
 * synced for a week, or the company uses kontantmetoden. Agents then rebuilt
 * the figure from raw journal lines or presented a preliminary number as
 * final. Every signal below already existed in a separate tool or resource;
 * this puts them on the report itself, over the report's own date range.
 */
export interface ReportDataStatus {
  computed_at: string
  /** The date range the counts below cover (the report's effective range). */
  range: { from: string; to: string }
  period: {
    period_id: string
    name: string
    /** State of the range end: closed period, locked (period or company lock date), or open. */
    status: 'open' | 'locked' | 'closed'
    /** Period locked_at, or the company lock date when that is what locks the range. */
    lock_date: string | null
  }
  accounting_method: 'accrual' | 'cash' | null
  /** Bank rows dated in the range with no verifikat (lib/transactions/unbooked.ts). */
  unbooked_transactions: number
  /** Draft journal entries dated in the range: not posted, not in the figures. */
  draft_entries: number
  /** Posted verifikat in the range of MISSING_UNDERLAG_MIN_GROSS_SEK or more with no underlag. */
  missing_underlag: number
  bank: {
    /** Latest successful bank feed sync over all connections, or null (no feed). */
    last_sync_at: string | null
    /** Earliest sign-off date across the company's bank accounts; null when any is unsigned or there are none. */
    reconciled_through: string | null
  }
  /** True when the figures can still change: open range, unbooked rows or drafts. */
  preliminary: boolean
  /** Short sentences to repeat when answering from these figures. */
  caveats: string[]
}

export type ReportDataStatusResult = ReportDataStatus | { unavailable: true; reason: string }

/** A bank feed older than this is called out when the range reaches past it. */
const STALE_SYNC_HOURS = 36

interface Options {
  periodId: string
  /** Inclusive range start; defaults to the period start. */
  fromDate?: string
  /** Inclusive range end; defaults to the period end. */
  toDate?: string
  now?: Date
}

/**
 * Build the data status for a report over [fromDate, toDate] inside a fiscal
 * period. Never throws: a report must still answer when a trust signal cannot
 * be read, so a failure comes back as { unavailable: true, reason }.
 */
export async function buildReportDataStatus(
  supabase: SupabaseClient,
  companyId: string,
  options: Options,
): Promise<ReportDataStatusResult> {
  try {
    return await build(supabase, companyId, options)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn('report data status unavailable', { companyId, reason })
    return { unavailable: true, reason }
  }
}

async function build(
  supabase: SupabaseClient,
  companyId: string,
  options: Options,
): Promise<ReportDataStatus> {
  const now = options.now ?? new Date()

  const [periodRes, settingsRes] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
      .eq('id', options.periodId)
      .single(),
    supabase
      .from('company_settings')
      .select('accounting_method, bookkeeping_locked_through')
      .eq('company_id', companyId)
      .maybeSingle(),
  ])
  if (periodRes.error || !periodRes.data) {
    throw new Error(`fiscal period read failed: ${periodRes.error?.message ?? 'not found'}`)
  }
  if (settingsRes.error) throw new Error(`company settings read failed: ${settingsRes.error.message}`)

  const period = periodRes.data as {
    id: string
    name: string
    period_start: string
    period_end: string
    is_closed: boolean | null
    locked_at: string | null
  }
  const settings = (settingsRes.data ?? null) as {
    accounting_method?: string | null
    bookkeeping_locked_through?: string | null
  } | null
  const from = options.fromDate ?? period.period_start
  const to = options.toDate ?? period.period_end

  const [unbooked, draftsRes, missingUnderlag, syncRes, reconciledThrough] = await Promise.all([
    countUnbookedBankTransactions(supabase, companyId, { fromDate: from, toDate: to }),
    supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .gte('entry_date', from)
      .lte('entry_date', to),
    countMissingUnderlagInPeriod(supabase, companyId, from, to),
    supabase
      .from('bank_connections')
      .select('last_synced_at')
      .eq('company_id', companyId)
      .not('last_synced_at', 'is', null)
      .order('last_synced_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    bankReconciledThrough(supabase, companyId),
  ])
  if (draftsRes.error) throw new Error(`draft entry count failed: ${draftsRes.error.message}`)
  if (syncRes.error && syncRes.error.code !== 'PGRST116') {
    throw new Error(`bank sync read failed: ${syncRes.error.message}`)
  }

  const lockThrough = settings?.bookkeeping_locked_through ?? null
  let status: ReportDataStatus['period']['status'] = 'open'
  let lockDate: string | null = null
  if (period.is_closed) {
    status = 'closed'
    lockDate = period.locked_at
  } else if (period.locked_at) {
    status = 'locked'
    lockDate = period.locked_at
  } else if (lockThrough && lockThrough >= to) {
    status = 'locked'
    lockDate = lockThrough
  }

  const method = settings?.accounting_method === 'cash' || settings?.accounting_method === 'accrual'
    ? settings.accounting_method
    : null
  const drafts = draftsRes.count ?? 0
  const lastSyncAt = (syncRes.data as { last_synced_at?: string | null } | null)?.last_synced_at ?? null

  const caveats: string[] = []
  if (status === 'open') {
    caveats.push(`Period ${period.name} is open: these figures can still change.`)
  }
  if (unbooked.total > 0) {
    caveats.push(`${unbooked.total} bank transaction(s) dated ${from} to ${to} have no verifikat yet, so they are not in these figures.`)
  }
  if (drafts > 0) {
    caveats.push(`${drafts} draft entr${drafts === 1 ? 'y' : 'ies'} in the range are not posted and not included.`)
  }
  if (method === 'cash') {
    caveats.push('Cash method (kontantmetoden): invoices are booked when paid, so unpaid customer and supplier invoices are not in these figures until year-end closing.')
  }
  if (lastSyncAt) {
    const ageHours = (now.getTime() - new Date(lastSyncAt).getTime()) / 3_600_000
    if (ageHours > STALE_SYNC_HOURS && to >= lastSyncAt.slice(0, 10)) {
      caveats.push(`The bank feed last synced ${lastSyncAt.slice(0, 10)}: bank transactions after that are not imported yet.`)
    }
  }
  if (reconciledThrough !== undefined && (reconciledThrough === null || reconciledThrough < to)) {
    caveats.push(
      reconciledThrough
        ? `Bank reconciliation is signed off only through ${reconciledThrough}.`
        : 'The bank accounts have no reconciliation sign-off covering this range.',
    )
  }
  if (missingUnderlag > 0) {
    caveats.push(`${missingUnderlag} verifikat of ${MISSING_UNDERLAG_MIN_GROSS_SEK} kr or more in the range have no underlag attached.`)
  }

  return {
    computed_at: now.toISOString(),
    range: { from, to },
    period: { period_id: period.id, name: period.name, status, lock_date: lockDate },
    accounting_method: method,
    unbooked_transactions: unbooked.total,
    draft_entries: drafts,
    missing_underlag: missingUnderlag,
    bank: { last_sync_at: lastSyncAt, reconciled_through: reconciledThrough ?? null },
    preliminary: status === 'open' || unbooked.total > 0 || drafts > 0,
    caveats,
  }
}

/**
 * Earliest active sign-off date across the company's enabled bank accounts
 * (reconnect duplicates on the same IBAN + currency count once, the newest
 * row, as on the Avstämning rail). null when any account has no sign-off;
 * undefined when the company has no bank account at all, so no caveat is
 * raised for a company that has nothing to reconcile.
 */
async function bankReconciledThrough(
  supabase: SupabaseClient,
  companyId: string,
): Promise<string | null | undefined> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, iban, currency, updated_at')
    .eq('company_id', companyId)
    .eq('enabled', true)
  if (error) throw new Error(`cash account read failed: ${error.message}`)
  const accounts = (data ?? []) as Array<{ id: string; iban: string | null; currency: string | null; updated_at: string | null }>
  if (accounts.length === 0) return undefined

  const live: string[] = []
  const byIban = new Map<string, (typeof accounts)[number]>()
  for (const a of accounts) {
    if (!a.iban) {
      live.push(a.id)
      continue
    }
    const key = `${a.iban}|${a.currency ?? 'SEK'}`
    const prev = byIban.get(key)
    if (!prev || (a.updated_at ?? '') > (prev.updated_at ?? '')) byIban.set(key, a)
  }
  for (const a of byIban.values()) live.push(a.id)

  const signoffs = await getLatestSignoffs(supabase, companyId)
  let earliest: string | null = null
  for (const id of live) {
    const through = signoffs.get(bankAccountKey(id))?.through_date ?? null
    if (!through) return null
    if (earliest === null || through < earliest) earliest = through
  }
  return earliest
}
