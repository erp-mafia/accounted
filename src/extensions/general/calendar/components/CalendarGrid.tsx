'use client'

import { Invoice, Deadline } from '@/types'
import { SWEDISH_DAYS, getMonthGrid } from '@/lib/calendar/utils'
import { CalendarDayCell } from './CalendarDayCell'

interface CalendarGridProps {
  year: number
  month: number
  invoices: Invoice[]
  deadlines: Deadline[]
  onDayClick: (date: Date) => void
}

export function CalendarGrid({
  year,
  month,
  invoices,
  deadlines,
  onDayClick,
}: CalendarGridProps) {
  const weeks = getMonthGrid(year, month)

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Day headers */}
      <div className="grid grid-cols-7 bg-muted">
        {SWEDISH_DAYS.map((day) => (
          <div
            key={day}
            className="py-2 text-center text-sm font-medium text-muted-foreground border-r last:border-r-0"
          >
            {day}
          </div>
        ))}
      </div>

      {/* Week rows */}
      {weeks.map((week, weekIndex) => (
        <div key={weekIndex} className="grid grid-cols-7">
          {week.map((date, dayIndex) => (
            <CalendarDayCell
              key={dayIndex}
              date={date}
              currentMonth={month}
              invoices={invoices}
              deadlines={deadlines}
              onDayClick={onDayClick}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
