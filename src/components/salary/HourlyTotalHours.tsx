'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { parseDecimalInput } from '@/lib/money'

/** Same bound as the route's schema: 31 days of 24 hours. */
const HOURS_MAX = 744

export interface HourlyTotalHoursProps {
  runId: string
  employeeId: string
  /** The run row's hours (salary_run_employees.hours_worked): the total set
   *  here, or the hours the last calculation priced. */
  hoursWorked: number | null
  /** Worked hours in the calendar for the run's avvikelseperiod; null until
   *  the calendar has loaded. Calendar days win at calculation, so with any
   *  the field shows their sum and cannot be edited. */
  calendarHours: number | null
  /** The run is a draft: the only status the total can be set in. */
  editable: boolean
  onSaved: () => void
}

/**
 * The period's worked hours for an hourly employee as one figure
 * (accounted#1), for a company that keeps hours in its own sheet and has
 * only the monthly total. Writes salary_run_employees.hours_worked through
 * the same service as the MCP tool; the calculation prices it exactly like
 * the same hours entered per day. While a total is set the calendar takes
 * no worked hours (SalaryCalendar workedHoursFromTotal), so the two never
 * compete for the same period.
 */
export function HourlyTotalHours({
  runId,
  employeeId,
  hoursWorked,
  calendarHours,
  editable,
  onSaved,
}: HourlyTotalHoursProps) {
  const t = useTranslations('salary_run_employee')
  const stored = Number(hoursWorked) || 0
  const [value, setValue] = useState(() => (stored > 0 ? String(stored) : ''))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A reload (after a save, a calculation or a calendar edit) brings the
  // stored figure back in.
  useEffect(() => {
    setValue(stored > 0 ? String(stored) : '')
  }, [stored])

  const fromCalendar = calendarHours !== null && calendarHours > 0
  const parsed = value.trim() === '' ? 0 : (parseDecimalInput(value) ?? Number.NaN)
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= HOURS_MAX
  const dirty = Math.round(parsed * 100) / 100 !== stored
  const canEdit = editable && calendarHours !== null && !fromCalendar

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canEdit || !dirty) return
    if (!valid) {
      setError(t('total_hours_error_range', { max: HOURS_MAX }))
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/salary/runs/${runId}/employees/${employeeId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours_worked: Math.round(parsed * 100) / 100 }),
      })
      if (!res.ok) {
        const json = await res.json().catch(() => null)
        setError(getUserErrorMessage(json, { statusCode: res.status }))
        return
      }
      onSaved()
    } catch (err) {
      setError(err instanceof Error ? getUserErrorMessage(err) : t('unknown_error'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSave} className="mb-4 space-y-1.5">
      <label className="text-xs font-medium" htmlFor="payslip-total-hours">
        {t('total_hours_label')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id="payslip-total-hours"
          type="number"
          inputMode="decimal"
          min={0}
          max={HOURS_MAX}
          step="any"
          value={fromCalendar ? String(calendarHours) : value}
          onChange={(e) => setValue(e.target.value)}
          disabled={!canEdit || saving}
          className="w-32 tabular-nums"
          aria-describedby={fromCalendar ? 'payslip-total-hours-note' : undefined}
        />
        {canEdit && (
          <Button type="submit" size="sm" variant="outline" disabled={!dirty} loading={saving}>
            {t('total_hours_save')}
          </Button>
        )}
      </div>
      {fromCalendar && (
        <p id="payslip-total-hours-note" className="text-[12.5px] text-muted-foreground">
          {t('total_hours_from_calendar')}
        </p>
      )}
      {error && (
        <p className="text-[12.5px] text-destructive" role="alert">
          {error}
        </p>
      )}
    </form>
  )
}
