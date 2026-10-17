/**
 * The timing check: bank transactions still without a verifikat after the
 * latest date the books could have recorded them.
 *
 * "Unbooked" is the one definition behind every such figure
 * (lib/transactions/unbooked.ts: not ignored, not private, anchored to no
 * verifikat), the same rows Att göra lists under att bokföra. The cut-off is
 * BFNAR 2013:2 p. 3.6, the general senareläggning: an affärshändelse may be
 * booked up to 50 days after the end of the month it occurred in. A row
 * dated in a month whose 50th day after month end has passed is overdue.
 *
 * Not a finding of breach for every company: p. 3.7 lets a company with a
 * nettoomsättning normally at most 3 MSEK wait until 50 days after the
 * quarter, p. 3.8 and 3.9 longer still for the smallest, and kontanta in- och
 * utbetalningar are due the next working day (BFL 5 kap. 2 §). The check
 * uses the general rule because the system cannot tell which of those a
 * company qualifies for, and says so.
 */
import { addDaysIso, daysBetweenIso } from '@/lib/dates/iso'
import { toHandle } from '@/lib/handles'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { applyUnbookedFilter, countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import { cannotCheck, sourceFailed } from '../shared'
import type { CheckBreakdown, CheckContext, CheckDefinition, CheckItem, CheckRun, CheckSide, CheckSource } from '../types'

/** BFNAR 2013:2 p. 3.6: booked at the latest 50 days after the end of the month of the affärshändelse. */
export const BOOKING_DEADLINE_DAYS_AFTER_MONTH = 50

/** Explanation rows read before the list stops and says so. */
const MAX_ROWS = 2000

const UNBOOKED_SOURCE: CheckSource = {
  report: 'Banktransaktioner utan verifikat (Att göra, att bokföra)',
  v1_path: '/transactions?status=unbooked',
  mcp_tool: 'gnubok_list_uncategorized_transactions',
  screen: '/transactions',
}

interface UnbookedSource {
  cutoff: string
  total: number
}

function lastDayOfPreviousMonth(iso: string): string {
  return addDaysIso(`${iso.slice(0, 7)}-01`, -1)
}

/**
 * The last day of the latest month whose booking deadline (month end plus 50
 * days) has passed on `today`: every unbooked row dated on or before it is
 * overdue. The deadline day itself is still on time.
 */
export function overdueCutoff(today: string): string {
  let monthEnd = lastDayOfPreviousMonth(today)
  while (addDaysIso(monthEnd, BOOKING_DEADLINE_DAYS_AFTER_MONTH) >= today) monthEnd = lastDayOfPreviousMonth(monthEnd)
  return monthEnd
}

/** The booking deadline of a row dated `date`: 50 days after the end of its month. */
export function bookingDeadline(date: string): string {
  const nextMonthFirst = addDaysIso(`${date.slice(0, 7)}-28`, 4).slice(0, 7) + '-01'
  return addDaysIso(addDaysIso(nextMonthFirst, -1), BOOKING_DEADLINE_DAYS_AFTER_MONTH)
}

function sidesOf(total: number | null, cutoff: string): CheckSide[] {
  return [
    {
      key: 'overdue',
      label_sv: `Banktransaktioner utan verifikat daterade till och med ${cutoff}`,
      label_en: `Bank transactions without a verifikat dated through ${cutoff}`,
      amount: total,
      source: UNBOOKED_SOURCE,
    },
  ]
}

async function run(ctx: CheckContext): Promise<CheckRun<UnbookedSource>[]> {
  const subject = { kind: 'company' } as const
  const cutoff = overdueCutoff(ctx.today)
  try {
    const counts = await countUnbookedBankTransactions(ctx.supabase, ctx.companyId, { toDate: cutoff })
    const total = counts.total
    return [
      {
        subject,
        status: total === 0 ? 'ok' : 'unexplained',
        difference: total,
        as_of: ctx.today,
        summary_sv:
          total === 0
            ? `Inga banktransaktioner daterade till och med ${cutoff} saknar verifikat.`
            : `${total} banktransaktion${total === 1 ? '' : 'er'} daterade till och med ${cutoff} saknar fortfarande verifikat, fler än ${BOOKING_DEADLINE_DAYS_AFTER_MONTH} dagar efter utgången av sin månad.`,
        sides: sidesOf(total, cutoff),
        refusal: null,
        facts: { cutoff_date: cutoff, untriaged: counts.untriaged, business_unbooked: counts.business_unbooked },
        source: { cutoff, total },
      },
    ]
  } catch (err) {
    return [cannotCheck(subject, ctx.today, sourceFailed('unbooked_bank_lines_overdue', 'Obokförda banktransaktioner', err), sidesOf(null, cutoff))]
  }
}

async function explain(ctx: CheckContext, run: CheckRun<UnbookedSource>): Promise<CheckBreakdown> {
  const source = run.source
  if (!source || run.difference === null) return { parts: [], items: [], residual: null, reconciles: false }
  const rows = await fetchAllRows<{
    id: string
    date: string
    description: string | null
    amount: number | string
    currency: string | null
  }>(
    ({ from, to }) =>
      applyUnbookedFilter(
        ctx.supabase
          .from('transactions')
          .select('id, date, description, amount, currency')
          .eq('company_id', ctx.companyId)
          .lte('date', source.cutoff),
      )
        .order('date', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    { maxRows: MAX_ROWS },
  )
  const items: CheckItem[] = rows.map((row) => ({
    part: 'overdue_transactions',
    item_type: 'transaction',
    transaction_id: row.id,
    handle: toHandle('transaction', row.id),
    date: row.date,
    label: row.description || 'Banktransaktion',
    amount: 1,
    record_amount: Number(row.amount) || 0,
    ...(row.currency ? { currency: row.currency } : {}),
    days_past_deadline: Math.max(0, daysBetweenIso(bookingDeadline(row.date), ctx.today)),
  }))
  const residual = run.difference - items.length
  const notes: string[] = []
  if (rows.length >= MAX_ROWS) notes.push(`Only the first ${MAX_ROWS} rows were read.`)
  if (residual !== 0 && rows.length < MAX_ROWS) notes.push('The count and the list were read a moment apart; a row was booked or added in between.')
  notes.push(
    'The cut-off is the general rule (BFNAR 2013:2 p. 3.6, 50 days after the month). A company with a nettoomsättning normally at most 3 MSEK may book up to 50 days after the quarter (p. 3.7); kontanta in- och utbetalningar are due the next working day (BFL 5 kap. 2 §).',
  )
  return {
    parts: [
      {
        key: 'overdue_transactions',
        label_sv: `Banktransaktioner utan verifikat till och med ${source.cutoff}`,
        label_en: `Bank transactions without a verifikat through ${source.cutoff}`,
        amount: items.length,
        count: items.length,
      },
    ],
    items,
    residual,
    reconciles: residual === 0,
    note: notes.join(' '),
  }
}

export const unbookedBankLinesOverdue: CheckDefinition<UnbookedSource> = {
  id: 'unbooked_bank_lines_overdue',
  name_sv: 'Obokförda banktransaktioner efter sista bokföringsdag',
  name_en: 'Unbooked bank transactions past the booking deadline',
  definition: `The number of bank transactions with no verifikat (not ignored, not marked private, anchored to no verifikat: the Att göra "att bokföra" definition) dated on or before the last day of the latest month whose booking deadline has passed, the deadline being ${BOOKING_DEADLINE_DAYS_AFTER_MONTH} days after the end of the month (BFNAR 2013:2 p. 3.6). Should be zero. A count, not an amount: the rows may be in several currencies.`,
  definition_sv: `Antal banktransaktioner utan verifikat (inte ignorerade, inte privata, inte kopplade till något verifikat) daterade senast sista dagen i den senaste månad vars sista bokföringsdag har passerat, ${BOOKING_DEADLINE_DAYS_AFTER_MONTH} dagar efter månadens utgång (BFNAR 2013:2 p. 3.6). Ska vara noll. Ett antal, inte ett belopp.`,
  basis:
    'BFL 5 kap. 2 §: affärshändelser are booked as soon as possible, kontanta in- och utbetalningar by the next working day. BFNAR 2013:2 p. 3.6 allows senareläggning up to 50 days after the end of the month; p. 3.7 to 50 days after the quarter for a nettoomsättning normally at most 3 MSEK, p. 3.8 and 3.9 longer for the smallest (swedish-accounting-compliance). The check uses p. 3.6, the general rule.',
  unit: 'count',
  tolerance: 0,
  subject_kind: 'company',
  compares: [UNBOOKED_SOURCE],
  next_action: {
    message_sv: 'Bokför de äldsta banktransaktionerna först: hämta förslag och kategorisera dem, eller markera dem som privata eller ignorerade.',
    tool: 'gnubok_list_uncategorized_transactions',
    screen: '/transactions',
  },
  run,
  explain,
}
