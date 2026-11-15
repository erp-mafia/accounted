/**
 * The räkenskapsår whose books show trade with other EU countries, for the
 * helårsmoms due date (CompanySettingsForDeadlines.eu_trade_fiscal_year_ends).
 *
 * Helårsmoms is due earlier for a year with EU trade (lib/reports/eu-trade.ts
 * helarsmomsHasEuTrade). The deadline rows used to read only the setting
 * "Handel med andra EU-länder", so a company that bought or sold within the
 * EU with the setting off got the later date on the deadline list, in the
 * calendar, the reminders, Betala via banken and the cash forecast, while the
 * VAT close check named the earlier one (2026-11-12: 209 companies with EU
 * trade booked in 2026 and a later open yearly deadline).
 *
 * The nightly pass (alignYearlyVatDeadlinesWithBooks) answers it from the
 * books the way the momsdeklaration does: the period's own rutor
 * (loadVatDeclarationLedger, the company's own momskoder included) and the
 * EU-trade boxes in them (hasEuTrade), and writes each period it read to
 * vat_eu_trade_fiscal_years, with the answer and when. The generator, the
 * repair job's detection and the filing record read only the periods recorded
 * with EU trade, so they agree with each other and none of them reads the
 * books.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadVatDeclarationLedger } from '@/lib/reports/vat-declaration'
import { hasEuTrade } from '@/lib/reports/eu-trade'
import { isMissingTableError } from '@/lib/bookkeeping/business-event-link'
import { dbError } from '@/lib/errors/db-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fiscalYearEndKey, type CompanySettingsForDeadlines, type DeadlineFiscalYear } from './deadline-config'

/**
 * Only a VAT-registered yearly filer that has not said it trades within the
 * EU has a date the books can move: with the setting on it is the earlier
 * date already, and no other period's date depends on EU trade.
 */
export function needsEuTradeEvidence(
  settings: Pick<CompanySettingsForDeadlines, 'vat_registered' | 'moms_period' | 'vat_has_eu_trade'>,
): boolean {
  return settings.vat_registered === true && settings.moms_period === 'yearly' && settings.vat_has_eu_trade !== true
}

function lastDayIso(fy: Pick<DeadlineFiscalYear, 'endYear' | 'endMonth'>): string {
  return new Date(Date.UTC(fy.endYear, fy.endMonth, 0)).toISOString().slice(0, 10)
}

/**
 * The keys (fiscalYearEndKey) of the given helårsmoms periods whose rutor
 * hold EU trade, read from each period's first day through its last. A period
 * that has not started yet is not read: nothing is booked in it. Throws on a
 * failed read.
 */
export async function fiscalYearsWithEuTrade(
  supabase: SupabaseClient,
  companyId: string,
  periods: readonly DeadlineFiscalYear[],
  today: string,
): Promise<string[]> {
  const found: string[] = []
  for (const period of periods) {
    if (period.start > today) continue
    const { rutor } = await loadVatDeclarationLedger(supabase, companyId, period.start, lastDayIso(period))
    if (hasEuTrade(rutor)) found.push(fiscalYearEndKey(period))
  }
  return found
}

/** The periods vat_eu_trade_fiscal_years records with EU trade, by company. */
export interface RecordedEuTradeYears {
  /** False while the table is not in the database yet (code deployed before its migration). */
  available: boolean
  byCompany: Map<string, string[]>
}

interface EuTradeRow {
  company_id: string
  fiscal_year_end: string
  has_eu_trade: boolean
  checked_at: string
}

async function readEuTradeRows(
  supabase: SupabaseClient,
  filter: { companyId?: string; withEuTradeOnly: boolean },
): Promise<EuTradeRow[] | null> {
  try {
    return await fetchAllRows<EuTradeRow>(({ from, to }) => {
      let query = supabase
        .from('vat_eu_trade_fiscal_years')
        .select('company_id, fiscal_year_end, has_eu_trade, checked_at')
      if (filter.companyId) query = query.eq('company_id', filter.companyId)
      if (filter.withEuTradeOnly) query = query.eq('has_eu_trade', true)
      return query
        .order('company_id', { ascending: true })
        .order('fiscal_year_end', { ascending: true })
        .range(from, to)
    })
  } catch (err) {
    // Deployed before the migration: nothing recorded yet.
    if (isMissingTableError(err as { code?: string })) return null
    throw err
  }
}

/**
 * Every company's periods recorded with EU trade (or one company's), keyed
 * like eu_trade_fiscal_year_ends. A missing table reads as nothing recorded,
 * so the deadline dates stay what the setting gives until the migration is in.
 */
export async function readRecordedEuTradeYears(
  supabase: SupabaseClient,
  companyId?: string,
): Promise<RecordedEuTradeYears> {
  const rows = await readEuTradeRows(supabase, { companyId, withEuTradeOnly: true })
  if (rows === null) return { available: false, byCompany: new Map() }
  const byCompany = new Map<string, string[]>()
  for (const row of rows) {
    const years = byCompany.get(row.company_id) ?? []
    years.push(row.fiscal_year_end)
    byCompany.set(row.company_id, years)
  }
  return { available: true, byCompany }
}

/** What the nightly pass knows per company: the periods with EU trade, and when each period read was made. */
export interface EuTradeChecks {
  available: boolean
  recorded: Map<string, string[]>
  checkedAt: Map<string, Map<string, string>>
}

/** Every row, for the nightly pass: which periods are settled and which were read longest ago. */
export async function readEuTradeChecks(supabase: SupabaseClient): Promise<EuTradeChecks> {
  const rows = await readEuTradeRows(supabase, { withEuTradeOnly: false })
  if (rows === null) return { available: false, recorded: new Map(), checkedAt: new Map() }
  const recorded = new Map<string, string[]>()
  const checkedAt = new Map<string, Map<string, string>>()
  for (const row of rows) {
    const byKey = checkedAt.get(row.company_id) ?? new Map<string, string>()
    byKey.set(row.fiscal_year_end, row.checked_at)
    checkedAt.set(row.company_id, byKey)
    if (row.has_eu_trade) recorded.set(row.company_id, [...(recorded.get(row.company_id) ?? []), row.fiscal_year_end])
  }
  return { available: true, recorded, checkedAt }
}

/**
 * Write what one read of the books found for each period. A period with EU
 * trade is recorded for good. A period without is written as checked, and
 * never over a yes: the update only touches rows that say no, so a later read
 * that misses the trade cannot undo one that saw it. A no also stands for a
 * read that failed (alignYearlyVatDeadlinesWithBooks): it only orders the
 * pass's queue, and the next read decides.
 */
export async function recordEuTradeChecks(
  supabase: SupabaseClient,
  companyId: string,
  checks: ReadonlyArray<{ key: string; hasEuTrade: boolean }>,
  now: Date = new Date(),
): Promise<void> {
  const checkedAt = now.toISOString()
  const withTrade = checks.filter((check) => check.hasEuTrade).map((check) => check.key)
  const without = checks.filter((check) => !check.hasEuTrade).map((check) => check.key)
  const table = 'vat_eu_trade_fiscal_years'
  if (withTrade.length > 0) {
    const { error } = await supabase.from(table).upsert(
      withTrade.map((key) => ({ company_id: companyId, fiscal_year_end: key, has_eu_trade: true, checked_at: checkedAt })),
      { onConflict: 'company_id,fiscal_year_end' },
    )
    if (error) throw dbError(error, 'Recording EU trade for helårsmoms failed')
  }
  if (without.length > 0) {
    const { error: insertError } = await supabase.from(table).upsert(
      without.map((key) => ({ company_id: companyId, fiscal_year_end: key, has_eu_trade: false, checked_at: checkedAt })),
      { onConflict: 'company_id,fiscal_year_end', ignoreDuplicates: true },
    )
    if (insertError) throw dbError(insertError, 'Recording an EU-trade check for helårsmoms failed')
    const { error: updateError } = await supabase
      .from(table)
      .update({ checked_at: checkedAt })
      .eq('company_id', companyId)
      .in('fiscal_year_end', without)
      .eq('has_eu_trade', false)
    if (updateError) throw dbError(updateError, 'Recording an EU-trade check for helårsmoms failed')
  }
}
