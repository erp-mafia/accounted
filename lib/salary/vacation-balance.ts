import { z } from 'zod'
import { roundOre } from '@/lib/money'
import { saneIsoDateSchema, fiscalYearSchema } from '@/lib/invariants/zod'

const date = saneIsoDateSchema
const days = z.number().finite().min(0).max(366)

/** A remaining balance, NOT the year's original allocation. Monetary and
 * vacation cutoffs are independent when payroll processes last month's leave. */
export const VacationBalanceSchema = z.object({
  as_of_date: date,
  year_start: date,
  annual_entitlement: days,
  tracking: z.boolean(),
  withdrawals_blocked: z.boolean().default(false),
  paid: days,
  extra_paid: days,
  unpaid: days,
  advance: days,
  saved_by_year: z.record(fiscalYearSchema, days),
  source_reference: z.string().min(1).max(2000),
  review_notes: z.array(z.string().max(2000)).max(20).default([]),
}).strict().superRefine((value, ctx) => {
  const start = Number(value.year_start.slice(0, 4))
  const end = `${start + 1}${value.year_start.slice(4)}`
  if (value.as_of_date < value.year_start || value.as_of_date >= end) {
    ctx.addIssue({ code: 'custom', message: 'Saldodatum måste ligga inom semesteråret', path: ['as_of_date'] })
  }
  if (Object.keys(value.saved_by_year).some(year => Number(year) >= start || Number(year) < start - 5)) {
    ctx.addIssue({ code: 'custom', message: 'Sparår måste ligga inom fem föregående år', path: ['saved_by_year'] })
  }
  if (!value.tracking && (value.paid + value.extra_paid + value.unpaid + value.advance + Object.values(value.saved_by_year).reduce((a, b) => a + b, 0) !== 0)) {
    ctx.addIssue({ code: 'custom', message: 'Semester utan daguppföljning får inte ha dagssaldon' })
  }
})
export type VacationBalance = z.infer<typeof VacationBalanceSchema>

export const VacationMovementSchema = z.object({
  date,
  category: z.enum(['paid', 'extra_paid', 'saved', 'unpaid', 'advance']),
  days: days.positive(),
  saved_year: fiscalYearSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.category === 'saved') !== (value.saved_year !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Sparår krävs endast för uttag av sparade dagar', path: ['saved_year'] })
  }
})
export type VacationMovement = z.infer<typeof VacationMovementSchema>

export function rollVacationBalance(opening: VacationBalance, movements: VacationMovement[], asOf: string): VacationBalance {
  const balance = VacationBalanceSchema.parse(structuredClone(opening))
  date.parse(asOf)
  if (asOf < balance.as_of_date) throw new Error('Semestersaldot kan inte räknas bakåt från ingångsdatum')
  for (const raw of movements) {
    const movement = VacationMovementSchema.parse(raw)
    // The opening ALREADY includes these withdrawals. Never deduct twice.
    if (movement.date <= opening.as_of_date || movement.date > asOf) continue
    if (balance.withdrawals_blocked) throw new Error('Semestersaldot kräver källavstämning före ytterligare uttag')
    if (!balance.tracking) throw new Error('Semesteruttag för person utan daguppföljning')
    if (movement.category === 'saved') {
      const year = movement.saved_year!
      balance.saved_by_year[year] = roundOre((balance.saved_by_year[year] ?? 0) - movement.days)
      if (balance.saved_by_year[year] < 0) throw new Error('Otillräckligt saldo i angivet sparår')
    } else {
      balance[movement.category] = roundOre(balance[movement.category] - movement.days)
      if (balance[movement.category] < 0) throw new Error('Otillräckligt semestersaldo i angiven kategori')
    }
  }
  balance.as_of_date = asOf
  // Cross-year changes require a year-close, not automatic renewal of rights.
  return VacationBalanceSchema.parse(balance)
}
