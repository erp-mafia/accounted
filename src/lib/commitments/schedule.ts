import { roundOre } from '@/lib/money'
import { addDays, addMonths, monthlySeries } from '@/lib/arkiv/agreements/dates'
import { HORIZON, type DeadlineDraft, type ObligationDraft } from '@/lib/arkiv/agreements/derive'
import { INCOMING_AGREEMENT_KINDS, type AgreementPeriod, type AgreementStatus, type ManualAgreementKind } from './types'

/**
 * What a manual agreement implies: its expected payments inside the same
 * horizon the Arkiv pipeline uses (two months back, a year ahead), so the
 * daily observation compares them with the bank the same way, and the
 * dates that go to Viktiga datum (notice, end or maturity). Computed from
 * what a person entered: amount, period, first due date (or the start) and
 * end. Pure: nothing here touches the database.
 */
export interface ManualAgreementTerms {
  kind: ManualAgreementKind
  title: string
  status: AgreementStatus
  starts_on: string | null
  ends_on: string | null
  first_due_on: string | null
  notice_months: number | null
  renewal_terms: string | null
  amount: number | null
  currency: string
  period: AgreementPeriod | null
}

export interface ManualSchedule {
  obligations: ObligationDraft[]
  deadlines: DeadlineDraft[]
}

const PERIOD_MONTHS: Record<Exclude<AgreementPeriod, 'one_time'>, number> = { monthly: 1, quarterly: 3, yearly: 12 }

export function manualAgreementSchedule(terms: ManualAgreementTerms, today: string): ManualSchedule {
  const window = { from: addDays(today, -HORIZON.pastDays), to: addMonths(today, HORIZON.futureMonths) }
  const obligations: ObligationDraft[] = []
  const anchor = terms.first_due_on ?? terms.starts_on
  const amount = terms.amount == null ? null : roundOre(terms.amount)
  if (amount != null && amount > 0 && terms.period && anchor) {
    const fields = ['amount', 'period', terms.first_due_on ? 'first_due_on' : 'starts_on']
    const direction = INCOMING_AGREEMENT_KINDS.includes(terms.kind) ? 'in' : 'out'
    const dates =
      terms.period === 'one_time'
        ? anchor >= window.from && anchor <= window.to && (!terms.ends_on || anchor <= terms.ends_on)
          ? [anchor]
          : []
        : monthlySeries(anchor, PERIOD_MONTHS[terms.period], { ...window, end: terms.ends_on })
    for (const dueOn of dates) {
      obligations.push({ kind: 'payment', dueOn, amount, currency: terms.currency, estimate: false, fields, direction })
    }
  }

  // An ended agreement has nothing left to remember.
  const deadlines: DeadlineDraft[] = []
  if (terms.status === 'active' && terms.ends_on) {
    const title = terms.title.trim()
    if (terms.notice_months != null && terms.kind !== 'loan') {
      deadlines.push({
        key: 'notice',
        title: `Sista dag att säga upp: ${title}`,
        dueOn: addMonths(terms.ends_on, -terms.notice_months),
        priority: 'important',
        fields: ['ends_on', 'notice_months'],
      })
    }
    if (terms.kind === 'loan') {
      deadlines.push({ key: 'maturity', title: `${title} förfaller till slutbetalning`, dueOn: terms.ends_on, priority: 'important', fields: ['ends_on'] })
    } else {
      deadlines.push({
        key: 'end',
        title: `${title} löper ut${terms.renewal_terms ? ', förlängs annars' : ''}`,
        dueOn: terms.ends_on,
        priority: 'normal',
        fields: ['ends_on'],
      })
    }
  }
  return { obligations, deadlines: deadlines.filter((d) => d.dueOn >= today) }
}

/** The note a manual agreement's date carries in Viktiga datum. */
export function manualDeadlineNote(title: string, draft: DeadlineDraft): string {
  return `Från avtalet ${title.trim()} i Avtal och åtaganden. Datumet räknas fram från ${draft.fields.join(', ')}.`
}
