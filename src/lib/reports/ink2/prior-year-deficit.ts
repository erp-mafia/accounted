import type { SupabaseClient } from '@supabase/supabase-js'
import { resolvePreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import { truncateToWholeKronor } from '@/lib/money'

/**
 * Last year's underskott as this app's INK2 for that year declares it
 * (INK2S 4.16, carried to point 1.2), for a year whose 4.14 a is empty.
 *
 * Without the underskottsregister (BOLAGET), 4.14 a is only what the owner
 * types in the year-end step, so an owner who forgets it declares the whole
 * överskott and pays bolagsskatt on income the deficit should have covered.
 * The figure is not entered for them: Skatteverket's beslut fastställer the
 * underskott, which can differ (a beloppsspärr after an ownership change, a
 * deficit already used), so it is said, with where it comes from, and left to
 * the owner to enter.
 *
 * The previous fiscal year is the one ending the day before this one starts
 * (resolvePreviousFiscalPeriod): a deficit from a year across a gap is not
 * last year's.
 */
export interface PriorYearDeficit {
  fiscalPeriodName: string
  /** Whole kronor, INK2S 4.16 of that year. */
  deficit: number
}

export async function priorYearDeficit(
  supabase: SupabaseClient,
  companyId: string,
  current: { period_start: string; previous_period_id?: string | null },
  declarationOf: (fiscalPeriodId: string) => Promise<{ ink2s: { '7770': number } }>,
): Promise<PriorYearDeficit | null> {
  try {
    const previous = await resolvePreviousFiscalPeriod<{ id: string; name: string; period_end: string }>(
      supabase,
      companyId,
      { period_start: current.period_start, previous_period_id: current.previous_period_id ?? null },
      'id, name, period_end',
    )
    if (!previous) return null
    const deficit = truncateToWholeKronor((await declarationOf(previous.id)).ink2s['7770'] ?? 0)
    return deficit > 0 ? { fiscalPeriodName: previous.name, deficit } : null
  } catch {
    // Safe to ignore: this only adds a reminder. A year the engine cannot
    // read (no books, a foreign form) has no underskott to remind about, and
    // the declaration itself must not fail on it.
    return null
  }
}

/** The reminder, in the words the declaration and the tax proposal both use. */
export function priorYearDeficitWarning(hint: PriorYearDeficit): string {
  return `Förra räkenskapsåret (${hint.fiscalPeriodName}) slutade med ett underskott på ${hint.deficit} kr enligt dess deklaration i Accounted, men punkt 4.14a (outnyttjat underskott från föregående år) är 0 kr. Stämmer underskottet med slutskattebeskedet och har det inte redan utnyttjats: ange det under skattemässiga justeringar i bokslutets steg Dispositioner, så sjunker överskottet och skatten.`
}
