'use client'

import { cn } from '@/lib/utils'
import { Invoice, Deadline } from '@/types'
import { isInvoiceOverdue, isSameDay, formatDateISO, STATUS_COLORS } from '@/lib/calendar/utils'

interface CalendarDayCellProps {
  date: Date
  currentMonth: number
  invoices: Invoice[]
  deadlines: Deadline[]
  onDayClick: (date: Date) => void
}

export function CalendarDayCell({
  date,
  currentMonth,
  invoices,
  deadlines,
  onDayClick,
}: CalendarDayCellProps) {
  const dateStr = formatDateISO(date)
  const isCurrentMonth = date.getMonth() === currentMonth
  const isToday = isSameDay(date, new Date())

  // Filter invoices and deadlines for this day
  const dayInvoices = invoices.filter(inv => inv.due_date === dateStr)
  const dayDeadlines = deadlines.filter(d => d.due_date === dateStr)

  // Count invoices by status
  const overdueInvoices = dayInvoices.filter(isInvoiceOverdue)
  const paidInvoices = dayInvoices.filter(inv => inv.status === 'paid')
  const pendingInvoices = dayInvoices.filter(
    inv => inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'credited' && !isInvoiceOverdue(inv)
  )

  // Group deadlines by status
  const deadlinesByStatus = dayDeadlines.reduce((acc, d) => {
    if (d.is_completed) {
      acc.completed = (acc.completed || 0) + 1
    } else if (d.status) {
      acc[d.status] = (acc[d.status] || 0) + 1
    }
    return acc
  }, {} as Record<string, number>)

  const hasItems = dayInvoices.length > 0 || dayDeadlines.length > 0
  const hasOverdue = overdueInvoices.length > 0 || deadlinesByStatus.overdue > 0
  const hasActionNeeded = deadlinesByStatus.action_needed > 0

  return (
    <button
      onClick={() => onDayClick(date)}
      className={cn(
        'min-h-[80px] p-1 border-b border-r text-left transition-colors',
        'hover:bg-muted/50 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-inset',
        !isCurrentMonth && 'bg-muted/30 text-muted-foreground',
        isToday && 'bg-primary/5',
        hasOverdue && 'border-l-2 border-l-destructive',
        !hasOverdue && hasActionNeeded && 'border-l-2 border-l-warning'
      )}
    >
      <div className={cn(
        'text-sm font-medium mb-1',
        isToday && 'text-primary font-bold'
      )}>
        {date.getDate()}
      </div>

      {hasItems && (
        <div className="space-y-0.5">
          {/* Overdue invoices */}
          {overdueInvoices.length > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-destructive" />
              <span className="text-xs text-destructive truncate">
                {overdueInvoices.length} förfallen
              </span>
            </div>
          )}

          {/* Pending invoices */}
          {pendingInvoices.length > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-primary" />
              <span className="text-xs text-muted-foreground truncate">
                {pendingInvoices.length} faktura
              </span>
            </div>
          )}

          {/* Paid invoices */}
          {paidInvoices.length > 0 && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full bg-success" />
              <span className="text-xs text-muted-foreground truncate">
                {paidInvoices.length} betald
              </span>
            </div>
          )}

          {/* Overdue deadlines */}
          {deadlinesByStatus.overdue > 0 && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.overdue.dot)} />
              <span className="text-xs text-destructive truncate">
                {deadlinesByStatus.overdue} försenad
              </span>
            </div>
          )}

          {/* Action needed deadlines */}
          {deadlinesByStatus.action_needed > 0 && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.action_needed.dot)} />
              <span className="text-xs text-warning-foreground truncate">
                {deadlinesByStatus.action_needed} åtgärd
              </span>
            </div>
          )}

          {/* Upcoming deadlines */}
          {deadlinesByStatus.upcoming > 0 && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.upcoming.dot)} />
              <span className="text-xs text-muted-foreground truncate">
                {deadlinesByStatus.upcoming} deadline
              </span>
            </div>
          )}

          {/* In progress deadlines */}
          {deadlinesByStatus.in_progress > 0 && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.in_progress.dot)} />
              <span className="text-xs text-yellow-700 truncate">
                {deadlinesByStatus.in_progress} pågår
              </span>
            </div>
          )}

          {/* Submitted deadlines */}
          {deadlinesByStatus.submitted > 0 && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.submitted.dot)} />
              <span className="text-xs text-purple-700 truncate">
                {deadlinesByStatus.submitted} inskickad
              </span>
            </div>
          )}

          {/* Completed/Confirmed deadlines */}
          {(deadlinesByStatus.completed > 0 || deadlinesByStatus.confirmed > 0) && (
            <div className="flex items-center gap-1">
              <div className={cn('w-2 h-2 rounded-sm', STATUS_COLORS.confirmed.dot)} />
              <span className="text-xs text-muted-foreground truncate">
                {(deadlinesByStatus.completed || 0) + (deadlinesByStatus.confirmed || 0)} klar
              </span>
            </div>
          )}
        </div>
      )}
    </button>
  )
}
