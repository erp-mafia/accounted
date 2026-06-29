'use client'

import { useState, useRef, useEffect } from 'react'
import { Deadline } from '@/types'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  isDeadlineOverdue,
  DEADLINE_TYPE_LABELS,
  parseDate,
  startOfDay,
} from '@/lib/calendar/utils'
import { Check, Pencil } from 'lucide-react'

interface DeadlineCardProps {
  deadline: Deadline
  onToggle: (deadline: Deadline) => void
  onEdit?: (deadline: Deadline) => void
  onDelete?: (deadline: Deadline) => void
  compact?: boolean
}

function getRelativeDate(dateStr: string): { text: string; urgent: boolean } | null {
  const today = startOfDay(new Date())
  const target = parseDate(dateStr)
  const diffMs = target.getTime() - today.getTime()
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) return { text: 'Idag', urgent: true }
  if (diffDays === 1) return { text: 'Imorgon', urgent: false }
  if (diffDays === -1) return { text: '1 dag sedan', urgent: true }
  if (diffDays < -1) return { text: `${Math.abs(diffDays)} dagar sedan`, urgent: true }
  if (diffDays <= 7) return { text: `Om ${diffDays} dagar`, urgent: false }
  if (diffDays <= 14) return { text: `Om ${diffDays} dagar`, urgent: false }
  return null
}

const SWEDISH_MONTHS_SHORT = [
  'jan', 'feb', 'mar', 'apr', 'maj', 'jun',
  'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
]

export function DeadlineCard({
  deadline,
  onToggle,
  onEdit,
  onDelete,
  compact = false,
}: DeadlineCardProps) {
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLDivElement>(null)
  const overdue = isDeadlineOverdue(deadline)
  const completed = deadline.is_completed
  const relative = getRelativeDate(deadline.due_date)
  const dueDate = parseDate(deadline.due_date)
  const dayNum = dueDate.getDate()
  const monthStr = SWEDISH_MONTHS_SHORT[dueDate.getMonth()]

  // Dismiss confirmation when clicking outside
  useEffect(() => {
    if (!confirming) return
    function handleClickOutside(e: MouseEvent) {
      if (confirmRef.current && !confirmRef.current.contains(e.target as Node)) {
        setConfirming(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [confirming])

  function handleToggleClick(e: React.MouseEvent) {
    e.stopPropagation()
    if (completed) {
      // Uncompleting doesn't need confirmation
      onToggle(deadline)
      return
    }
    setConfirming(true)
  }

  function handleConfirm(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(false)
    onToggle(deadline)
  }

  function handleCancel(e: React.MouseEvent) {
    e.stopPropagation()
    setConfirming(false)
  }

  function handleCardClick() {
    if (confirming) return
    if (onEdit) onEdit(deadline)
  }

  // -- Compact variant (used in dashboard widgets) --
  if (compact) {
    return (
      <div
        onClick={handleCardClick}
        className={cn(
          'group flex items-center gap-3 py-2.5 transition-colors',
          onEdit && !confirming && 'cursor-pointer hover:bg-accent/30 -mx-2 px-2 rounded-md',
          completed && 'opacity-50',
        )}
      >
        <span className="text-xs tabular-nums w-14 flex-shrink-0 text-muted-foreground">
          {dayNum} {monthStr}
        </span>

        <p className={cn(
          'text-sm truncate flex-1 min-w-0',
          completed ? 'line-through text-muted-foreground' : 'text-foreground',
        )}>
          {deadline.title}
        </p>

        {!completed && relative && (
          <span className={cn(
            'text-xs flex-shrink-0',
            relative.urgent ? 'text-destructive font-medium' : 'text-muted-foreground',
          )}>
            {relative.text}
          </span>
        )}

        {completed && (
          <Check className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
        )}
      </div>
    )
  }

  // -- Full card --
  return (
    <div ref={confirmRef}>
      <div
        onClick={handleCardClick}
        className={cn(
          'group rounded-lg border bg-card transition-all duration-150',
          onEdit && !confirming && 'cursor-pointer',
          confirming && 'ring-2 ring-ring ring-offset-1',
          completed
            ? 'opacity-50 hover:opacity-70'
            : !confirming && 'hover:bg-accent/40 active:bg-accent/60',
        )}
      >
        {/* Main row */}
        <div className="flex items-center gap-4 py-3 px-4">
          {/* Date block */}
          <div className="flex-shrink-0 w-12 text-center">
            <span className={cn(
              'block text-lg font-display leading-none tabular-nums',
              completed && 'text-muted-foreground',
            )}>
              {dayNum}
            </span>
            <span className="block text-[11px] uppercase tracking-wider text-muted-foreground mt-0.5">
              {monthStr}
            </span>
          </div>

          {/* Divider */}
          <div className="w-px h-8 bg-border flex-shrink-0" />

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2">
              <p className={cn(
                'text-sm font-medium truncate',
                completed && 'line-through text-muted-foreground',
              )}>
                {deadline.title}
              </p>
              {deadline.deadline_type !== 'other' && (
                <span className="text-[11px] text-muted-foreground/60 flex-shrink-0 hidden sm:inline">
                  {DEADLINE_TYPE_LABELS[deadline.deadline_type]}
                </span>
              )}
            </div>

            <div className="flex items-center gap-1.5 mt-0.5">
              {deadline.due_time && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  kl {deadline.due_time.slice(0, 5)}
                </span>
              )}
              {deadline.due_time && deadline.customer && (
                <span className="text-muted-foreground/30 text-xs">·</span>
              )}
              {deadline.customer && (
                <span className="text-xs text-muted-foreground truncate">
                  {deadline.customer.name}
                </span>
              )}
            </div>
          </div>

          {/* Right: relative date + action */}
          <div className="flex items-center gap-3 flex-shrink-0">
            {!completed && relative && (
              <span className={cn(
                'text-xs tabular-nums hidden sm:inline',
                relative.urgent ? 'text-destructive font-medium' : 'text-muted-foreground',
              )}>
                {relative.text}
              </span>
            )}

            {completed ? (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Check className="h-3.5 w-3.5" />
                Klar
              </span>
            ) : (
              <button
                onClick={handleToggleClick}
                className={cn(
                  'text-xs text-muted-foreground hover:text-foreground transition-colors px-2.5 py-1 rounded-md border border-border hover:border-foreground/30 hover:bg-accent',
                  confirming && 'invisible',
                )}
              >
                Markera klar
              </button>
            )}

            {/* Edit hint */}
            {onEdit && !confirming && (
              <Pencil className="h-3.5 w-3.5 text-muted-foreground/0 group-hover:text-muted-foreground/50 transition-colors flex-shrink-0" />
            )}
          </div>
        </div>

        {/* Inline confirmation bar */}
        <div
          className={cn(
            'grid transition-all duration-200 ease-out',
            confirming ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className="border-t px-4 py-3 flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                Markera <span className="font-medium text-foreground">{deadline.title}</span> som klar?
              </p>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={handleCancel}
                >
                  Avbryt
                </Button>
                <Button
                  size="sm"
                  className="h-8 px-3 text-xs"
                  onClick={handleConfirm}
                >
                  <Check className="h-3.5 w-3.5 mr-1.5" />
                  Bekräfta
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
