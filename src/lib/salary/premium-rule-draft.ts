/**
 * The premium-rule editor's model, without React: the draft the dialog
 * edits, its checks, the request body it sends, and the live example line.
 *
 * The example runs the real engine (computePremiumLines) on one made-up
 * shift, so the editor can never show a figure the payslip would not pay.
 * Nothing here repeats the engine's arithmetic.
 */
import type { ShiftPremiumAmountForm, ShiftPremiumItemType, ShiftPremiumRule } from '@/types'
import { isSwedishHolidayISO } from '@/lib/tax/swedish-holidays'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'
import { computePremiumLines, isoWeekdayFromDate, nextIsoDate, premiumPayBasis } from './shift-premium-engine'

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const

/** How two rules on the same minute are settled, in the editor's words. */
export type PremiumOverlapChoice = 'first' | 'highest' | 'last'

export interface PremiumRuleDraft {
  name: string
  item_type: ShiftPremiumItemType
  /** ISO weekdays. Ignored (all days) while item_type is ob_holiday. */
  day_of_week: number[]
  start_time: string
  end_time: string
  amount_form: ShiftPremiumAmountForm
  /** What was typed per form, so switching forms back and forth keeps it. */
  amounts: Record<ShiftPremiumAmountForm, string>
  /** percent_of_hourly only; '' = the employee's schedule. */
  hourly_divisor: string
  valid_from: string
  /** '' = open-ended. */
  valid_to: string
  applies_to_all_employees: boolean
  applies_to_employee_ids: string[]
  overlap: PremiumOverlapChoice
  /** The stored priority, kept when the overlap choice is left as it was. */
  priority: number
}

export type PremiumRuleDraftField =
  | 'name'
  | 'day_of_week'
  | 'start_time'
  | 'end_time'
  | 'amount'
  | 'hourly_divisor'
  | 'valid_from'
  | 'valid_to'
  | 'applies_to_employee_ids'

/** i18n key suffixes under premium_rules.error_*. */
export type PremiumRuleDraftError =
  | 'name'
  | 'days'
  | 'time'
  | 'percent'
  | 'divisor'
  | 'sek'
  | 'hourly_divisor'
  | 'valid_from'
  | 'valid_to'
  | 'employees'

const PRIORITY_FIRST = 10
const PRIORITY_LAST = -10

export function overlapFromPriority(priority: number): PremiumOverlapChoice {
  if (priority > 0) return 'first'
  if (priority < 0) return 'last'
  return 'highest'
}

function priorityFor(draft: PremiumRuleDraft): number {
  if (overlapFromPriority(draft.priority) === draft.overlap) return draft.priority
  if (draft.overlap === 'first') return PRIORITY_FIRST
  if (draft.overlap === 'last') return PRIORITY_LAST
  return 0
}

export function emptyPremiumRuleDraft(today: string): PremiumRuleDraft {
  return {
    name: '',
    item_type: 'ob_weekday_evening',
    day_of_week: [1, 2, 3, 4, 5],
    start_time: '18:00',
    end_time: '22:00',
    amount_form: 'percent_of_hourly',
    amounts: { percent_of_hourly: '', monthly_divisor: '', sek_per_hour: '' },
    hourly_divisor: '',
    valid_from: today,
    valid_to: '',
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    overlap: 'highest',
    priority: 0,
  }
}

/** Swedish decimal comma in, the number as typed out. */
function decimalText(value: number | null): string {
  return value == null ? '' : String(value).replace('.', ',')
}

export function draftFromRule(rule: ShiftPremiumRule): PremiumRuleDraft {
  return {
    name: rule.name,
    item_type: rule.item_type,
    day_of_week: [...rule.day_of_week],
    start_time: rule.start_time.slice(0, 5),
    end_time: rule.end_time.slice(0, 5),
    amount_form: rule.amount_form,
    amounts: {
      percent_of_hourly: decimalText(rule.premium_percent),
      monthly_divisor: decimalText(rule.monthly_divisor),
      sek_per_hour: decimalText(rule.sek_per_hour),
    },
    hourly_divisor: decimalText(rule.hourly_divisor),
    valid_from: rule.valid_from ?? '',
    valid_to: rule.valid_to ?? '',
    applies_to_all_employees: rule.applies_to_all_employees,
    applies_to_employee_ids: [...rule.applies_to_employee_ids],
    overlap: overlapFromPriority(rule.priority),
    priority: rule.priority,
  }
}

/** '27,59' or '27.59' to 27.59; anything else to null. Two decimals at most. */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null
  return Number(trimmed)
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/

const AMOUNT_BOUNDS: Record<ShiftPremiumAmountForm, { min: number; max: number; error: PremiumRuleDraftError }> = {
  percent_of_hourly: { min: 0, max: 500, error: 'percent' },
  monthly_divisor: { min: 1, max: 10000, error: 'divisor' },
  sek_per_hour: { min: 0, max: 10000, error: 'sek' },
}

/**
 * The editor's own checks, field by field, mirroring the API schema
 * (CreateShiftPremiumRuleSchema) so a mistake shows under its field before
 * anything is sent. The API stays the authority.
 */
export function validatePremiumRuleDraft(
  draft: PremiumRuleDraft,
): Partial<Record<PremiumRuleDraftField, PremiumRuleDraftError>> {
  const errors: Partial<Record<PremiumRuleDraftField, PremiumRuleDraftError>> = {}
  if (!draft.name.trim()) errors.name = 'name'
  if (draft.item_type !== 'ob_holiday' && draft.day_of_week.length === 0) errors.day_of_week = 'days'
  if (!CLOCK.test(draft.start_time)) errors.start_time = 'time'
  if (!CLOCK.test(draft.end_time)) errors.end_time = 'time'

  const bounds = AMOUNT_BOUNDS[draft.amount_form]
  const amount = parseDecimal(draft.amounts[draft.amount_form])
  if (amount === null || amount < bounds.min || amount > bounds.max) errors.amount = bounds.error

  if (draft.amount_form === 'percent_of_hourly' && draft.hourly_divisor.trim() !== '') {
    const divisor = parseDecimal(draft.hourly_divisor)
    if (divisor === null || divisor < 1 || divisor > 1000) errors.hourly_divisor = 'hourly_divisor'
  }

  if (!ISO_DATE_RE.test(draft.valid_from)) errors.valid_from = 'valid_from'
  if (draft.valid_to !== '' && (!ISO_DATE_RE.test(draft.valid_to) || draft.valid_to < draft.valid_from)) {
    errors.valid_to = 'valid_to'
  }
  if (!draft.applies_to_all_employees && draft.applies_to_employee_ids.length === 0) {
    errors.applies_to_employee_ids = 'employees'
  }
  return errors
}

const AMOUNT_FIELD: Record<ShiftPremiumAmountForm, 'premium_percent' | 'monthly_divisor' | 'sek_per_hour'> = {
  percent_of_hourly: 'premium_percent',
  monthly_divisor: 'monthly_divisor',
  sek_per_hour: 'sek_per_hour',
}

/**
 * The body for POST (create) and PATCH (update) alike: the chosen form and
 * only its field. On an update the service clears the other forms' fields
 * when the form changes. Call only on a draft without errors.
 */
export function premiumRuleRequestBody(draft: PremiumRuleDraft): Record<string, unknown> {
  const holiday = draft.item_type === 'ob_holiday'
  const percent = draft.amount_form === 'percent_of_hourly'
  return {
    name: draft.name.trim(),
    item_type: draft.item_type,
    day_of_week: holiday ? [...ALL_WEEKDAYS] : [...draft.day_of_week].sort((a, b) => a - b),
    start_time: draft.start_time,
    end_time: draft.end_time,
    amount_form: draft.amount_form,
    [AMOUNT_FIELD[draft.amount_form]]: parseDecimal(draft.amounts[draft.amount_form]),
    ...(percent ? { hourly_divisor: draft.hourly_divisor.trim() === '' ? null : parseDecimal(draft.hourly_divisor) } : {}),
    valid_from: draft.valid_from,
    valid_to: draft.valid_to === '' ? null : draft.valid_to,
    priority: priorityFor(draft),
    applies_to_all_employees: draft.applies_to_all_employees,
    applies_to_employee_ids: draft.applies_to_all_employees ? [] : draft.applies_to_employee_ids,
  }
}

/** The månadslön the example is priced on, a full-time 40-hour week. */
export const EXAMPLE_MONTHLY_SALARY = 40000

export interface PremiumRuleExample {
  /** Worked hours the rule paid in the example. */
  hours: number
  start: string
  end: string
  amount: number
  /** The månadslön the example used, or null when the form does not need one. */
  monthlySalary: number | null
}

function minutesOf(clock: string): number {
  const [h, m] = clock.split(':').map(Number)
  return h * 60 + m
}

function clockOf(minutes: number): string {
  const wrapped = ((minutes % 1440) + 1440) % 1440
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`
}

/**
 * One example shift for the editor: up to three hours from the start of the
 * rule's window, on the first date from `from` the rule applies to, priced by
 * the engine for a monthly-paid employee on EXAMPLE_MONTHLY_SALARY. Null when
 * the draft is not complete enough to price.
 */
export function premiumRuleExample(draft: PremiumRuleDraft, from: string): PremiumRuleExample | null {
  if (Object.keys(validatePremiumRuleDraft(draft)).length > 0) return null
  const body = premiumRuleRequestBody(draft)
  const rule: ShiftPremiumRule = {
    id: 'example',
    company_id: 'example',
    name: draft.name,
    applies_to_all_employees: true,
    applies_to_employee_ids: [],
    day_of_week: body.day_of_week as number[],
    start_time: draft.start_time,
    end_time: draft.end_time,
    amount_form: draft.amount_form,
    premium_percent: (body.premium_percent as number | undefined) ?? null,
    monthly_divisor: (body.monthly_divisor as number | undefined) ?? null,
    sek_per_hour: (body.sek_per_hour as number | undefined) ?? null,
    hourly_divisor: (body.hourly_divisor as number | null | undefined) ?? null,
    valid_from: draft.valid_from,
    valid_to: draft.valid_to || null,
    item_type: draft.item_type,
    priority: 0,
    is_active: true,
    created_at: '',
    updated_at: '',
    created_by: null,
  }

  const startMin = minutesOf(draft.start_time)
  const windowMin = (minutesOf(draft.end_time) - startMin + 1440) % 1440 || 1440
  const lengthMin = Math.min(180, windowMin)

  // The first date the rule's window opens on, inside its validity.
  let date = draft.valid_from > from ? draft.valid_from : from
  let found: string | null = null
  for (let i = 0; i < 800; i++) {
    if (rule.valid_to && date > rule.valid_to) break
    const weekdayOk = rule.day_of_week.includes(isoWeekdayFromDate(date))
    const holidayOk = rule.item_type !== 'ob_holiday' || isSwedishHolidayISO(date)
    if (weekdayOk && holidayOk) {
      found = date
      break
    }
    date = nextIsoDate(date)
  }
  if (!found) return null

  const pay = premiumPayBasis({
    salary_type: 'monthly',
    hourly_rate: null,
    monthly_salary: EXAMPLE_MONTHLY_SALARY,
    employment_degree: 100,
    hours_per_week: 40,
  })
  const lines = computePremiumLines({
    employeeId: 'example',
    baseHourlyRate: pay.hourlyRate,
    monthlySalary: pay.monthlySalary,
    workedDays: [
      {
        work_date: found,
        hours: lengthMin / 60,
        start_time: draft.start_time,
        end_time: clockOf(startMin + lengthMin),
      },
    ],
    rules: [rule],
  })
  if (lines.length === 0) return null
  return {
    hours: roundOre(lines.reduce((sum, line) => sum + line.hours, 0)),
    start: draft.start_time,
    end: clockOf(startMin + lengthMin),
    amount: roundOre(lines.reduce((sum, line) => sum + line.amount, 0)),
    monthlySalary: draft.amount_form === 'sek_per_hour' ? null : EXAMPLE_MONTHLY_SALARY,
  }
}
