/**
 * Taxes: what has to be paid in to the skattekonto, and when.
 *
 * The money leaves the bank when the company pays in, not when Skatteverket
 * draws, so every charge is met first by what is on the skattekonto (the
 * synced saldo) and by the bank payments to it already under way, in the
 * order the charges fall due; only the rest is a bank outflow, on the day the
 * charge is due (62 kap. 3 § SFL).
 *
 * Where each charge comes from, so that each krona counts once:
 *
 *   - Skatteverket's own upcoming debits (skattekonto_transactions, status
 *     upcoming), when the company syncs its skattekonto: debited preliminary
 *     tax and every declaration already filed are in them.
 *   - F-skatt (company_settings.preliminary_tax_monthly) on its förfallodag,
 *     from the first one the company states (preliminary_tax_first_due_date),
 *     unless Skatteverket's upcoming debits already hold preliminary tax that
 *     day.
 *   - Each momsdeklaration due inside the horizon: as filed (known) when it is
 *     filed and the skattekonto is not synced; as the books show it so far
 *     (an estimate) when it is not filed yet, the open period included.
 *   - Each AGI due inside the horizon: as declared when it is on record and
 *     not yet paid (left to Skatteverket's debits once filed on a synced
 *     skattekonto); else the month's salary runs, or the salary estimate
 *     (./salary.ts) for a month without one.
 *
 * A refund (negative ruta 49) and Skatteverket's credits are not projected:
 * they land on the skattekonto, not in the bank.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import { resolveSkattekontoSource } from '@/lib/payments/orders/skattekonto-sources'
import { getAgiPaymentDueDate, TAX_DEADLINE_CONFIGS, type CompanySettingsForDeadlines } from '@/lib/tax/deadline-config'
import { getNextBankingDay } from '@/lib/tax/swedish-holidays'
import { vatPeriodDeadline } from '@/lib/vat/filing-record-store'
import { addMonths, monthOf, monthsBetween } from '../calendar'
import type { CashFlow, CashFlowKind, CashFlowRef, ForecastCaveat, ForecastWindow } from '../types'
import type { SalaryTaxBasis } from './salary'

export interface TaxCharge {
  due_date: string
  /** SEK, > 0. */
  amount: number
  kind: CashFlowKind
  source: 'skattekonto' | 'vat' | 'agi' | 'f_skatt'
  estimate: boolean
  reference: string | null
  ref: CashFlowRef | null
}

/**
 * The bank outflows the charges need: each met first by `available` (the
 * skattekonto saldo plus payments to it under way), in due order.
 */
export function taxOutflows(charges: readonly TaxCharge[], available: number, window: ForecastWindow): CashFlow[] {
  const flows: CashFlow[] = []
  let left = Math.max(0, roundOre(available))
  const ordered = charges
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.due_date === b.c.due_date ? a.i - b.i : a.c.due_date < b.c.due_date ? -1 : 1))
  for (const { c } of ordered) {
    const covered = Math.min(left, c.amount)
    left = roundOre(left - covered)
    const amount = roundOre(c.amount - covered)
    const date = c.due_date < window.today ? window.today : c.due_date
    if (amount <= 0 || date > window.end) continue
    flows.push({
      date,
      direction: 'out',
      amount,
      kind: c.kind,
      source: c.source,
      estimate: c.estimate,
      counterparty: 'Skatteverket',
      reference: c.reference,
      ref: c.ref,
      confidence: null,
    })
  }
  return flows
}

export interface UpcomingSkattekontoRow {
  due_date: string
  /** Skatteverket's sign: negative is a debit. */
  amount: number
  text: string
}

export interface VatPeriodDue {
  /** YYYY-MM, YYYY-QN or the räkenskapsår label. */
  period: string
  due_date: string
  /** Ruta 49, signed: negative is a refund. */
  declared: number
  filed: boolean
  /** The period has not ended: the books so far. */
  open: boolean
}

export interface AgiMonthDue {
  /** YYYY-MM, the redovisningsperiod. */
  month: string
  due_date: string
  /** The declaration's tax plus avgifter, or null when there is no declaration on record. */
  declared: number | null
  filed: boolean
  paid: boolean
}

const PRELIMINARY_TAX = /preliminärskatt/i

/** Every charge inside the horizon, each krona from one source (see the file comment). */
export function taxCharges(input: {
  synced: boolean
  upcoming: readonly UpcomingSkattekontoRow[]
  fSkattMonthly: number | null
  fSkattDueDates: readonly string[]
  vat: readonly VatPeriodDue[]
  agi: readonly AgiMonthDue[]
  salaryBasis: ReadonlyMap<string, SalaryTaxBasis>
  window: ForecastWindow
}): TaxCharge[] {
  const { window } = input
  const inWindow = (d: string) => d >= window.today && d <= window.end
  const charges: TaxCharge[] = []

  const upcoming = input.synced ? input.upcoming.filter((r) => inWindow(r.due_date)) : []
  for (const row of upcoming) {
    if (!(row.amount < 0)) continue
    charges.push({
      due_date: row.due_date,
      amount: roundOre(-row.amount),
      kind: 'known',
      source: 'skattekonto',
      estimate: false,
      reference: row.text,
      ref: { type: 'skattekonto', id: row.due_date },
    })
  }

  const fSkatt = roundOre(input.fSkattMonthly ?? 0)
  if (fSkatt > 0) {
    for (const due of input.fSkattDueDates.filter(inWindow)) {
      if (upcoming.some((r) => r.due_date === due && PRELIMINARY_TAX.test(r.text))) continue
      charges.push({ due_date: due, amount: fSkatt, kind: 'known', source: 'f_skatt', estimate: false, reference: monthOf(due), ref: null })
    }
  }

  for (const v of input.vat) {
    if (!inWindow(v.due_date) || v.declared <= 0) continue
    if (v.filed && input.synced) continue
    charges.push({
      due_date: v.due_date,
      amount: roundOre(v.declared),
      kind: v.filed ? 'known' : 'derived',
      source: 'vat',
      estimate: !v.filed,
      reference: v.period,
      ref: { type: 'vat_period', id: v.period },
    })
  }

  for (const a of input.agi) {
    if (!inWindow(a.due_date) || a.paid) continue
    if (a.declared !== null) {
      if (a.filed && input.synced) continue
      if (a.declared <= 0) continue
      charges.push({
        due_date: a.due_date,
        amount: roundOre(a.declared),
        kind: a.filed ? 'known' : 'derived',
        source: 'agi',
        estimate: false,
        reference: a.month,
        ref: { type: 'agi_period', id: a.month },
      })
      continue
    }
    const basis = input.salaryBasis.get(a.month)
    const amount = basis ? roundOre(basis.tax + basis.avgifter) : 0
    if (amount <= 0) continue
    charges.push({
      due_date: a.due_date,
      amount,
      kind: 'derived',
      source: 'agi',
      estimate: basis!.estimate,
      reference: a.month,
      ref: { type: 'agi_period', id: a.month },
    })
  }
  return charges
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

interface TaxSettings {
  vat_registered: boolean | null
  moms_period: 'monthly' | 'quarterly' | 'yearly' | null
  vat_taxable_base_over_40m: boolean | null
  preliminary_tax_monthly: number | string | null
  preliminary_tax_first_due_date: string | null
}

export interface LoadedTaxInputs {
  synced: boolean
  saldo: number
  snapshotFetchedAtMs: number | null
  upcoming: UpcomingSkattekontoRow[]
  fSkattMonthly: number | null
  fSkattDueDates: string[]
  vat: VatPeriodDue[]
  agi: AgiMonthDue[]
  caveats: ForecastCaveat[]
}

const ymd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The F-skatt förfallodagar inside the window, as the deadline calendar places them, moved to a banking day. */
export function fSkattDueDates(
  window: ForecastWindow,
  settings: Pick<TaxSettings, 'vat_registered' | 'vat_taxable_base_over_40m'> &
    Partial<Pick<TaxSettings, 'preliminary_tax_first_due_date'>>,
): string[] {
  const config = TAX_DEADLINE_CONFIGS.find((c) => c.type === 'f_skatt')
  if (!config) return []
  const generatorSettings = {
    vat_registered: settings.vat_registered === true,
    vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m === true,
    preliminary_tax_first_due_date: settings.preliminary_tax_first_due_date ?? null,
  } as CompanySettingsForDeadlines
  const years = [...new Set([Number(window.today.slice(0, 4)), Number(window.end.slice(0, 4))])]
  return years
    .flatMap((year) => config.generateDates(year, generatorSettings))
    // Local noon: the day never shifts whatever the process time zone is.
    .map((i) => ymd(getNextBankingDay(new Date(i.year, i.month, i.day, 12))))
    .filter((d) => d >= window.today && d <= window.end)
}

type VatSource = { kind: 'vat_declaration'; periodType: 'monthly' | 'quarterly' | 'yearly'; year: number; period: number }

/** The moms periods whose payment could fall inside the window. */
function vatCandidates(momsPeriod: TaxSettings['moms_period'], window: ForecastWindow): VatSource[] {
  const months = monthsBetween(addMonths(monthOf(window.today), -3), monthOf(window.end))
  if (momsPeriod === 'monthly') {
    return months.map((m) => ({ kind: 'vat_declaration', periodType: 'monthly', year: Number(m.slice(0, 4)), period: Number(m.slice(5, 7)) }))
  }
  if (momsPeriod === 'quarterly') {
    const quarters = new Map<string, VatSource>()
    for (const m of months) {
      const year = Number(m.slice(0, 4))
      const quarter = Math.ceil(Number(m.slice(5, 7)) / 3)
      quarters.set(`${year}-${quarter}`, { kind: 'vat_declaration', periodType: 'quarterly', year, period: quarter })
    }
    return [...quarters.values()]
  }
  if (momsPeriod === 'yearly') {
    const year = Number(window.today.slice(0, 4))
    return [year - 1, year, year + 1].map((y) => ({ kind: 'vat_declaration', periodType: 'yearly', year: y, period: 1 }))
  }
  return []
}

async function loadVat(
  supabase: SupabaseClient,
  companyId: string,
  settings: TaxSettings,
  window: ForecastWindow,
): Promise<VatPeriodDue[]> {
  if (settings.vat_registered !== true) return []
  const out: VatPeriodDue[] = []
  for (const source of vatCandidates(settings.moms_period, window)) {
    // A cheap look at the deadline first; only a period due inside the window is computed from the books.
    const placed = await vatPeriodDeadline(supabase, companyId, { periodType: source.periodType, year: source.year, period: source.period })
    if (!placed.due_date || placed.due_date < window.today || placed.due_date > window.end) continue
    const resolved = await resolveSkattekontoSource(supabase, companyId, source, window.today)
    if (!resolved.ok) throw Object.assign(new Error(`VAT declaration ${placed.tax_period} could not be computed`), { code: resolved.code })
    out.push({
      period: resolved.due.tax_period,
      due_date: resolved.due.due_date ?? placed.due_date,
      declared: resolved.due.declared,
      filed: resolved.due.filed,
      open: resolved.due.nothing_due === 'period_not_ended',
    })
  }
  return out
}

async function loadAgi(
  supabase: SupabaseClient,
  companyId: string,
  settings: TaxSettings,
  window: ForecastWindow,
): Promise<AgiMonthDue[]> {
  const out: AgiMonthDue[] = []
  const dueSettings = {
    vat_registered: settings.vat_registered === true,
    vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m === true,
  }
  for (const month of monthsBetween(addMonths(monthOf(window.today), -2), monthOf(window.end))) {
    const year = Number(month.slice(0, 4))
    const m = Number(month.slice(5, 7))
    const due = getAgiPaymentDueDate(year, m, dueSettings)
    if (!due || due < window.today || due > window.end) continue
    const resolved = await resolveSkattekontoSource(supabase, companyId, { kind: 'agi', year, month: m }, window.today)
    if (!resolved.ok) {
      // No declaration on record: the salary runs or the estimate (./salary.ts) carry the month.
      out.push({ month, due_date: due, declared: null, filed: false, paid: false })
      continue
    }
    out.push({
      month,
      due_date: resolved.due.due_date ?? due,
      declared: resolved.due.declared,
      filed: resolved.due.filed,
      paid: resolved.due.nothing_due === 'already_paid',
    })
  }
  return out
}

export async function loadTaxInputs(supabase: SupabaseClient, companyId: string, window: ForecastWindow): Promise<LoadedTaxInputs> {
  const [settingsRes, snapshotRes, upcomingRes] = await Promise.all([
    supabase
      .from('company_settings')
      .select('vat_registered, moms_period, vat_taxable_base_over_40m, preliminary_tax_monthly, preliminary_tax_first_due_date')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('extension_data')
      .select('value')
      .eq('company_id', companyId)
      .eq('extension_id', 'skatteverket')
      .eq('key', 'skattekonto_balance_snapshot')
      .maybeSingle(),
    supabase
      .from('skattekonto_transactions')
      .select('transaktionsdatum, forfallodatum, belopp_skatteverket, transaktionstext')
      .eq('company_id', companyId)
      .eq('status', 'upcoming'),
  ])
  for (const res of [settingsRes, snapshotRes, upcomingRes]) {
    if (res.error) throw Object.assign(new Error(`tax read failed: ${res.error.message}`), { code: res.error.code })
  }
  const settings = (settingsRes.data ?? {
    vat_registered: null,
    moms_period: null,
    vat_taxable_base_over_40m: null,
    preliminary_tax_monthly: null,
    preliminary_tax_first_due_date: null,
  }) as TaxSettings
  const snapshot = snapshotRes.data?.value as { saldo?: { saldoSkatteverket?: unknown }; fetchedAt?: unknown } | null | undefined
  const rawSaldo = Number(snapshot?.saldo?.saldoSkatteverket)
  const synced = !!snapshot && Number.isFinite(rawSaldo)
  const fetchedAtMs = typeof snapshot?.fetchedAt === 'number' ? snapshot.fetchedAt : null

  const [vat, agi] = await Promise.all([loadVat(supabase, companyId, settings, window), loadAgi(supabase, companyId, settings, window)])
  const caveats: ForecastCaveat[] = []
  if (!synced) {
    caveats.push({
      code: 'SKATTEKONTO_NOT_SYNCED',
      message_sv:
        'Skattekontot är inte kopplat till Skatteverket, så saldot där är okänt: prognosen räknar med att varje skatt betalas in från banken.',
      message_en:
        'The skattekonto is not connected to Skatteverket, so its saldo is unknown: the forecast assumes every tax is paid in from the bank.',
    })
  }
  if (vat.some((v) => !v.filed && v.declared > 0)) {
    caveats.push({
      code: 'VAT_ESTIMATED',
      message_sv: 'Momsen för perioder som inte är deklarerade är uppskattad från bokföringen hittills.',
      message_en: 'VAT for periods not yet declared is estimated from the books so far.',
    })
  }
  return {
    synced,
    saldo: synced ? roundOre(rawSaldo) : 0,
    snapshotFetchedAtMs: fetchedAtMs,
    upcoming: ((upcomingRes.data ?? []) as Array<{
      transaktionsdatum: string
      forfallodatum: string | null
      belopp_skatteverket: number | string
      transaktionstext: string
    }>).map((r) => ({
      due_date: r.forfallodatum ?? r.transaktionsdatum,
      amount: Number(r.belopp_skatteverket),
      text: r.transaktionstext,
    })),
    fSkattMonthly: settings.preliminary_tax_monthly === null ? null : Number(settings.preliminary_tax_monthly),
    fSkattDueDates: fSkattDueDates(window, settings),
    vat,
    agi,
    caveats,
  }
}
