'use client'

import { Invoice, Deadline } from '@/types'
import { cn } from '@/lib/utils'
import {
  getWeekDays,
  formatWeekDayHeader,
  formatDateISO,
  isSameDay,
  isInvoiceOverdue,
  isDeadlineOverdue,
  getTimeSlots,
} from '@/lib/calendar/utils'

interface CalendarWeekViewProps {
  currentDate: Date
  invoices: Invoice[]
  deadlines: Deadline[]
  onDayClick: (date: Date) => void
}

export function CalendarWeekView({
  currentDate,
  invoices,
  deadlines,
  onDayClick,
}: CalendarWeekViewProps) {
  const weekDays = getWeekDays(currentDate)
  const timeSlots = getTimeSlots(8, 20)
  const today = new Date()

  // Group invoices and deadlines by date for quick lookup
  const getItemsForDate = (date: Date) => {
    const dateStr = formatDateISO(date)
    const dayInvoices = invoices.filter(inv => inv.due_date === dateStr)
    const dayDeadlines = deadlines.filter(d => d.due_date === dateStr)
    return { invoices: dayInvoices, deadlines: dayDeadlines }
  }

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header row with day names and dates */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] bg-muted border-b">
        <div className="p-2 border-r" /> {/* Empty corner cell */}
        {weekDays.map((date, index) => {
          const isToday = isSameDay(date, today)
          return (
            <button
              key={index}
              onClick={() => onDayClick(date)}
              className={cn(
                'p-2 text-center border-r last:border-r-0 hover:bg-muted/80 transition-colors',
                isToday && 'bg-primary/10'
              )}
            >
              <div className={cn(
                'text-sm font-medium',
                isToday && 'text-primary font-bold'
              )}>
                {formatWeekDayHeader(date)}
              </div>
            </button>
          )
        })}
      </div>

      {/* All-day events section */}
      <div className="grid grid-cols-[60px_repeat(7,1fr)] border-b bg-muted/30">
        <div className="p-2 border-r text-xs text-muted-foreground">
          Heldag
        </div>
        {weekDays.map((date, index) => {
          const items = getItemsForDate(date)
          const isToday = isSameDay(date, today)

          // Filter to only show non-timed items (all invoices and deadlines without times are "all-day")
          const allDayInvoices = items.invoices.filter(inv =>
            inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'credited'
          )
          const allDayDeadlines = items.deadlines.filter(d => !d.is_completed)

          return (
            <div
              key={index}
              className={cn(
                'min-h-[60px] p-1 border-r last:border-r-0',
                isToday && 'bg-primary/5'
              )}
            >
              {/* Invoice indicators */}
              {allDayInvoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className={cn(
                    'text-xs p-1 mb-1 rounded-sm truncate',
                    isInvoiceOverdue(invoice)
                      ? 'bg-destructive/20 text-destructive'
                      : 'bg-primary/20 text-primary'
                  )}
                  title={`Faktura ${invoice.invoice_number} - ${invoice.customer?.name || ''}`}
                >
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-full bg-current flex-shrink-0" />
                    <span className="truncate">F#{invoice.invoice_number}</span>
                  </div>
                </div>
              ))}

              {/* Deadline indicators */}
              {allDayDeadlines.map((deadline) => (
                <div
                  key={deadline.id}
                  className={cn(
                    'text-xs p-1 mb-1 rounded-sm truncate',
                    isDeadlineOverdue(deadline)
                      ? 'bg-destructive/20 text-destructive'
                      : 'bg-warning/20 text-warning-foreground'
                  )}
                  title={deadline.title}
                >
                  <div className="flex items-center gap-1">
                    <div className="w-2 h-2 rounded-sm bg-current flex-shrink-0" />
                    <span className="truncate">{deadline.title}</span>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>

      {/* Time grid */}
      <div className="max-h-[500px] overflow-y-auto">
        {timeSlots.map((time, _timeIndex) => (
          <div key={time} className="grid grid-cols-[60px_repeat(7,1fr)] border-b last:border-b-0">
            <div className="p-2 border-r text-xs text-muted-foreground text-right pr-2">
              {time}
            </div>
            {weekDays.map((date, dayIndex) => {
              const isToday = isSameDay(date, today)
              return (
                <button
                  key={dayIndex}
                  onClick={() => onDayClick(date)}
                  className={cn(
                    'min-h-[40px] border-r last:border-r-0 hover:bg-muted/50 transition-colors',
                    isToday && 'bg-primary/5'
                  )}
                />
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
