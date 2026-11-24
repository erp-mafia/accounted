import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BookkeepingDatabaseError,
  EntryAlreadyReversedError,
  EntryDateOutsideFiscalPeriodError,
  FiscalPeriodNotFoundError,
  NoOpenPeriodForDateError,
  TargetPeriodClosedError,
  TargetPeriodLockedError,
} from '@/lib/bookkeeping/errors'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { DATE_FIXED_SOURCE_TYPES } from './date-fixed-source-types'
import { firstBookableDate, type BookableFiscalPeriod } from './period-status'
import { resolvePeriodStatusForDate } from './period-service'

/** Where a storno lands (assertStornoTarget). */
export interface StornoTarget {
  /** The storno's date. */
  date: string
  /** The fiscal year the storno is booked and numbered in. */
  fiscal_period_id: string
  /**
   * The original's own date takes no write (its year is closed or locked, or
   * the date is on or before the company lock date), so the storno is dated
   * in the first open, unlocked period after it. The original then stays as
   * it was booked: nothing is written to it.
   */
  moved: boolean
}

export interface StornoTargetOptions {
  /**
   * When the original's own date takes no write, date the storno in the first
   * open, unlocked period after it instead of refusing. Ignored when a date
   * is asked for, and for DATE_FIXED_SOURCE_TYPES.
   */
  inFirstOpenPeriodWhenLocked?: boolean
}

/**
 * Where a storno of a posted verifikat lands, checked before its voucher
 * number is drawn.
 *
 * Normally the storno is numbered in the original's series and attributed to
 * the original's fiscal year (reverseEntry, correctEntry), so its date must
 * lie inside that year too: a rättelse is its own verifikation in a period
 * whose work is not closed, and verifikationsnummer run unbroken per series
 * within the räkenskapsår (BFL 5 kap 5 §, BFNAR 2013:2 p. 2.17-2.18). A date
 * outside it put a 2026 storno into the 2025 series: the trial balance (by
 * period) counted it in 2025, the VAT report (by date) in 2026.
 *
 * Past a close, a lock or the company lock date the original's year takes no
 * storno. With `inFirstOpenPeriodWhenLocked` (the person's correction doors)
 * the storno is then a rättelsepost in the first open, unlocked period after
 * the original instead (correctionDateInFirstOpenPeriod), numbered in that
 * year's series.
 *
 * Returns the target, or throws:
 *   - EntryAlreadyReversedError (409): a posted storno already reverses the
 *     original. A moved storno leaves the original 'posted', so its status
 *     alone does not say so;
 *   - EntryDateOutsideFiscalPeriodError (400): the date is outside the
 *     original's fiscal year;
 *   - TargetPeriodClosedError (409): that year is closed, and the storno is
 *     not moved;
 *   - TargetPeriodLockedError (409): the year is locked, or the date is on or
 *     before the company lock date, and the storno is not moved. Also when
 *     the lock lookup fails: resolvePeriodStatusForDate fails closed;
 *   - NoOpenPeriodForDateError (400): moved, but no fiscal year covers the
 *     first open day after the original (the next year is not created yet).
 *
 * Refusing here, before anything is written, gives a refused storno a typed
 * answer and leaves no draft behind. It once also kept a refused storno from
 * burning a number (the number was drawn before the insert); the storno is
 * now numbered by commit_journal_entry when it is posted.
 */
export async function assertStornoTarget(
  supabase: SupabaseClient,
  companyId: string,
  original: { id: string; fiscal_period_id: string; entry_date: string; source_type?: string | null },
  date?: string,
  options?: StornoTargetOptions,
): Promise<StornoTarget> {
  await assertNoStandingStorno(supabase, companyId, original.id)

  const target = date ?? original.entry_date

  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('name, period_start, period_end')
    .eq('id', original.fiscal_period_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error || !period) throw new FiscalPeriodNotFoundError()

  if (target < period.period_start || target > period.period_end) {
    throw new EntryDateOutsideFiscalPeriodError(target, period.name, period.period_start, period.period_end)
  }

  const status = await resolvePeriodStatusForDate(supabase, companyId, target)
  if (status.status === 'open') {
    return { date: target, fiscal_period_id: original.fiscal_period_id, moved: false }
  }

  const movable =
    options?.inFirstOpenPeriodWhenLocked === true &&
    date === undefined &&
    !status.lookup_failed &&
    !DATE_FIXED_SOURCE_TYPES.includes(original.source_type ?? '')
  if (movable) {
    return { ...(await firstOpenPeriodTarget(supabase, companyId, original.entry_date)), moved: true }
  }

  if (status.status === 'closed') throw new TargetPeriodClosedError(target)
  throw new TargetPeriodLockedError(target, status.lock_date)
}

/**
 * The date of a rättelsepost for a verifikat dated `originalDate` whose own
 * date takes no write: in the first open, unlocked period after it
 * (firstBookableDate), on `today` when today lies there, else the nearest day
 * there to today: that period's last day when today is past it (an earlier
 * year still open, whose årsredovisning is the next one), its first bookable
 * day when today is before it.
 *
 * `fiscal_period_id` is the year covering that day, null when no fiscal year
 * covers the first open day (`date` is then that day, for the refusal).
 */
export function correctionDateInFirstOpenPeriod(
  originalDate: string,
  today: string,
  lockedThrough: string | null,
  fiscalPeriods: readonly (BookableFiscalPeriod & { id: string })[],
): { date: string; fiscal_period_id: string | null } {
  const first = firstBookableDate(originalDate, lockedThrough, fiscalPeriods).date
  const period = fiscalPeriods.find((fp) => fp.period_start <= first && fp.period_end >= first)
  if (!period) return { date: first, fiscal_period_id: null }
  // ISO dates sort as strings: the middle one is today held inside
  // [first, period_end].
  const [, date] = [first, today, period.period_end].sort()
  return { date, fiscal_period_id: period.id }
}

async function firstOpenPeriodTarget(
  supabase: SupabaseClient,
  companyId: string,
  originalDate: string,
): Promise<{ date: string; fiscal_period_id: string }> {
  const [settings, periods] = await Promise.all([
    supabase
      .from('company_settings')
      .select('bookkeeping_locked_through')
      .eq('company_id', companyId)
      .maybeSingle(),
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end, is_closed, locked_at')
      .eq('company_id', companyId)
      .gte('period_end', originalDate)
      .order('period_start', { ascending: true }),
  ])
  if (settings.error) {
    throw new BookkeepingDatabaseError('load_open_periods', settings.error.message, settings.error.code)
  }
  if (periods.error) {
    throw new BookkeepingDatabaseError('load_open_periods', periods.error.message, periods.error.code)
  }
  const lockedThrough =
    (settings.data as { bookkeeping_locked_through: string | null } | null)?.bookkeeping_locked_through ?? null
  const target = correctionDateInFirstOpenPeriod(
    originalDate,
    todayIsoStockholm(),
    lockedThrough,
    (periods.data ?? []) as unknown as Array<BookableFiscalPeriod & { id: string }>,
  )
  if (!target.fiscal_period_id) throw new NoOpenPeriodForDateError(target.date)
  return { date: target.date, fiscal_period_id: target.fiscal_period_id }
}

/** Refuses a storno of an original a posted storno already reverses. */
async function assertNoStandingStorno(
  supabase: SupabaseClient,
  companyId: string,
  originalId: string,
): Promise<void> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('reverses_id', originalId)
    .eq('status', 'posted')
    .limit(1)
  if (error) throw new BookkeepingDatabaseError('load_stornos_of_original', error.message, error.code)
  if ((data ?? []).length > 0) throw new EntryAlreadyReversedError()
}

/**
 * Whether `stornoId` is the storno that stands for the original: the first
 * posted one (by commit time). A moved storno leaves the original 'posted',
 * so the compare-and-set that keeps a second storno out in an open year
 * (status posted to reversed) has nothing to set, and two corrections that
 * pass assertStornoTarget at the same moment would both post one. Asked
 * right after a moved storno is posted: one that does not stand is cancelled
 * by its caller.
 */
export async function isStandingStorno(
  supabase: SupabaseClient,
  companyId: string,
  originalId: string,
  stornoId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('company_id', companyId)
    .eq('reverses_id', originalId)
    .eq('status', 'posted')
    .order('committed_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(1)
  if (error) throw new BookkeepingDatabaseError('load_stornos_of_original', error.message, error.code)
  return ((data ?? []) as Array<{ id: string }>)[0]?.id === stornoId
}

interface ReferencedOriginal {
  voucher_series?: string | null
  voucher_number?: number | null
  entry_date: string
  description: string
}

/**
 * The original a moved storno and its corrected verifikat name: its voucher
 * and its date ("A12 (2025-03-15)"). A rättelsepost identifies what it
 * corrects (BFL 5 kap 5 § and 7 §), and voucher numbers start again each
 * year, so the date goes with the number. The link itself is reverses_id /
 * correction_of_id; the text is what an SIE export or a printout carries.
 */
export function originalVoucherReference(original: ReferencedOriginal): string {
  return `${formatVoucher(original)} (${original.entry_date})`
}

/** The text of a moved storno: "Storno av verifikat A12 (2025-03-15): <original text>". */
export function movedStornoDescription(original: ReferencedOriginal): string {
  return `Storno av verifikat ${originalVoucherReference(original)}: ${original.description}`
}

/**
 * The text of a moved storno's corrected verifikat: the person's own text
 * with the reference after it, or "Rättelse av verifikat A12 (2025-03-15):
 * <original text>".
 */
export function movedCorrectionDescription(original: ReferencedOriginal, ownText?: string): string {
  const reference = originalVoucherReference(original)
  const text = ownText?.trim()
  return text
    ? `${text} (rättelse av verifikat ${reference})`
    : `Rättelse av verifikat ${reference}: ${original.description}`
}
