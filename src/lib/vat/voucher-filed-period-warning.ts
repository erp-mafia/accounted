/**
 * The booking-time warning for a typed verifikat that a momsdeklaration
 * already filed would read.
 *
 * Filing freezes nothing: while the period is open the verifikat posts, and
 * the declaration Skatteverket holds then differs from the books until a
 * corrected one is filed. An audit of prod (2026-10-26) found about one filed
 * declaration in eleven no longer matching the books, and nothing had said so
 * at the booking; the Moms page says it afterwards
 * (./filed-period-changes.ts). This says it before, through the
 * confirm-before-posting guard every typed door already runs
 * (lib/bookkeeping/voucher-warnings-guard.ts), so the person confirms it or
 * picks another date, and a booking past it leaves a record on the verifikat.
 *
 * Only a booking that moves a ruta of a filed period is warned about: a bank
 * fee or a salary payment dated in a filed period changes nothing in the
 * declaration, and a warning on every such booking would teach people to
 * click past the one that matters. Whether the declaration reads a verifikat
 * and which rutor it moves is ./voucher-vat-impact.ts's decision, the one the
 * staged voucher preview shows. A base ruta counts like a moms ruta: a sale
 * booked without its moms line still changes ruta 05.
 *
 * The text says the declaration may need correcting, never that it does: a
 * period filed in another system and marked here afterwards already holds
 * the events whose history is typed in later, and only the person knows.
 *
 * A rättelse is judged as the pair it posts: the storno takes the original's
 * lines out on the original's date, and the new lines go in on the rättelse's
 * date. A rättelse that leaves the moms as it was (another cost account, a
 * new text) nets to nothing and is not warned about.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { VatDeclarationRutor } from '@/types'
import type { VoucherBlockWarningInput } from '@/lib/bookkeeping/voucher-block-warnings'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { isSaneDateString } from '@/lib/invariants/iso-date'
import { roundOre } from '@/lib/money'
import { distinctFiledVatPeriods, filedVatPeriodsOfDates, type FiledVatPeriod } from './filed-period-for-date'
import { previewVoucherVatDeclaration, type VoucherImpactLine } from './voucher-vat-impact'

type RutaKey = keyof VatDeclarationRutor
type RutorChange = Partial<Record<RutaKey, number>>

interface FiledPeriodChange extends FiledVatPeriod {
  /** Ruta -> signed change as filed, only the rutor that move. */
  rutor_change: RutorChange
}

/** "2026-Q2 (inlämnad 2026-08-17) och 2026-Q3 (inlämnad 2026-11-11)": every text that names filed periods. */
export function describeFiledPeriods(
  periods: readonly FiledVatPeriod[],
  locale: 'sv' | 'en',
): string {
  const filedWord = locale === 'sv' ? 'inlämnad' : 'filed'
  const and = locale === 'sv' ? 'och' : 'and'
  const named = periods.map((p) => `${p.tax_period} (${filedWord} ${p.filed_on})`)
  return named.length > 1 ? `${named.slice(0, -1).join(', ')} ${and} ${named[named.length - 1]}` : named[0]
}

/**
 * The warning, or null when no date lies in a filed period, the company files
 * no momsdeklaration, the declaration would not read the verifikat, or no
 * ruta of a filed period moves. Throws when a read fails; the guard decides
 * what a failed check means for the booking.
 */
export async function filedPeriodVoucherWarning(
  supabase: SupabaseClient,
  companyId: string,
  input: VoucherBlockWarningInput,
): Promise<VoucherWarning | null> {
  // What the booking posts: its own lines in, and for a rättelse the
  // original's lines out. A date not known yet (a rättelse sent without its
  // own date and without its original) asks nothing.
  const postings: Array<{ date: string; lines: readonly VoucherImpactLine[]; sign: 1 | -1 }> = []
  if (isSaneDateString(input.entry_date)) postings.push({ date: input.entry_date, lines: input.lines, sign: 1 })
  if (input.replaces && isSaneDateString(input.replaces.entry_date)) {
    postings.push({ date: input.replaces.entry_date, lines: input.replaces.lines, sign: -1 })
  }
  if (postings.length === 0) return null

  // The cheap question first: most bookings are dated in no filed period.
  const filedByDate = await filedVatPeriodsOfDates(supabase, companyId, postings.map((p) => p.date))
  if (filedByDate.size === 0) return null

  const net = new Map<string, RutorChange>()
  for (const posting of postings) {
    const filed = filedByDate.get(posting.date)
    if (!filed) continue
    const impact = await previewVoucherVatDeclaration(supabase, companyId, {
      entryDate: posting.date,
      fiscalPeriodId: null,
      lines: posting.lines,
      // The declaration leaves an opening balance on the period's first day
      // out and decides one inside the period only at posting: neither is a
      // change this can name, so both end as "not counted" below.
      isOpeningBalance: input.opening_balance === true,
    })
    if (impact.status === 'unavailable') throw new Error('voucher VAT impact unavailable')
    if (impact.status !== 'ok' || impact.counted !== true) continue
    const change = net.get(filed.tax_period) ?? {}
    for (const [box, amount] of Object.entries(impact.rutor_change) as Array<[RutaKey, number]>) {
      change[box] = roundOre((change[box] ?? 0) + posting.sign * amount)
    }
    net.set(filed.tax_period, change)
  }

  const changed: FiledPeriodChange[] = []
  for (const period of distinctFiledVatPeriods(filedByDate)) {
    const moved: RutorChange = {}
    for (const [box, amount] of Object.entries(net.get(period.tax_period) ?? {}) as Array<[RutaKey, number]>) {
      if (amount !== 0) moved[box] = amount
    }
    if (Object.keys(moved).length > 0) changed.push({ ...period, rutor_change: moved })
  }
  if (changed.length === 0) return null

  const rattelse = !!input.replaces
  const several = changed.length > 1
  const namedSv = describeFiledPeriods(changed, 'sv')
  const namedEn = describeFiledPeriods(changed, 'en')
  // The books change, not the return Skatteverket holds: what moves is the
  // underlag for it.
  const filedSv = several
    ? 'underlaget för momsdeklarationer som redan är inlämnade'
    : 'underlaget för en momsdeklaration som redan är inlämnad'
  const filedEn = several ? 'the figures behind VAT returns already filed' : 'the figures behind a VAT return already filed'
  const maySv = several ? 'kan deklarationerna behöva rättas' : 'kan deklarationen behöva rättas'
  const mayEn = several ? 'the returns may need correcting' : 'the return may need correcting'
  return {
    code: 'VAT_PERIOD_ALREADY_FILED',
    message_sv: rattelse
      ? `Rättelsen ändrar ${filedSv}: ${namedSv}. Görs rättelsen ${maySv}.`
      : `Verifikationen ändrar ${filedSv}: ${namedSv}. Bokförs den här ${maySv}. ` +
        'Hör affärshändelsen till en senare period, välj ett datum där i stället.',
    message_en: rattelse
      ? `The correction changes ${filedEn}: ${namedEn}. If it is made, ${mayEn}.`
      : `The voucher changes ${filedEn}: ${namedEn}. If it is booked here, ${mayEn}. ` +
        'If the business event belongs to a later period, pick a date there instead.',
    details: {
      entry_date: input.entry_date,
      filed_periods: changed,
    },
  }
}
