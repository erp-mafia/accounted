'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CalendarViewMode } from '@/types'
import {
  SWEDISH_MONTHS,
  getWeekNumber,
  formatDayViewHeader,
} from '@/lib/calendar/utils'
import { ViewModeSelector } from './ViewModeSelector'

interface CalendarHeaderProps {
  year: number
  month: number
  currentDate?: Date
  viewMode?: CalendarViewMode
  onPrevious: () => void
  onNext: () => void
  onToday: () => void
  onViewModeChange?: (mode: CalendarViewMode) => void
}

export function CalendarHeader({
  year,
  month,
  currentDate,
  viewMode = 'month',
  onPrevious,
  onNext,
  onToday,
  onViewModeChange,
}: CalendarHeaderProps) {
  // Generate title based on view mode
  const getTitle = () => {
    switch (viewMode) {
      case 'week':
        if (currentDate) {
          const weekNum = getWeekNumber(currentDate)
          return `Vecka ${weekNum}, ${currentDate.getFullYear()}`
        }
        return `${SWEDISH_MONTHS[month]} ${year}`

      case 'day':
        if (currentDate) {
          return formatDayViewHeader(currentDate)
        }
        return `${SWEDISH_MONTHS[month]} ${year}`

      case 'month':
      default:
        return `${SWEDISH_MONTHS[month]} ${year}`
    }
  }

  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="icon" onClick={onPrevious}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="icon" onClick={onNext}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="outline" size="sm" onClick={onToday}>
          Idag
        </Button>
      </div>

      <h2 className="text-xl font-semibold capitalize">
        {getTitle()}
      </h2>

      {onViewModeChange && (
        <ViewModeSelector
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />
      )}

      {/* Spacer when no view mode selector */}
      {!onViewModeChange && <div />}
    </div>
  )
}
