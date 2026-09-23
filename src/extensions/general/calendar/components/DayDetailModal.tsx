'use client'

import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Invoice, Deadline } from '@/types'
import { formatCurrency } from '@/lib/utils'
import {
  isInvoiceOverdue,
  isDeadlineOverdue,
  formatDateISO,
  DEADLINE_TYPE_LABELS,
  PRIORITY_LABELS,
  PRIORITY_COLORS,
} from '@/lib/calendar/utils'
import { FileText, CheckCircle, Clock, AlertTriangle, Plus } from 'lucide-react'

interface DayDetailModalProps {
  date: Date | null
  invoices: Invoice[]
  deadlines: Deadline[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAddDeadline: (date: Date) => void
  onToggleDeadline: (deadline: Deadline) => void
}

export function DayDetailModal({
  date,
  invoices,
  deadlines,
  open,
  onOpenChange,
  onAddDeadline,
  onToggleDeadline,
}: DayDetailModalProps) {
  if (!date) return null

  const dateStr = formatDateISO(date)
  const dayInvoices = invoices.filter(inv => inv.due_date === dateStr)
  const dayDeadlines = deadlines.filter(d => d.due_date === dateStr)

  const formattedDate = date.toLocaleDateString('sv-SE', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="capitalize">{formattedDate}</DialogTitle>
        </DialogHeader>

        <div className="space-y-6">
          {/* Invoices section */}
          {dayInvoices.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-muted-foreground mb-2">
                Fakturor ({dayInvoices.length})
              </h3>
              <div className="space-y-2">
                {dayInvoices.map((invoice) => {
                  const overdue = isInvoiceOverdue(invoice)
                  const paid = invoice.status === 'paid'
                  return (
                    <Link
                      key={invoice.id}
                      href={`/invoices/${invoice.id}`}
                      className="block"
                    >
                      <div
                        className={`p-3 rounded-lg border transition-colors hover:bg-muted/50 ${
                          overdue ? 'border-destructive/50 bg-destructive/5' :
                          paid ? 'border-success/50 bg-success/5' :
                          'border-border'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-start gap-2">
                            {overdue ? (
                              <AlertTriangle className="h-4 w-4 text-destructive mt-0.5" />
                            ) : paid ? (
                              <CheckCircle className="h-4 w-4 text-success mt-0.5" />
                            ) : (
                              <FileText className="h-4 w-4 text-muted-foreground mt-0.5" />
                            )}
                            <div>
                              <p className="font-medium text-sm">
                                {invoice.invoice_number}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {(invoice.customer as { name: string })?.name || 'Okänd kund'}
                              </p>
                            </div>
                          </div>
                          <div className="text-right">
                            <p className="font-medium text-sm">
                              {formatCurrency(invoice.total, invoice.currency)}
                            </p>
                            <Badge
                              variant={
                                overdue ? 'destructive' :
                                paid ? 'success' :
                                'secondary'
                              }
                              className="text-xs"
                            >
                              {overdue ? 'Förfallen' : paid ? 'Betald' : 'Väntande'}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    </Link>
                  )
                })}
              </div>
            </div>
          )}

          {/* Deadlines section */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium text-muted-foreground">
                Deadlines ({dayDeadlines.length})
              </h3>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onAddDeadline(date)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Lägg till
              </Button>
            </div>

            {dayDeadlines.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                Inga deadlines denna dag
              </p>
            ) : (
              <div className="space-y-2">
                {dayDeadlines.map((deadline) => {
                  const overdue = isDeadlineOverdue(deadline)
                  const completed = deadline.is_completed
                  const priorityStyle = PRIORITY_COLORS[deadline.priority]

                  return (
                    <div
                      key={deadline.id}
                      className={`p-3 rounded-lg border transition-colors ${
                        overdue && !completed
                          ? 'border-destructive/50 bg-destructive/5'
                          : completed
                          ? 'border-success/50 bg-success/5'
                          : `${priorityStyle.border} ${priorityStyle.bg}`
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => onToggleDeadline(deadline)}
                            className="mt-0.5"
                          >
                            {completed ? (
                              <CheckCircle className="h-4 w-4 text-success" />
                            ) : overdue ? (
                              <AlertTriangle className="h-4 w-4 text-destructive" />
                            ) : (
                              <Clock className="h-4 w-4 text-muted-foreground" />
                            )}
                          </button>
                          <div>
                            <p className={`font-medium text-sm ${completed ? 'line-through text-muted-foreground' : ''}`}>
                              {deadline.title}
                            </p>
                            {deadline.due_time && (
                              <p className="text-xs text-muted-foreground">
                                kl. {deadline.due_time.slice(0, 5)}
                              </p>
                            )}
                            {deadline.customer && (
                              <p className="text-xs text-muted-foreground">
                                {deadline.customer.name}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1">
                          <Badge variant="outline" className="text-xs">
                            {DEADLINE_TYPE_LABELS[deadline.deadline_type]}
                          </Badge>
                          {!completed && deadline.priority !== 'normal' && (
                            <Badge
                              variant={deadline.priority === 'critical' ? 'destructive' : 'warning'}
                              className="text-xs"
                            >
                              {PRIORITY_LABELS[deadline.priority]}
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Empty state */}
          {dayInvoices.length === 0 && dayDeadlines.length === 0 && (
            <div className="text-center py-6">
              <Clock className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                Inga händelser denna dag
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => onAddDeadline(date)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Lägg till deadline
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
