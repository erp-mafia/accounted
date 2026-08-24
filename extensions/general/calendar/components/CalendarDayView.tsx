'use client'

import { Invoice, Deadline } from '@/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import {
  formatDateISO,
  isSameDay,
  isInvoiceOverdue,
  isDeadlineOverdue,
  getTimeSlots,
  formatDayViewHeader,
  DEADLINE_TYPE_LABELS,
  PRIORITY_LABELS,
} from '@/lib/calendar/utils'

interface CalendarDayViewProps {
  date: Date
  invoices: Invoice[]
  deadlines: Deadline[]
  onAddDeadline: (date: Date) => void
}

// Per-invoice amount label. Shows the SEK conversion when one exists;
// otherwise the invoice's own amount in its own currency: total_sek is NULL
// for non-SEK invoices whose rate fetch failed, and labelling the raw foreign
// amount "kr" would misstate it.
function invoiceAmountLabel(invoice: Invoice): string {
  if (invoice.total_sek != null || !invoice.currency || invoice.currency === 'SEK') {
    return `${(invoice.total_sek ?? invoice.total).toLocaleString('sv-SE')} kr`
  }
  return `${invoice.total.toLocaleString('sv-SE')} ${invoice.currency}`
}

export function CalendarDayView({
  date,
  invoices,
  deadlines,
  onAddDeadline,
}: CalendarDayViewProps) {
  const timeSlots = getTimeSlots(8, 20)
  const today = new Date()
  const isToday = isSameDay(date, today)
  const dateStr = formatDateISO(date)

  // Filter items for this day
  const dayInvoices = invoices.filter(inv => inv.due_date === dateStr)
  const dayDeadlines = deadlines.filter(d => d.due_date === dateStr)

  // Categorize items
  const activeInvoices = dayInvoices.filter(inv =>
    inv.status !== 'paid' && inv.status !== 'cancelled' && inv.status !== 'credited'
  )
  const paidInvoices = dayInvoices.filter(inv => inv.status === 'paid')
  const activeDeadlines = dayDeadlines.filter(d => !d.is_completed)
  const completedDeadlines = dayDeadlines.filter(d => d.is_completed)

  return (
    <div className="border rounded-lg overflow-hidden">
      {/* Header */}
      <div className={cn(
        'p-4 border-b flex items-center justify-between',
        isToday && 'bg-primary/10'
      )}>
        <h3 className={cn(
          'text-lg font-semibold capitalize',
          isToday && 'text-primary'
        )}>
          {formatDayViewHeader(date)}
          {isToday && <span className="ml-2 text-sm font-normal text-muted-foreground">(Idag)</span>}
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => onAddDeadline(date)}
        >
          <Plus className="h-4 w-4 mr-1" />
          Lägg till deadline
        </Button>
      </div>

      {/* All-day events section */}
      <div className="border-b">
        <div className="p-2 bg-muted/30">
          <div className="text-xs font-medium text-muted-foreground mb-2">Hela dagen</div>

          {/* Active invoices */}
          {activeInvoices.length > 0 && (
            <div className="space-y-1 mb-2">
              {activeInvoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className={cn(
                    'p-2 rounded-lg',
                    isInvoiceOverdue(invoice)
                      ? 'bg-destructive/10 border border-destructive/30'
                      : 'bg-primary/10 border border-primary/30'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-3 h-3 rounded-full flex-shrink-0',
                      isInvoiceOverdue(invoice) ? 'bg-destructive' : 'bg-primary'
                    )} />
                    <div className="flex-1 min-w-0">
                      <div className={cn(
                        'text-sm font-medium',
                        isInvoiceOverdue(invoice) ? 'text-destructive' : 'text-primary'
                      )}>
                        Faktura {invoice.invoice_number}
                        {isInvoiceOverdue(invoice) && (
                          <span className="ml-2 text-xs bg-destructive/20 px-1.5 py-0.5 rounded-sm">
                            Förfallen
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {invoice.customer?.name} • {invoiceAmountLabel(invoice)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Paid invoices */}
          {paidInvoices.length > 0 && (
            <div className="space-y-1 mb-2">
              {paidInvoices.map((invoice) => (
                <div
                  key={invoice.id}
                  className="p-2 rounded-lg bg-success/10 border border-success/30"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full bg-success flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-success">
                        Faktura {invoice.invoice_number}
                        <span className="ml-2 text-xs bg-success/20 px-1.5 py-0.5 rounded-sm">
                          Betald
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {invoice.customer?.name} • {invoiceAmountLabel(invoice)}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Active deadlines */}
          {activeDeadlines.length > 0 && (
            <div className="space-y-1 mb-2">
              {activeDeadlines.map((deadline) => (
                <div
                  key={deadline.id}
                  className={cn(
                    'p-2 rounded-lg',
                    isDeadlineOverdue(deadline)
                      ? 'bg-destructive/10 border border-destructive/30'
                      : 'bg-warning/10 border border-warning/30'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div className={cn(
                      'w-3 h-3 rounded-sm flex-shrink-0',
                      isDeadlineOverdue(deadline) ? 'bg-destructive' : 'bg-warning'
                    )} />
                    <div className="flex-1 min-w-0">
                      <div className={cn(
                        'text-sm font-medium',
                        isDeadlineOverdue(deadline) ? 'text-destructive' : 'text-warning-foreground'
                      )}>
                        {deadline.title}
                        {isDeadlineOverdue(deadline) && (
                          <span className="ml-2 text-xs bg-destructive/20 px-1.5 py-0.5 rounded-sm">
                            Försenad
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {DEADLINE_TYPE_LABELS[deadline.deadline_type] || deadline.deadline_type}
                        {deadline.priority !== 'normal' && (
                          <span className={cn(
                            'ml-2 px-1.5 py-0.5 rounded-sm',
                            deadline.priority === 'critical' && 'bg-destructive/10 text-destructive',
                            deadline.priority === 'important' && 'bg-warning/10 text-warning-foreground'
                          )}>
                            {PRIORITY_LABELS[deadline.priority]}
                          </span>
                        )}
                        {deadline.customer?.name && ` • ${deadline.customer.name}`}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Completed deadlines */}
          {completedDeadlines.length > 0 && (
            <div className="space-y-1">
              {completedDeadlines.map((deadline) => (
                <div
                  key={deadline.id}
                  className="p-2 rounded-lg bg-success/10 border border-success/30 opacity-60"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-sm bg-success flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-success line-through">
                        {deadline.title}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {DEADLINE_TYPE_LABELS[deadline.deadline_type] || deadline.deadline_type}
                        <span className="ml-2 bg-success/20 px-1.5 py-0.5 rounded-sm">Klar</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {dayInvoices.length === 0 && dayDeadlines.length === 0 && (
            <div className="text-sm text-muted-foreground py-4 text-center">
              Inga händelser för denna dag
            </div>
          )}
        </div>
      </div>

      {/* Time grid */}
      <div className="max-h-[400px] overflow-y-auto">
        {timeSlots.map((time) => (
          <button
            key={time}
            onClick={() => onAddDeadline(date)}
            className="w-full flex border-b last:border-b-0 hover:bg-muted/50 transition-colors"
          >
            <div className="w-16 p-2 border-r text-xs text-muted-foreground text-right pr-2 flex-shrink-0">
              {time}
            </div>
            <div className="flex-1 min-h-[40px]" />
          </button>
        ))}
      </div>
    </div>
  )
}
