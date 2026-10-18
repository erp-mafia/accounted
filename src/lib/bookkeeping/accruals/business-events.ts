import { postingEvidence } from '@/lib/core/bookkeeping/year-end-business-events'
import type { LinkBasisColumns } from '@/lib/links/link-basis'
import { mappingVersion } from '@/lib/posting/mapping-version'
import type { BusinessEventDraft } from '@/lib/posting/types'
import type { AccrualSchedule } from '@/types'

/**
 * The business events of the periodiseringar, for the posting port (step
 * 2g): an accrual schedule's dissolution (ledger.accrual), the stornos the
 * schedule service makes of them (ledger.storno), and a periodisering the
 * year-end wizard books at balansdagen (ledger.accrual, or
 * payroll.vacation_liability_adjusted for the semesterlöneskuld). Pure:
 * built only while POSTING_EVENTS is shadow or strict, never while it is
 * off.
 *
 * A schedule spreads one line of an invoice over the months of its service
 * period, and a schedule has no typed handle of its own, so a dissolution's
 * subject is that invoice (a supplier invoice, or a customer invoice for a
 * förutbetald intäkt); the verifikat's source_id names the schedule. A
 * year-end periodisering's subject is the fiscal period it closes. No party
 * and no category: the invoice carries the counterparty, and an account is
 * never read as a category. Amounts are SEK magnitudes.
 */

type ScheduleSource = Pick<AccrualSchedule, 'supplier_invoice_id' | 'invoice_id'>

function subjectOf(schedule: ScheduleSource): BusinessEventDraft['subject'] {
  if (schedule.supplier_invoice_id) return { type: 'supplier_invoice', id: schedule.supplier_invoice_id }
  if (schedule.invoice_id) return { type: 'invoice', id: schedule.invoice_id }
  return null
}

/**
 * A dissolution of an accrual schedule (kind ledger.accrual): one month's
 * share, dated the month it belongs to even when the verifikat moved to a
 * later date (a posting floor, a lock date or a closed year), or the rest of
 * the schedule dissolved at once, dated the day it was dissolved.
 */
export function accrualDissolutionBusinessEvent(args: {
  schedule: ScheduleSource
  occurredOn: string
  amount: number
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  const amount = Math.abs(args.amount)
  return {
    kind: 'ledger.accrual',
    category: null,
    occurredOn: args.occurredOn,
    subject: subjectOf(args.schedule),
    currency: 'SEK',
    amount,
    amountSek: amount,
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('accrualSchedule'),
    jurisdiction: 'SE',
  }
}

/**
 * A storno of a dissolution (kind ledger.storno, linked with role reversal),
 * dated the day it is made: the invoice credited (user_created), or a month
 * a concurrent run had already posted (system_derived). No amount and no
 * rule version: a storno mirrors its original's lines.
 */
export function accrualStornoBusinessEvent(args: {
  schedule: ScheduleSource
  occurredOn: string
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  return {
    kind: 'ledger.storno',
    category: null,
    occurredOn: args.occurredOn,
    subject: subjectOf(args.schedule),
    ...postingEvidence(args.linkBasis),
    jurisdiction: 'SE',
  }
}

/**
 * A periodisering the year-end wizard books at balansdagen (source type
 * manual): ledger.accrual, except the semesterlöneskuld's adjustment, which
 * is payroll.vacation_liability_adjusted under expense.personnel as the
 * semesterårsavslut records it. Subject the fiscal period closed, dated its
 * last day; the amount is the proposal's.
 */
export function yearEndAccrualBusinessEvent(args: {
  accrual: string
  fiscalPeriodId: string
  periodEnd: string
  amount: number
  linkBasis: LinkBasisColumns
}): BusinessEventDraft {
  const vacation = args.accrual === 'vacation_liability_change'
  const amount = Math.abs(args.amount)
  return {
    kind: vacation ? 'payroll.vacation_liability_adjusted' : 'ledger.accrual',
    category: vacation ? 'expense.personnel' : null,
    occurredOn: args.periodEnd,
    subject: { type: 'fiscal_period', id: args.fiscalPeriodId },
    currency: 'SEK',
    amount,
    amountSek: amount,
    ...postingEvidence(args.linkBasis),
    mappingVersion: mappingVersion('yearEndAccruals'),
    jurisdiction: 'SE',
  }
}
