'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { Deadline, DeadlineStatus } from '@/types'
import {
  getUpcomingDeadlines,
  STATUS_LABELS,
} from '@/lib/calendar/utils'
import { Calendar, ChevronRight, AlertTriangle, Clock, Check, Send, Loader2 } from 'lucide-react'

interface UpcomingDeadlinesWidgetProps {
  deadlines: Deadline[]
  maxItems?: number
  onStatusChange?: (deadlineId: string, newStatus: DeadlineStatus) => void
}

export function UpcomingDeadlinesWidget({ deadlines, maxItems = 5, onStatusChange }: UpcomingDeadlinesWidgetProps) {
  const { toast } = useToast()
  const t = useTranslations('upcoming_deadlines')
  const [updatingId, setUpdatingId] = useState<string | null>(null)

  // Get upcoming deadlines (next 7 days) + any needing attention
  const upcomingDeadlines = getUpcomingDeadlines(deadlines, 7)
  const actionNeededDeadlines = deadlines.filter(
    (d) => !d.is_completed && d.status === 'action_needed'
  )
  const overdueDeadlines = deadlines.filter(
    (d) => !d.is_completed && d.status === 'overdue'
  )

  // Combine and sort (overdue first, then action_needed, then upcoming)
  const displayDeadlines = [...overdueDeadlines, ...actionNeededDeadlines, ...upcomingDeadlines]
    .filter((d, i, arr) => arr.findIndex((x) => x.id === d.id) === i) // Remove duplicates
    .slice(0, maxItems)

  const overdueCount = overdueDeadlines.length
  const actionNeededCount = actionNeededDeadlines.length

  if (displayDeadlines.length === 0) {
    return null
  }

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr)
    const today = new Date()
    const tomorrow = new Date(today)
    tomorrow.setDate(tomorrow.getDate() + 1)

    if (date.toDateString() === today.toDateString()) {
      return t('today')
    }
    if (date.toDateString() === tomorrow.toDateString()) {
      return t('tomorrow')
    }
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

      // Notify parent component
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

  const getStatusBadgeVariant = (status: DeadlineStatus): 'default' | 'secondary' | 'destructive' | 'warning' => {
    switch (status) {
      case 'overdue': return 'destructive'
      case 'action_needed': return 'warning'
      case 'submitted':
      case 'confirmed': return 'default'
      default: return 'secondary'
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="h-5 w-5" />
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
      <CardContent className="space-y-2">
        {displayDeadlines.map((deadline) => {
          const isUpdating = updatingId === deadline.id

          return (
            <div
              key={deadline.id}
              className={`flex items-center justify-between p-2 rounded-lg ${
                deadline.status === 'overdue' ? 'bg-destructive/5' : ''
              }`}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {deadline.status === 'overdue' ? (
                  <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0" />
                ) : deadline.status === 'action_needed' ? (
                  <Clock className="h-4 w-4 text-warning-foreground flex-shrink-0" />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{deadline.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(deadline.due_date)}
                    {deadline.due_time && ` ${t('time_prefix')} ${deadline.due_time.slice(0, 5)}`}
                    {deadline.tax_deadline_type && (
                      <>
                        {' '}
                        <span className="text-muted-foreground/30">·</span> {t('tax_badge')}
                      </>
                    )}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Status badge */}
                <Badge variant={getStatusBadgeVariant(deadline.status)} className="text-xs">
                  {STATUS_LABELS[deadline.status]}
                </Badge>

                {/* Quick action buttons for tax deadlines */}
                {deadline.tax_deadline_type && !['submitted', 'confirmed'].includes(deadline.status) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2.5"
                    disabled={isUpdating}
                    onClick={() => handleStatusChange(deadline.id, 'submitted')}
                    title={t('mark_as_submitted')}
                  >
                    {isUpdating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Send className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}

                {deadline.status === 'submitted' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 px-2.5"
                    disabled={isUpdating}
                    onClick={() => handleStatusChange(deadline.id, 'confirmed')}
                    title={t('mark_as_confirmed')}
                  >
                    {isUpdating ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Check className="h-3.5 w-3.5" />
                    )}
                  </Button>
                )}
              </div>
            </div>
          )
        })}

        <Link href="/deadlines" className="block">
          <Button variant="ghost" className="w-full justify-between mt-2">
            {t('view_all')}
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
