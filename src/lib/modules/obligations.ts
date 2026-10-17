/**
 * Open obligations: what still has to be settled through a package before a
 * package that was switched off may disappear. Winding down (the
 * Profiles and Suggestions design, 2026-10-16): "off" closes the doors that
 * start new work and keeps the obligations running, so a switched-off
 * package with anything below still open resolves to `winding_down`
 * (./capabilities.ts): its pages, tools and Att göra rows stay reachable and
 * only its start doors refuse (./package-doors.ts). Once nothing is open it
 * resolves to `off` and disappears from the menu and tools/list.
 *
 * One small read-only probe per obligation, each answering "is there at
 * least one?" with a `limit(1)` read on an indexed company_id column (two
 * or three reads where one table cannot say it alone). Probes run only for
 * packages that are switched off, so a company with every package on, which
 * is every company that existed before profiles, never runs one.
 *
 * Conservative on purpose: a failed read counts its obligation as open (a
 * package stays visible a request longer), because hiding open work on a
 * guess is the worse error.
 *
 * Not the same list as package_open_obligations (migration 20261016200400),
 * which the "hide an unused package" detector reads: that one asks whether a
 * package is in use at all (an active employee counts), this one asks what
 * must be settled before the package may disappear (an employee does not:
 * the register also serves Utlägg, and Lön's work is the runs and the AGI).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addDaysIso, todayIsoStockholm } from '@/lib/dates/iso'
import { OPEN_ROT_RUT_PAYOUT_STATUSES } from '@/lib/invoices/rot-rut-payout-matching'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { agiReportingPeriod, formatAgiPeriodDashed } from '@/lib/salary/agi/reporting-period'
import { countInboxDocuments } from '@/lib/worklist/categories'
import type { PackageId } from './packages'
import type { SwitchablePackageId } from './profiles'

const log = createLogger('modules/obligations')

export const OBLIGATION_CODES = [
  'active_bank_connection',
  'unpaid_customer_invoices',
  'active_recurring_invoices',
  'open_collection_cases',
  'open_rot_rut_payout_requests',
  'unpaid_supplier_invoices',
  'payments_in_flight',
  'unhandled_documents',
  'unpaid_expense_claims',
  'unbooked_mileage',
  'open_salary_runs',
  'unfiled_agi',
  'unmatched_salary_payments',
  'active_assets',
  'active_pos_connection',
  'unbooked_pos_days',
  'active_webshop_connection',
  'unbooked_webshop_orders',
] as const

export type ObligationCode = (typeof OBLIGATION_CODES)[number]

/** The obligations each switchable package can have, in the order they are shown. */
export const PACKAGE_OBLIGATIONS: Readonly<Record<SwitchablePackageId, readonly ObligationCode[]>> = Object.freeze({
  bank: ['active_bank_connection'],
  'customer-invoices': [
    'unpaid_customer_invoices',
    'active_recurring_invoices',
    'open_collection_cases',
    'open_rot_rut_payout_requests',
  ],
  'supplier-invoices-and-payments': ['unpaid_supplier_invoices', 'payments_in_flight'],
  'receipts-and-documents': ['unhandled_documents'],
  expenses: ['unpaid_expense_claims', 'unbooked_mileage'],
  payroll: ['open_salary_runs', 'unfiled_agi', 'unmatched_salary_payments'],
  assets: ['active_assets'],
  'pos-and-webshop': [
    'active_pos_connection',
    'unbooked_pos_days',
    'active_webshop_connection',
    'unbooked_webshop_orders',
  ],
})

/**
 * What each obligation is, as a phrase that completes "det finns ..." (sv)
 * and "there are ..." (en): the agent briefing, the v1 package list and the
 * refusal text read these. The Anpassa page has its own copy in the
 * messages files (UI strings live there).
 */
export const OBLIGATION_LABELS: Readonly<Record<ObligationCode, { sv: string; en: string }>> = Object.freeze({
  active_bank_connection: { sv: 'en aktiv bankkoppling', en: 'an active bank connection' },
  unpaid_customer_invoices: { sv: 'obetalda kundfakturor', en: 'unpaid customer invoices' },
  active_recurring_invoices: { sv: 'aktiva återkommande fakturor', en: 'active recurring invoices' },
  open_collection_cases: { sv: 'öppna inkassoärenden', en: 'open collection cases' },
  open_rot_rut_payout_requests: {
    sv: 'ROT/RUT-begäranden där utbetalningen från Skatteverket inte är bokförd',
    en: 'ROT/RUT payout requests whose payout from Skatteverket is not yet booked',
  },
  unpaid_supplier_invoices: { sv: 'obetalda leverantörsfakturor', en: 'unpaid supplier invoices' },
  payments_in_flight: { sv: 'betalningar som är på väg', en: 'payments on their way' },
  unhandled_documents: { sv: 'underlag som inte är hanterade', en: 'documents not yet handled' },
  unpaid_expense_claims: { sv: 'utlägg som inte är utbetalda', en: 'expense claims not yet paid out' },
  unbooked_mileage: { sv: 'resor i körjournalen som inte är bokförda', en: 'mileage trips not yet booked' },
  open_salary_runs: { sv: 'lönekörningar som inte är betalda och bokförda', en: 'salary runs not yet paid and booked' },
  unfiled_agi: { sv: 'arbetsgivardeklarationer som inte är inlämnade', en: 'employer declarations (AGI) not yet filed' },
  unmatched_salary_payments: { sv: 'löneutbetalningar som inte är matchade mot banken', en: 'salary payouts not yet matched to the bank' },
  active_assets: { sv: 'inventarier som fortfarande skrivs av', en: 'fixed assets still being depreciated' },
  active_pos_connection: { sv: 'ett kopplat kassasystem', en: 'a connected point-of-sale system' },
  unbooked_pos_days: { sv: 'kassadagar som inte är bokförda', en: 'point-of-sale days not yet booked' },
  active_webshop_connection: { sv: 'en kopplad webbshop', en: 'a connected webshop' },
  unbooked_webshop_orders: { sv: 'webbshopsordrar som inte är bokförda', en: 'webshop orders not yet booked' },
})

export function isObligationCode(code: string): code is ObligationCode {
  return (OBLIGATION_CODES as readonly string[]).includes(code)
}

function joinSv(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} och ${parts[parts.length - 1]}`
}

function joinEn(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

/** "obetalda kundfakturor och öppna inkassoärenden": the obligations as one Swedish phrase. */
export function obligationsPhraseSv(codes: readonly string[]): string {
  return joinSv(codes.filter(isObligationCode).map((c) => OBLIGATION_LABELS[c].sv))
}

/** The obligations as one English phrase. */
export function obligationsPhraseEn(codes: readonly string[]): string {
  return joinEn(codes.filter(isObligationCode).map((c) => OBLIGATION_LABELS[c].en))
}

interface ProbeContext {
  supabase: SupabaseClient
  companyId: string
  /** Today in Stockholm (YYYY-MM-DD). */
  today: string
}

type Probe = (ctx: ProbeContext) => Promise<boolean>

/** How far back a salary payout is looked at for its AGI and its bank match. */
const RECENT_PAYOUT_DAYS = 92
/** The most rows a probe that has to look at rows reads; at the cap it answers open. */
const PROBE_ROW_CAP = 200

/** The read failed: the obligation counts as open. */
function failedOpen(code: ObligationCode, companyId: string, message: string | undefined): boolean {
  log.warn('obligation probe failed: counted as open', { code, companyId, error: message })
  return true
}

/** "Is there at least one row?" for one table and its filters. */
async function exists(
  code: ObligationCode,
  ctx: ProbeContext,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filter: (query: any) => any,
): Promise<boolean> {
  const query = ctx.supabase.from(table).select('id').eq('company_id', ctx.companyId)
  const { data, error } = await filter(query).limit(1)
  if (error) return failedOpen(code, ctx.companyId, error.message)
  return Array.isArray(data) && data.length > 0
}

interface RecentRun {
  id: string
  period_year: number
  period_month: number
  payment_date: string
  salary_entry_id: string | null
}

/**
 * An AGI not filed for a recent payout: a paid or booked run whose payout
 * month is the redovisningsperiod (lib/salary/agi/reporting-period.ts) and
 * that no filing signal covers: the kvittens stamp on the run, a submitted,
 * accepted or exported declaration for it, or the period's AGI deadline
 * completed (filed outside Accounted, agi-filings.mark). Older periods are
 * left to the deadline calendar (Viktiga datum, in Bokföring, never off),
 * which keeps asking for every AGI period whatever Lön's switch says.
 */
const unfiledAgi: Probe = async (ctx) => {
  const since = addDaysIso(ctx.today, -RECENT_PAYOUT_DAYS)
  const { data: runs, error } = await ctx.supabase
    .from('salary_runs')
    .select('id, period_year, period_month, payment_date')
    .eq('company_id', ctx.companyId)
    .in('status', ['paid', 'booked'])
    .is('agi_submitted_at', null)
    .gte('payment_date', since)
    .limit(PROBE_ROW_CAP)
  if (error) return failedOpen('unfiled_agi', ctx.companyId, error.message)
  const recent = (runs ?? []) as RecentRun[]
  if (recent.length === 0) return false
  const periodOf = (run: RecentRun) => formatAgiPeriodDashed(agiReportingPeriod(run))
  const [declarations, deadlines] = await Promise.all([
    ctx.supabase
      .from('agi_declarations')
      .select('salary_run_id')
      .eq('company_id', ctx.companyId)
      .in('salary_run_id', recent.map((r) => r.id))
      .in('status', ['submitted', 'accepted', 'exported']),
    ctx.supabase
      .from('deadlines')
      .select('tax_period')
      .eq('company_id', ctx.companyId)
      .eq('tax_deadline_type', 'arbetsgivardeklaration')
      .eq('is_completed', true)
      .in('tax_period', [...new Set(recent.map(periodOf))]),
  ])
  if (declarations.error) return failedOpen('unfiled_agi', ctx.companyId, declarations.error.message)
  if (deadlines.error) return failedOpen('unfiled_agi', ctx.companyId, deadlines.error.message)
  const filedRuns = new Set(((declarations.data ?? []) as Array<{ salary_run_id: string | null }>).map((d) => d.salary_run_id))
  const filedPeriods = new Set(((deadlines.data ?? []) as Array<{ tax_period: string }>).map((d) => d.tax_period))
  return recent.some((run) => !filedRuns.has(run.id) && !filedPeriods.has(periodOf(run)))
}

/**
 * A salary payout not matched to the bank: a recently booked run whose
 * salary voucher (net pay credited to the bank account, lib/salary/
 * salary-entries.ts) no bank line is linked to, while the company already
 * has bank lines from that payout date on, so the payout's line has
 * arrived and waits for its match.
 */
const unmatchedSalaryPayments: Probe = async (ctx) => {
  const since = addDaysIso(ctx.today, -RECENT_PAYOUT_DAYS)
  const { data: runs, error } = await ctx.supabase
    .from('salary_runs')
    .select('id, period_year, period_month, payment_date, salary_entry_id')
    .eq('company_id', ctx.companyId)
    .eq('status', 'booked')
    .not('salary_entry_id', 'is', null)
    .gte('payment_date', since)
    .lte('payment_date', ctx.today)
    .limit(PROBE_ROW_CAP)
  if (error) return failedOpen('unmatched_salary_payments', ctx.companyId, error.message)
  const booked = ((runs ?? []) as RecentRun[]).filter((r): r is RecentRun & { salary_entry_id: string } => !!r.salary_entry_id)
  if (booked.length === 0) return false
  const { data: linked, error: linkError } = await ctx.supabase
    .from('transactions')
    .select('journal_entry_id')
    .eq('company_id', ctx.companyId)
    .in('journal_entry_id', booked.map((r) => r.salary_entry_id))
  if (linkError) return failedOpen('unmatched_salary_payments', ctx.companyId, linkError.message)
  const matched = new Set(((linked ?? []) as Array<{ journal_entry_id: string | null }>).map((t) => t.journal_entry_id))
  const unmatched = booked.filter((r) => !matched.has(r.salary_entry_id))
  if (unmatched.length === 0) return false
  const earliest = unmatched.map((r) => r.payment_date).sort()[0]
  return exists('unmatched_salary_payments', ctx, 'transactions', (q) => q.gte('date', earliest))
}

interface AssetRow {
  id: string
  acquisition_cost: number | string
  salvage_value: number | string | null
  opening_accumulated_depreciation: number | string | null
}

/**
 * Fixed assets still being depreciated: an asset in the register, not
 * disposed, whose depreciable amount (cost less residual value, less what
 * was depreciated before it entered Accounted) exceeds the planenlig
 * depreciation already posted. A fully depreciated asset stays in the
 * register (BFNAR 2013:2 chapter 4) without work to do, and disposing of it
 * later is never refused.
 */
const activeAssets: Probe = async (ctx) => {
  const { data, error } = await ctx.supabase
    .from('assets')
    .select('id, acquisition_cost, salvage_value, opening_accumulated_depreciation')
    .eq('company_id', ctx.companyId)
    .is('disposed_at', null)
    .limit(PROBE_ROW_CAP)
  if (error) return failedOpen('active_assets', ctx.companyId, error.message)
  const rows = (data ?? []) as AssetRow[]
  if (rows.length >= PROBE_ROW_CAP) return true
  const depreciable = new Map<string, number>()
  for (const row of rows) {
    const amount = roundOre(
      Number(row.acquisition_cost) - Number(row.salvage_value ?? 0) - Number(row.opening_accumulated_depreciation ?? 0),
    )
    if (amount > 0) depreciable.set(row.id, amount)
  }
  if (depreciable.size === 0) return false
  const { data: posted, error: postedError } = await ctx.supabase
    .from('depreciation_schedules')
    .select('asset_id, planned_depreciation')
    .eq('company_id', ctx.companyId)
    .in('asset_id', [...depreciable.keys()])
    .not('journal_entry_id', 'is', null)
  if (postedError) return failedOpen('active_assets', ctx.companyId, postedError.message)
  for (const row of (posted ?? []) as Array<{ asset_id: string; planned_depreciation: number | string }>) {
    const left = depreciable.get(row.asset_id)
    if (left !== undefined) depreciable.set(row.asset_id, roundOre(left - Number(row.planned_depreciation)))
  }
  return [...depreciable.values()].some((left) => left > 0)
}

const PROBES: Readonly<Record<ObligationCode, Probe>> = {
  // Bank: a live connection keeps reading bank lines in; disconnecting it lives in the package.
  active_bank_connection: (ctx) =>
    exists('active_bank_connection', ctx, 'bank_connections', (q) => q.in('status', ['active', 'pending_selection', 'error'])),
  // Kundfakturor: a receivable still open, invoices still generated, cases
  // still open, Skatteverket's share of a ROT/RUT invoice still to arrive.
  unpaid_customer_invoices: (ctx) =>
    exists('unpaid_customer_invoices', ctx, 'invoices', (q) =>
      q.eq('document_type', 'invoice').in('status', ['sent', 'overdue', 'partially_paid'])),
  active_recurring_invoices: (ctx) =>
    exists('active_recurring_invoices', ctx, 'recurring_invoice_schedules', (q) => q.eq('status', 'active')),
  open_collection_cases: (ctx) => exists('open_collection_cases', ctx, 'collection_cases', (q) => q.eq('is_open', true)),
  // A begäran om utbetalning whose payout is not booked yet: the pool the
  // bank ingest's ROT/RUT matchers read (loadOpenRotRutPayoutRequests), so
  // Skatteverket's payout still finds its begäran while the package winds
  // down. Settled (a settlement voucher), rejected and cancelled do not count.
  open_rot_rut_payout_requests: (ctx) =>
    exists('open_rot_rut_payout_requests', ctx, 'rot_rut_payout_requests', (q) =>
      q.in('status', [...OPEN_ROT_RUT_PAYOUT_STATUSES]).is('settlement_journal_entry_id', null)),
  // Leverantörsfakturor och betalningar: a debt still to pay, a payment on its way.
  unpaid_supplier_invoices: (ctx) =>
    exists('unpaid_supplier_invoices', ctx, 'supplier_invoices', (q) =>
      q.eq('is_credit_note', false).in('status', ['registered', 'approved', 'partially_paid', 'overdue', 'disputed'])),
  payments_in_flight: (ctx) =>
    exists('payments_in_flight', ctx, 'payment_orders', (q) =>
      q.in('status', ['draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'])),
  // Kvitton och underlag: the Att göra inbox row's own predicate.
  unhandled_documents: async (ctx) => (await countInboxDocuments(ctx.supabase, ctx.companyId)) > 0,
  // Utlägg: people still to pay back, trips still to book.
  unpaid_expense_claims: (ctx) => exists('unpaid_expense_claims', ctx, 'expense_claims', (q) => q.eq('status', 'registered')),
  unbooked_mileage: (ctx) => exists('unbooked_mileage', ctx, 'mileage_trips', (q) => q.eq('status', 'draft')),
  // Lön: a run not yet paid and booked, its AGI, its bank match.
  open_salary_runs: (ctx) =>
    exists('open_salary_runs', ctx, 'salary_runs', (q) => q.in('status', ['draft', 'review', 'approved', 'paid'])),
  unfiled_agi: unfiledAgi,
  unmatched_salary_payments: unmatchedSalaryPayments,
  // Inventarier: depreciation still to post.
  active_assets: activeAssets,
  // Kassa och webbshop: connections still reading sales in, days and orders not booked.
  active_pos_connection: (ctx) =>
    exists('active_pos_connection', ctx, 'pos_connections', (q) => q.neq('status', 'disconnected')),
  unbooked_pos_days: (ctx) =>
    exists('unbooked_pos_days', ctx, 'pos_sales_days', (q) => q.in('status', ['ready', 'needs_review'])),
  active_webshop_connection: async (ctx) => {
    const found = await Promise.all(
      ['woocommerce_connections', 'shopify_connections', 'zettle_connections'].map((table) =>
        exists('active_webshop_connection', ctx, table, (q) => q.neq('status', 'revoked')),
      ),
    )
    return found.some(Boolean)
  },
  unbooked_webshop_orders: (ctx) =>
    exists('unbooked_webshop_orders', ctx, 'webshop_orders', (q) =>
      q
        .is('journal_entry_id', null)
        .is('invoice_id', null)
        .is('manually_booked_at', null)
        .or('is_paid.eq.true,row_type.eq.refund')),
}

/** Which of one package's obligations are open, in PACKAGE_OBLIGATIONS order. */
export async function probePackageObligations(
  supabase: SupabaseClient,
  companyId: string,
  packageId: SwitchablePackageId,
  options: { today?: string } = {},
): Promise<ObligationCode[]> {
  const ctx: ProbeContext = { supabase, companyId, today: options.today ?? todayIsoStockholm() }
  const codes = PACKAGE_OBLIGATIONS[packageId]
  const open = await Promise.all(
    codes.map((code) =>
      PROBES[code](ctx).catch((err: unknown) =>
        failedOpen(code, companyId, err instanceof Error ? err.message : String(err)),
      ),
    ),
  )
  return codes.filter((_, i) => open[i])
}

/**
 * The open obligations of the given packages, probed in parallel: every
 * requested package gets an entry, an empty list when nothing is open. A
 * package that is not switchable (Bokföring) is skipped: it never winds down.
 */
export async function loadOpenObligations(
  supabase: SupabaseClient,
  companyId: string,
  packageIds: readonly PackageId[],
  options: { today?: string } = {},
): Promise<Partial<Record<PackageId, ObligationCode[]>>> {
  const switchable = packageIds.filter((id): id is SwitchablePackageId => id in PACKAGE_OBLIGATIONS)
  const results = await Promise.all(
    switchable.map((id) => probePackageObligations(supabase, companyId, id, options)),
  )
  return Object.fromEntries(switchable.map((id, i) => [id, results[i]]))
}
