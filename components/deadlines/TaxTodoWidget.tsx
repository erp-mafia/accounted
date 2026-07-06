'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Deadline, DeadlineStatus, TAX_DEADLINE_TYPE_LABELS, DEADLINE_STATUS_LABELS } from '@/types'
import { getReportUrl } from '@/lib/tax/deadline-config'

// Use the labels from types
const STATUS_LABELS = DEADLINE_STATUS_LABELS
import {
  FileText,
  ChevronRight,
  AlertTriangle,
  Clock,
  Send,
  Check,
  Loader2,
  ExternalLink,
} from 'lucide-react'

interface TaxTodoWidgetProps {
  deadlines: Deadline[]
  onStatusChange?: (deadlineId: string, newStatus: DeadlineStatus) => void
}

export function TaxTodoWidget({ deadlines, onStatusChange }: TaxTodoWidgetProps) {
  const { toast } = useToast()
  const t = useTranslations('tax_todo')
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Filter to only tax deadlines needing attention
  const taxDeadlines = deadlines.filter(
    (d) =>
      d.deadline_type === 'tax' &&
      !d.is_completed &&
      ['action_needed', 'overdue', 'in_progress'].includes(d.status)
  )

  // Sort by urgency: overdue first, then by date
  const sortedDeadlines = taxDeadlines.sort((a, b) => {
    if (a.status === 'overdue' && b.status !== 'overdue') return -1
    if (b.status === 'overdue' && a.status !== 'overdue') return 1
    return a.due_date.localeCompare(b.due_date)
  })

  const overdueCount = taxDeadlines.filter((d) => d.status === 'overdue').length
  const actionNeededCount = taxDeadlines.filter((d) => d.status === 'action_needed').length

  if (sortedDeadlines.length === 0) {
    return null
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const diffDays = Math.ceil(
      (date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    )

    if (diffDays === 0) return t('today')
    if (diffDays === 1) return t('tomorrow')
    if (diffDays < 0) return t('days_ago', { count: Math.abs(diffDays) })
    if (diffDays <= 7) return t('in_days', { count: diffDays })

    return date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
  }

  const handleStatusChange = async (deadlineId: string, newStatus: DeadlineStatus) => {
    setUpdatingId(deadlineId)

    try {
      const response = await fetch(`/api/deadlines/${deadlineId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to update status')
      }

      toast({
        title: t('toast_status_updated'),
        description: t('toast_status_updated_description', { status: STATUS_LABELS[newStatus].toLowerCase() }),
      })

      onStatusChange?.(deadlineId, newStatus)
    } catch (error) {
      toast({
        title: error instanceof Error ? error.message : t('toast_status_update_failed'),
        variant: 'destructive',
      })
    } finally {
      setUpdatingId(null)
    }
  }

  const getReportLink = (deadline: Deadline): string | null => {
    if (!deadline.linked_report_type || !deadline.linked_report_period) {
      return null
    }

    return getReportUrl(deadline.linked_report_type, deadline.linked_report_period)
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <FileText className="h-5 w-5 text-warning-foreground" />
            {t('title')}
          </CardTitle>
          <div className="flex gap-2">
            {overdueCount > 0 && (
              <Badge variant="destructive">{t('overdue_badge', { count: overdueCount })}</Badge>
            )}
            {actionNeededCount > 0 && (
              <Badge variant="warning">{t('action_needed_badge', { count: actionNeededCount })}</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedDeadlines.slice(0, 5).map((deadline) => {
          const isUpdating = updatingId === deadline.id
          const reportLink = getReportLink(deadline)
          const isOverdue = deadline.status === 'overdue'

          return (
            <div
              key={deadline.id}
              className={`p-3 rounded-lg ${isOverdue ? 'bg-destructive/5' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  {isOverdue ? (
                    <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  ) : (
                    <Clock className="h-4 w-4 text-warning-foreground flex-shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{deadline.title}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={`text-xs ${
                          isOverdue ? 'text-destructive font-medium' : 'text-muted-foreground'
                        }`}
                      >
                        {formatDate(deadline.due_date)}
                      </span>
                      {deadline.tax_deadline_type && (
                        <span className="text-xs text-muted-foreground">
                          · {TAX_DEADLINE_TYPE_LABELS[deadline.tax_deadline_type]}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 flex-shrink-0">
                  {/* Link to report if available */}
                  {reportLink && (
                    <Link href={reportLink}>
                      <Button variant="ghost" size="sm" className="h-9 px-2.5">
                        <ExternalLink className="h-3.5 w-3.5" />
                      </Button>
                    </Link>
                  )}

                  {/* Mark as in progress */}
                  {['action_needed', 'overdue'].includes(deadline.status) && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 px-3 text-xs"
                      disabled={isUpdating}
                      onClick={() => handleStatusChange(deadline.id, 'in_progress')}
                    >
                      {isUpdating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        t('start')
                      )}
                    </Button>
                  )}

                  {/* Mark as submitted */}
                  {deadline.status === 'in_progress' && (
                    <Button
                      variant="default"
                      size="sm"
                      className="h-9 px-3 text-xs gap-1"
                      disabled={isUpdating}
                      onClick={() => handleStatusChange(deadline.id, 'submitted')}
                    >
                      {isUpdating ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <>
                          <Send className="h-3.5 w-3.5" />
                          {t('submitted')}
                        </>
                      )}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )
        })}

        {sortedDeadlines.length > 5 && (
          <p className="text-xs text-muted-foreground text-center">
            {t('more_tasks', { count: sortedDeadlines.length - 5 })}
          </p>
        )}

        <Link href="/deadlines" className="block">
          <Button variant="ghost" className="w-full justify-between">
            {t('view_all')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
