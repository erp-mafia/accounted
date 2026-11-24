import type { SupabaseClient } from '@supabase/supabase-js'
import { isAccountingMethod } from '@/lib/company/accounting-method'
import { createLogger } from '@/lib/logger'
import type { AccountingMethod, MomsPeriod } from '@/types'
import { voucherSeriesInUse } from './ledger-context'

const log = createLogger('agent-context/profile-line')

/**
 * How the company books, as the one sentence above the list of
 * Bokföringsregler: the accounting method, the VAT period and the voucher
 * series. The same values the bookkeeping profile shows (buildLedgerContext,
 * ledger-context.ts): company_settings.accounting_method and moms_period, and
 * the series of voucher_sequences. Read on their own here, without the
 * ledger statistics the profile also carries.
 *
 * A part the company has no value for is null (no series: an empty list),
 * and the sentence leaves it out. The VAT period is a value only for a
 * company registered for VAT.
 */
export interface ProfileFacts {
  method: AccountingMethod | null
  vatPeriod: MomsPeriod | null
  series: string[]
}

const VAT_PERIODS: readonly MomsPeriod[] = ['monthly', 'quarterly', 'yearly']

/** The facts from the two reads as PostgREST answers them. Pure. */
export function profileFactsFrom(
  settings: { accounting_method?: unknown; moms_period?: unknown; vat_registered?: unknown } | null | undefined,
  sequences: ReadonlyArray<{ voucher_series: unknown }> | null | undefined,
): ProfileFacts {
  const method = settings?.accounting_method
  const period = settings?.vat_registered === true ? settings?.moms_period : null
  return {
    method: isAccountingMethod(method) ? method : null,
    vatPeriod: (VAT_PERIODS as readonly unknown[]).includes(period) ? (period as MomsPeriod) : null,
    series: voucherSeriesInUse(sequences).filter((series) => typeof series === 'string' && series !== ''),
  }
}

/**
 * Reads the facts for one company. A read that fails gives null for what it
 * would have told, so the sentence says less instead of something untrue.
 */
export async function readProfileFacts(supabase: SupabaseClient, companyId: string): Promise<ProfileFacts> {
  const [settings, sequences] = await Promise.all([
    supabase.from('company_settings').select('vat_registered, moms_period, accounting_method').eq('company_id', companyId).maybeSingle(),
    supabase.from('voucher_sequences').select('voucher_series').eq('company_id', companyId),
  ])
  if (settings.error) log.warn('company_settings read failed', { companyId, error: settings.error.message })
  if (sequences.error) log.warn('voucher_sequences read failed', { companyId, error: sequences.error.message })
  return profileFactsFrom(settings.error ? null : settings.data, sequences.error ? null : sequences.data)
}

type Translate = (key: string, values?: Record<string, string | number>) => string

/**
 * The sentence, from the `rules` messages (profile_line and its three
 * parts), in the reader's language: the parts the company has a value for,
 * joined as a list; null when it has none. Pure.
 */
export function profileLine(facts: ProfileFacts, t: Translate, locale: string): string | null {
  const list = new Intl.ListFormat(locale === 'en' ? 'en-GB' : 'sv', { type: 'conjunction' })
  const parts: string[] = []
  if (facts.method) parts.push(t('profile_method', { method: facts.method }))
  if (facts.vatPeriod) parts.push(t('profile_vat', { period: facts.vatPeriod }))
  if (facts.series.length > 0) parts.push(t('profile_series', { count: facts.series.length, series: list.format(facts.series) }))
  return parts.length > 0 ? t('profile_line', { parts: list.format(parts) }) : null
}
