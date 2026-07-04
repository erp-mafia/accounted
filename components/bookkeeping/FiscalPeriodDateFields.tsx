'use client'

import { useMemo, type ReactNode } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CalendarDays } from 'lucide-react'
import {
  monthsBetween,
  parseDateParts,
  validatePeriodDuration,
} from '@/lib/bookkeeping/validate-period-duration'
import type { EntityType } from '@/types'

const monthNames = [
  'januari', 'februari', 'mars', 'april', 'maj', 'juni',
  'juli', 'augusti', 'september', 'oktober', 'november', 'december',
]

function formatSwedishDate(dateStr: string): string {
  const { year, month, day } = parseDateParts(dateStr)
  return `${day} ${monthNames[month - 1]} ${year}`
}

function endsOnDec31(end: string): boolean {
  const e = parseDateParts(end)
  return e.month === 12 && e.day === 31
}

/**
 * Map validatePeriodDuration's English messages to user-facing Swedish copy.
 */
function toSwedishError(msg: string): string {
  if (msg.includes('after period start')) return 'Slutdatum måste vara efter startdatum.'
  if (msg.includes('1st of a month')) return 'Startdatum måste vara den första i månaden.'
  if (msg.includes('last day of a month')) return 'Slutdatum måste vara den sista i månaden.'
  if (msg.includes('exceeds maximum 18 months')) return 'Räkenskapsåret får vara högst 18 månader (BFL 3 kap.).'
  if (msg.includes('at least 6 months')) return 'Första räkenskapsåret måste vara minst 6 månader (BFL 3 kap.).'
  return msg
}

export interface FiscalPeriodValidation {
  /** User-facing Swedish error, or null if valid */
  error: string | null
  /** Integer month count, or null if inputs are incomplete/invalid */
  months: number | null
  /** True if inputs are complete enough to render the summary */
  canSummarise: boolean
}

/**
 * Shared validation for the first fiscal period: used by both onboarding Step 3
 * and the settings FiscalPeriodEditor. Returns Swedish error copy.
 */
export function validateFirstPeriod(
  startDate: string,
  endDate: string,
  entityType: EntityType | undefined
): FiscalPeriodValidation {
  if (!startDate || !endDate) {
    return { error: null, months: null, canSummarise: false }
  }
  if (endDate <= startDate) {
    return {
      error: 'Slutdatum måste vara efter startdatum.',
      months: null,
      canSummarise: false,
    }
  }

  const baseError = validatePeriodDuration(startDate, endDate, { isFirstPeriod: true })
  if (baseError) {
    return {
      error: toSwedishError(baseError),
      months: monthsBetween(startDate, endDate),
      canSummarise: true,
    }
  }

  if (entityType === 'enskild_firma' && !endsOnDec31(endDate)) {
    return {
      error: 'Enskild firma måste ha slutdatum 31 december (BFL 3 kap.).',
      months: monthsBetween(startDate, endDate),
      canSummarise: true,
    }
  }

  return {
    error: null,
    months: monthsBetween(startDate, endDate),
    canSummarise: true,
  }
}

interface FiscalPeriodDateFieldsProps {
  startDate: string
  onStartDateChange: (value: string) => void
  startHelpText?: string
  /**
   * Render the end-date control. Onboarding passes its AB end-month <Select>
   * + computed-option <Select>; settings passes a native <input type="date">.
   */
  endDateSlot: ReactNode
  /** The raw end-date string (used for summary + validation). */
  endDate: string
  entityType: EntityType | undefined
  /** Label for the summary card. Defaults to "Ditt första räkenskapsår". */
  summaryTitle?: string
  /** Optional override for start date <Label> content. */
  startLabel?: ReactNode
}

/**
 * Shared first-fiscal-period date entry: day-level start (native date input),
 * caller-provided end-date control, and a Swedish summary card with inline
 * validation errors (6-18 months, EF calendar-year rule, last-day-of-month).
 *
 * Used by onboarding Step 3 and the settings FiscalPeriodEditor so the two
 * screens stay in lockstep.
 */
export function FiscalPeriodDateFields({
  startDate,
  onStartDateChange,
  startHelpText = 'Första räkenskapsåret kan börja valfri dag.',
  endDateSlot,
  endDate,
  entityType,
  summaryTitle = 'Ditt första räkenskapsår',
  startLabel = 'Startdatum',
}: FiscalPeriodDateFieldsProps) {
  const validation = useMemo(
    () => validateFirstPeriod(startDate, endDate, entityType),
    [startDate, endDate, entityType],
  )

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="fiscal-period-start">{startLabel}</Label>
        <Input
          id="fiscal-period-start"
          type="date"
          value={startDate}
          onChange={(e) => onStartDateChange(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{startHelpText}</p>
      </div>

      {endDateSlot}

      {validation.canSummarise && (
        <div className="rounded-lg border border-primary/20 bg-primary/5 p-4 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CalendarDays className="h-4 w-4 text-primary" />
            {summaryTitle}
          </div>
          {startDate && endDate && (
            <p className="text-sm text-muted-foreground">
              {formatSwedishDate(startDate)}: {formatSwedishDate(endDate)}
            </p>
          )}
          {validation.months !== null && (
            <p
              className={`text-xs ${validation.error ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {validation.months} månader
              {validation.error ? `: ${validation.error}` : ''}
            </p>
          )}
          {validation.error && validation.months === null && (
            <p className="text-xs text-destructive">{validation.error}</p>
          )}
        </div>
      )}

      {validation.error && !validation.canSummarise && (
        <p className="text-xs text-destructive">{validation.error}</p>
      )}
    </div>
  )
}
