/**
 * The kontantmetoden year-end cut-off facts of one VAT period (#3440), for the
 * momsdeklaration checks (KONTANTMETOD_CUTOFF_INCOMPLETE,
 * LEGACY_KONTANTMETOD_VANDNING).
 *
 * Under kontantmetoden (bokslutsmetoden) the moms on invoices still unpaid at
 * the fiscal year end belongs to the VAT period that contains the year end:
 * the cut-off books it there. Filing that period before the cut-off is posted
 * leaves the moms out, and posting it afterwards needs a rättad
 * momsdeklaration. So the declaration warns while the cut-off of a fiscal year
 * ending inside the period is incomplete. A WARNING, never a gate: the
 * dashboard has no cut-off door yet and manual filing stays ungated.
 *
 * Server-only. Cheap for almost every company: one settings read, and the
 * assessment runs only for a cash company with an open fiscal year ending
 * inside the period.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { KontantmetodCutoffVatFacts } from '@/types'
import { assessKontantmetodCutoff } from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { findNextPeriod } from '@/lib/core/bookkeeping/period-service'
import { resolveCompanyEntityType } from '@/lib/company/entity-type'
import { createLogger } from '@/lib/logger'

const log = createLogger('kontantmetod-cutoff-vat-facts')

const LEGACY_KINDS = ['receivable', 'receivable_reversal', 'payable', 'payable_reversal'] as const

function previousDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/**
 * The facts for the VAT period [start, end], or undefined for a company that
 * does not use kontantmetoden. Never throws: a failed read comes back as
 * `unavailable`, which the check turns into its own warning.
 */
export async function fetchKontantmetodCutoffVatFacts(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
): Promise<KontantmetodCutoffVatFacts | undefined> {
  try {
    const { data: settings, error: settingsError } = await supabase
      .from('company_settings')
      .select('accounting_method, entity_type')
      .eq('company_id', companyId)
      .maybeSingle()
    if (settingsError) throw settingsError
    if (settings?.accounting_method !== 'cash') return undefined

    const [periodsRead, markersRead] = await Promise.all([
      supabase
        .from('fiscal_periods')
        .select('id, period_start, period_end, is_closed')
        .eq('company_id', companyId)
        .gte('period_end', start)
        .lte('period_end', end),
      supabase
        .from('kontantmetod_cutoff_entries')
        .select('kind, entry:journal_entries!inner(entry_date, status)')
        .eq('company_id', companyId)
        .in('kind', [...LEGACY_KINDS]),
    ])
    if (periodsRead.error) throw periodsRead.error
    if (markersRead.error) throw markersRead.error

    const legacyEnds = new Set<string>()
    for (const row of (markersRead.data ?? []) as Array<Record<string, unknown>>) {
      const entryValue = Array.isArray(row.entry) ? row.entry[0] : row.entry
      const entry = entryValue as { entry_date?: string; status?: string } | null
      if (!entry?.entry_date || entry.status !== 'posted') continue
      if (entry.entry_date < start || entry.entry_date > end) continue
      const kind = String(row.kind)
      legacyEnds.add(kind.endsWith('_reversal') ? previousDay(entry.entry_date) : entry.entry_date)
    }

    // A closed fiscal year can take no cut-off any more (readiness skips it
    // for the same reason), so it is not warned about.
    const yearEnds = ((periodsRead.data ?? []) as Array<{
      id: string
      period_start: string
      period_end: string
      is_closed: boolean | null
    }>).filter((p) => !p.is_closed)
    const incompleteYearEnds: KontantmetodCutoffVatFacts['incompleteYearEnds'] = []
    if (yearEnds.length > 0) {
      const entityType = await resolveCompanyEntityType(supabase, companyId, settings.entity_type)
      for (const period of yearEnds) {
        const next = await findNextPeriod(supabase, companyId, period.id)
        const assessment = await assessKontantmetodCutoff(
          supabase,
          companyId,
          period,
          next?.id ?? null,
          entityType,
        )
        if (!assessment.complete) {
          incompleteYearEnds.push({ fiscal_period_id: period.id, period_end: period.period_end })
        }
      }
    }

    return {
      incompleteYearEnds: incompleteYearEnds.sort((a, b) => a.period_end.localeCompare(b.period_end)),
      legacyCutoffPeriodEnds: [...legacyEnds].sort(),
    }
  } catch (err) {
    log.warn('kontantmetod cut-off facts for the VAT period could not be read', {
      companyId,
      start,
      end,
      error: err instanceof Error ? err.message : String(err),
    })
    return { incompleteYearEnds: [], legacyCutoffPeriodEnds: [], unavailable: true }
  }
}
